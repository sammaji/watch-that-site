package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sammaji/watchthatsite/packages/cloudflare_go/r2"
	"github.com/sammaji/watchthatsite/services/core/config"
	"github.com/sammaji/watchthatsite/services/core/utils"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/admin"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/agentclient"
	worker "github.com/sammaji/watchthatsite/services/scheduler/internal/artifact_worker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/broker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/cache"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/monitor_due_jobs"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/notify"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/objects"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/pipeline"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/retention"
)

const brokerCloseTimeout = 10 * time.Second

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: utils.GetLogLevel(),
	}))

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	cfg, err := config.Load()
	if err != nil {
		log.Error("config load failed", "err", err)
		os.Exit(1)
	}

	// Every evaluation holds a connection while it waits for the agent, so
	// the pool has to know how many run at once.
	resultWorkers := utils.GetEnvInt("SCHEDULER_RESULT_WORKERS", 10)

	pool, err := db.NewPool(ctx, cfg.DatabaseURL, resultWorkers)
	if err != nil {
		log.Error("database connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	// Object storage is required: every Capture's blocks and every Change
	// Record live there.
	r2Store, err := r2.NewStoreFromEnv(ctx)
	if err != nil {
		log.Error("object storage is not configured", "err", err)
		os.Exit(1)
	}
	objectStore := objects.FromR2(r2Store)

	store := db.NewStore(pool)
	listener := db.NewListener(cfg, pool, log)

	// One publisher connection carries scrape jobs and every notification
	// channel. The scrape-result consumer opens its own connection separately.
	addresses := []broker.Address{
		{Exchange: monitor_due_jobs.ScrapeJobExchange, RoutingKey: monitor_due_jobs.ScrapeJobRoutingKey},
	}
	for _, rk := range notify.RoutingKeys() {
		addresses = append(addresses, broker.Address{Exchange: notify.NotificationExchange, RoutingKey: rk})
	}

	publisher, err := broker.NewClient(ctx, cfg.RabbitMQURL, addresses, log)
	if err != nil {
		log.Error("failed to connect to RabbitMQ", "err", err)
		os.Exit(1)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), brokerCloseTimeout)
		defer cancel()
		if err := publisher.Close(closeCtx); err != nil {
			log.Error("error closing RabbitMQ publisher", "err", err)
		}
	}()

	configCache := cache.NewNotificationConfigCache(
		int64(utils.GetEnvInt("SCHEDULER_NOTIFICATION_CACHE_MAX_BYTES", 0)),
		store.GetNotificationConfigs,
		listener,
		log,
	)
	go func() {
		if err := configCache.Sync(ctx); err != nil {
			log.Error("notification_config cache sync stopped", "err", err)
		}
	}()

	notifier := notify.NewNotifier(configCache, publisher, log)

	// The agent lives in the browser worker, next to the browser and the
	// model keys. The scheduler only calls its API.
	agent := agentclient.New(agentclient.Options{
		BaseURL: utils.GetEnv("AGENT_URL", "http://127.0.0.1:5220"),
		Token:   os.Getenv("AGENT_TOKEN"),
	})
	if os.Getenv("AGENT_TOKEN") == "" {
		log.Warn("AGENT_TOKEN not set; the agent API will refuse the scheduler and every difference will be sent as it is")
	}

	p := pipeline.New(pipeline.Options{
		Store:         store,
		Objects:       objectStore,
		Agent:         agent,
		Notifier:      notifier,
		Publisher:     publisher,
		JobRoutingKey: monitor_due_jobs.ScrapeJobRoutingKey,
		EnvVersion:    utils.GetEnv("ENV_VERSION", pipeline.DefaultEnvVersion),
		WebURL:        utils.Coalesce(os.Getenv("WEB_URL"), os.Getenv("NEXT_PUBLIC_APP_URL"), "http://localhost:3000"),
		Logger:        log,
	})

	retentionJob := &retention.Job{
		Store:   store,
		Objects: objectStore,
		Days:    utils.GetEnvInt("RETENTION_DAYS", retention.DefaultDays),
		Logger:  log,
	}

	consumer := worker.NewArtifactConsumer(worker.ArtifactConsumerOptions{
		Processor: p,
		Workers:   resultWorkers,
		Logger:    log,
	})
	go func() {
		if err := consumer.Run(ctx, cfg.RabbitMQURL); err != nil {
			log.Error("scrape result consumer stopped", "err", err)
		}
	}()

	if token := os.Getenv("SCHEDULER_ADMIN_TOKEN"); token != "" {
		server := admin.New(admin.Options{
			Addr:          utils.GetEnv("SCHEDULER_ADMIN_ADDR", ":5210"),
			Token:         token,
			Store:         store,
			Pipeline:      p,
			Publisher:     publisher,
			JobRoutingKey: monitor_due_jobs.ScrapeJobRoutingKey,
			Retention:     retentionJob,
			Logger:        log,
		})
		go func() {
			if err := server.Run(ctx); err != nil {
				log.Error("admin server stopped", "err", err)
			}
		}()
	} else {
		log.Warn("SCHEDULER_ADMIN_TOKEN not set; the admin API (Run now, plan again, compare) is disabled")
	}

	dispatcher := monitor_due_jobs.New(store, publisher, log,
		utils.GetEnvInt("SCHEDULER_MAX_CONCURRENT_TICKS", 2),
		p.EnvVersion(),
		digestJob(p, log),
		retentionTick(retentionJob, log),
		staleRunReaper(store, log),
	)
	dispatcher.Run(ctx)

	log.Info("scheduler exited cleanly")
}

// digestJob sends the hourly digest at :00 and the daily one at 08:00 UTC.
func digestJob(p *pipeline.Pipeline, log *slog.Logger) monitor_due_jobs.Periodic {
	return func(ctx context.Context, t time.Time) {
		if t.Minute() != 0 {
			return
		}
		buckets := []string{monitor.UrgencyHourly}
		if t.Hour() == 8 {
			buckets = append(buckets, monitor.UrgencyDaily)
		}
		for _, b := range buckets {
			res, err := p.RunDigests(ctx, b)
			if err != nil {
				log.Error("digest failed", "bucket", b, "err", err)
				continue
			}
			log.Info("digest sent", "bucket", b, "owners", res.Owners, "changes", res.Changes, "failed", res.Failed)
		}
	}
}

// staleRunTimeout is how long a Run may stay processing before it is failed.
// The browser worker bounds one Capture at a few minutes (longer when a Macro
// has to be repaired), and evaluating it can take two agent calls of up to
// 150 s each, so this leaves ample room for queueing.
const staleRunTimeout = 15 * time.Minute

// staleRunReaper fails Runs whose Capture never arrived, every tick.
func staleRunReaper(store *db.PgxStore, log *slog.Logger) monitor_due_jobs.Periodic {
	return func(ctx context.Context, t time.Time) {
		n, err := store.FailStaleRuns(ctx, t.Add(-staleRunTimeout))
		if err != nil {
			log.Error("failed to reap stale runs", "err", err)
			return
		}
		if n > 0 {
			log.Warn("failed runs that never received a capture", "count", n, "timeout", staleRunTimeout)
		}
	}
}

// retentionTick runs retention once a day at 03:00 UTC.
func retentionTick(job *retention.Job, log *slog.Logger) monitor_due_jobs.Periodic {
	return func(ctx context.Context, t time.Time) {
		if t.Hour() != 3 || t.Minute() != 0 {
			return
		}
		if _, err := job.Run(ctx); err != nil {
			log.Error("retention failed", "err", err)
		}
	}
}
