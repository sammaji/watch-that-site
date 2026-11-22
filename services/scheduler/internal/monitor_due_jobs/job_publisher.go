// Package monitor_due_jobs runs the minute-tick loop that fans due Monitors
// out to the browser worker and fires the periodic jobs (digests, retention).
package monitor_due_jobs

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/broker"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
)

const (
	ScrapeJobExchange   = "monitor_runs"
	ScrapeJobRoutingKey = "monitor_scrape_job"
)

const (
	tickTimeout          = 50 * time.Second
	maxConcurrentPublish = 10
)

// RunScheduler is the part of db.Store the dispatcher needs.
type RunScheduler interface {
	ScheduleDueRuns(ctx context.Context, epochMinutes int, now time.Time, envVersion string) ([]db.ScrapeJob, error)
	MarkRunFailed(ctx context.Context, runID string, runErr db.RunError) error
}

// Periodic is called once per tick with the tick's wall-clock time, for jobs
// that run on a schedule (digests at :00, retention once a day).
type Periodic func(ctx context.Context, t time.Time)

// Dispatcher queries due monitors each minute and publishes a scrape job per run.
type Dispatcher struct {
	store      RunScheduler
	publisher  broker.Publisher
	logger     *slog.Logger
	envVersion string
	periodic   []Periodic

	tickSem chan struct{}
	wg      sync.WaitGroup
}

// New builds a Dispatcher. maxConcurrentTicks bounds overlapping tick
// goroutines; envVersion is stamped on every scrape job.
func New(store RunScheduler, publisher broker.Publisher, logger *slog.Logger, maxConcurrentTicks int, envVersion string, periodic ...Periodic) *Dispatcher {
	if maxConcurrentTicks < 1 {
		maxConcurrentTicks = 1
	}
	return &Dispatcher{
		store:      store,
		publisher:  publisher,
		logger:     logger,
		envVersion: envVersion,
		periodic:   periodic,
		tickSem:    make(chan struct{}, maxConcurrentTicks),
	}
}

// Run starts the minute-tick scheduling loop, aligned to the next full-minute
// wall-clock boundary. It blocks until ctx is cancelled, then waits for
// in-flight ticks to finish.
func (d *Dispatcher) Run(ctx context.Context) {
	next := time.Now().Truncate(time.Minute).Add(time.Minute)
	waitDuration := time.Until(next)
	d.logger.Info("waiting for next minute boundary", "wait_duration", waitDuration.Round(time.Second))

	select {
	case <-ctx.Done():
		return
	case <-time.After(waitDuration):
	}

	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	d.logger.Info("tick loop started")

	for {
		select {
		case <-ctx.Done():
			d.logger.Info("shutting down, waiting for in-flight ticks")
			d.wg.Wait()
			return

		case t := <-ticker.C:
			epochMinutes := int(t.Unix() / 60)
			select {
			case d.tickSem <- struct{}{}:
			default:
				d.logger.Warn("max concurrent ticks reached, skipping", "epoch_minutes", epochMinutes)
				continue
			}

			d.wg.Add(1)
			go func() {
				defer func() { <-d.tickSem; d.wg.Done() }()
				d.handler(ctx, epochMinutes, t.UTC())
			}()
		}
	}
}

// handler schedules the runs due at epochMinutes and publishes their scrape
// jobs concurrently. A publish failure marks the associated run failed so it is
// never left orphaned in 'processing'.
func (d *Dispatcher) handler(ctx context.Context, epochMinutes int, now time.Time) {
	start := time.Now()
	tickCtx, cancel := context.WithTimeout(ctx, tickTimeout)
	defer cancel()

	for _, job := range d.periodic {
		go job(context.WithoutCancel(ctx), now)
	}

	jobs, err := d.store.ScheduleDueRuns(tickCtx, epochMinutes, now, d.envVersion)
	if err != nil {
		d.logger.Error("failed to schedule due runs", "err", err)
		return
	}
	if len(jobs) == 0 {
		d.logger.Info("no monitors to schedule", "epoch_minutes", epochMinutes)
		return
	}

	d.logger.Info("firing monitors", "epoch_minutes", epochMinutes, "count", len(jobs))

	sem := make(chan struct{}, maxConcurrentPublish)
	var wg sync.WaitGroup

loop:
	for _, job := range jobs {
		select {
		case <-tickCtx.Done():
			d.logger.Warn("tick context expired, aborting remaining publishes")
			break loop
		case sem <- struct{}{}:
		}

		wg.Add(1)
		go func(j db.ScrapeJob) {
			defer func() { <-sem; wg.Done() }()
			if err := d.publisher.Publish(tickCtx, ScrapeJobRoutingKey, j); err != nil {
				// Prevent an orphaned 'processing' run.
				if markErr := d.store.MarkRunFailed(ctx, j.RunID, db.RunError{Code: "publish_failed", Message: err.Error()}); markErr != nil {
					d.logger.Error("failed to mark run failed after publish error",
						"run_id", j.RunID, "publish_err", err, "mark_err", markErr)
				}
			}
		}(job)
	}

	wg.Wait()
	d.logger.Info("completed scheduled jobs publishing cycle", "jobs_scheduled", len(jobs), "elapsed", time.Since(start))
}
