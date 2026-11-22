package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	rmq "github.com/rabbitmq/rabbitmq-amqp-go-client/pkg/rabbitmqamqp"
	"github.com/sammaji/watchthatsite/services/core/config"
	"github.com/sammaji/watchthatsite/services/core/utils"
	"github.com/sammaji/watchthatsite/services/notifications/internal/consumer"
	"github.com/sammaji/watchthatsite/services/notifications/internal/handler"
)

// brokerCloseTimeout bounds how long the RabbitMQ connection teardown may take
// during shutdown.
const brokerCloseTimeout = 10 * time.Second

// connectWithRetry attempts to establish a connection to a RabbitMQ broker at the specified URL.
// It uses an exponential backoff strategy, starting at 1 second and doubling up to a maximum
// of 30 seconds, capping the total number of connection attempts at 10.
func connectWithRetry(ctx context.Context, url string, log *slog.Logger) (*rmq.Environment, *rmq.AmqpConnection, error) {
	env := rmq.NewEnvironment(url, nil)

	backoff := time.Second
	const maxBackoff = 30 * time.Second
	const maxAttempts = 10

	for i := range maxAttempts {
		conn, err := env.NewConnection(ctx)
		if err == nil {
			log.Info("connected to rabbitmq", "attempt", i+1)
			return env, conn, nil
		}
		log.Warn("rabbitmq not ready, retrying", "attempt", i+1, "backoff", backoff, "err", err)
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
	return nil, nil, fmt.Errorf("could not connect to rabbitmq after %d attempts", maxAttempts)
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: utils.GetLogLevel(),
		// AddSource: true,
	}))

	cfg, err := config.Load()
	if err != nil {
		log.Error("config load failed", "err", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	env, conn, err := connectWithRetry(ctx, cfg.RabbitMQURL, log)
	if err != nil {
		log.Error("rabbitmq connect failed", "err", err)
		os.Exit(1)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), brokerCloseTimeout)
		defer cancel()
		if err := env.CloseConnections(closeCtx); err != nil {
			log.Error("error closing rabbitmq connection", "err", err)
		}
	}()

	mapping := []consumer.QueueHandlerMap{
		{
			Queue:   consumer.QueueConfig{Name: handler.ChannelEmail, WorkerCount: utils.GetEnvInt("NOTIFICATION_SERVICE_EMAIL_WORKER_COUNT", 5)},
			Handler: handler.NewEmailHandler(cfg),
		},
		{
			Queue:   consumer.QueueConfig{Name: handler.ChannelSlack, WorkerCount: utils.GetEnvInt("NOTIFICATION_SERVICE_SLACK_WORKER_COUNT", 2)},
			Handler: handler.NewSlackHandler(cfg),
		},
		{
			Queue:   consumer.QueueConfig{Name: handler.ChannelDiscord, WorkerCount: utils.GetEnvInt("NOTIFICATION_SERVICE_DISCORD_WORKER_COUNT", 2)},
			Handler: handler.NewDiscordHandler(cfg),
		},
		{
			Queue:   consumer.QueueConfig{Name: handler.ChannelTelegram, WorkerCount: utils.GetEnvInt("NOTIFICATION_SERVICE_TELEGRAM_WORKER_COUNT", 3)},
			Handler: handler.NewTelegramHandler(cfg),
		},
		{
			Queue:   consumer.QueueConfig{Name: handler.ChannelWebhook, WorkerCount: utils.GetEnvInt("NOTIFICATION_SERVICE_WEBHOOK_WORKER_COUNT", 3)},
			Handler: handler.NewWebhookHandler(cfg),
		},
	}

	if hosts := handler.LoadInsecureHosts(); len(hosts) > 0 {
		log.Warn("insecure webhook hosts allowed; never set this outside local testing",
			"env", handler.EnvInsecureWebhookHosts, "hosts", os.Getenv(handler.EnvInsecureWebhookHosts))
	}
	if t := os.Getenv("EMAIL_TRANSPORT"); t == handler.EmailTransportCapture {
		log.Warn("email capture transport enabled; emails are posted to EMAIL_CAPTURE_URL, not sent",
			"capture_url", os.Getenv("EMAIL_CAPTURE_URL"))
	}

	router := consumer.NewRouter(conn, mapping, log)

	log.Info("notification service started")

	if err := router.Run(ctx); err != nil {
		log.Error("router exited with error", "err", err)
		os.Exit(1)
	}

	log.Info("notification service stopped")
}
