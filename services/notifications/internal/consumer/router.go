package consumer

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	rmq "github.com/rabbitmq/rabbitmq-amqp-go-client/pkg/rabbitmqamqp"

	"github.com/sammaji/watchthatsite/services/notifications/internal/handler"
)

// QueueHandlerMap pairs each queue with its handler and worker count.
type QueueHandlerMap struct {
	Queue   QueueConfig
	Handler handler.Handler
}

// Router manages all consumers. It reconnects on AMQP receiver link errors.
type Router struct {
	conn    *rmq.AmqpConnection
	mapping []QueueHandlerMap
	logger  *slog.Logger
}

func NewRouter(conn *rmq.AmqpConnection, mapping []QueueHandlerMap, logger *slog.Logger) *Router {
	return &Router{conn: conn, mapping: mapping, logger: logger}
}

// Run starts all consumers and blocks until ctx is cancelled.
// If an individual consumer's receiver link dies (e.g. connection blip) it is
// restarted after a short backoff. The whole Router exits only on ctx cancel
// or a fatal connection-level error.
func (r *Router) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	errCh := make(chan error, len(r.mapping))

	for _, m := range r.mapping {
		wg.Add(1)
		go func(m QueueHandlerMap) {
			defer wg.Done()
			if err := r.runWithRestart(ctx, m); err != nil {
				errCh <- err
			}
		}(m)
	}

	wg.Wait()
	close(errCh)

	// Return first fatal error, if any.
	for err := range errCh {
		if err != nil {
			return err
		}
	}
	return nil
}

// runWithRestart retries a consumer if its receiver link closes unexpectedly.
func (r *Router) runWithRestart(ctx context.Context, m QueueHandlerMap) error {
	backoff := time.Second
	const maxBackoff = 30 * time.Second

	for {
		// The client recovers the underlying connection on its own; if opening
		// the consumer still fails the error is connection-level — fatal.
		c, err := New(ctx, r.conn, m.Queue, m.Handler, r.logger)
		if err != nil {
			return fmt.Errorf("create consumer for %s: %w", m.Queue.Name, err)
		}

		runErr := c.Run(ctx)

		// ctx cancelled — clean exit.
		if ctx.Err() != nil {
			_ = c.Close(context.Background())
			return nil
		}

		// Receiver link died unexpectedly — log and retry with backoff.
		r.logger.Warn("consumer exited unexpectedly, restarting",
			"queue", m.Queue.Name,
			"err", runErr,
			"backoff", backoff,
		)
		_ = c.Close(context.Background())

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}

		backoff = min(backoff*2, maxBackoff)
	}
}
