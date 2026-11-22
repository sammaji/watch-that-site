package db

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/sammaji/watchthatsite/services/core/config"
)

// NotifyHandler processes a single LISTEN/NOTIFY payload.
type NotifyHandler func(payload string)

// ListenStatusHandler is called when a LISTEN subscription becomes active or
// inactive. The inactive state covers reconnect backoff, so callers that depend
// on the feed can avoid serving stale state while notifications may be missed.
type ListenStatusHandler func(active bool)

// Listener subscribes to a Postgres LISTEN/NOTIFY channel and dispatches each
// payload to a handler. It is a generic building block - any cache or component
// that needs a change feed can reuse it.
type Listener struct {
	cfg    *config.Config
	pool   *pgxpool.Pool
	logger *slog.Logger
}

func NewListener(cfg *config.Config, pool *pgxpool.Pool, logger *slog.Logger) *Listener {
	return &Listener{cfg: cfg, pool: pool, logger: logger}
}

// ListenWithStatus subscribes to channel, calls handle for every notification and reports subscription
// activity changes through status.
func (l *Listener) ListenWithStatus(ctx context.Context, channel string, handle NotifyHandler, status ListenStatusHandler) error {
	const (
		baseBackoff     = time.Second
		maxBackoff      = 30 * time.Second
		healthyDuration = time.Minute
	)

	backoff := baseBackoff
	if status != nil {
		status(false)
	}

	// if the connection is ever severed by a firewall or network blip, the loop
	// will return an error, log a warning, and immediately retry using exponential
	// backoff—acquiring a fresh connection from the pool and issuing the LISTEN
	// command again.
	for {
		start := time.Now()
		err := l.listenOnce(ctx, channel, handle, status)
		if ctx.Err() != nil {
			return nil
		}

		// Reset backoff if the subscription stayed up long enough - a blip after
		// a healthy run should restart fast, not inherit the previous backoff.
		if time.Since(start) > healthyDuration {
			backoff = baseBackoff
		}

		l.logger.Warn("listener failed, retrying",
			"channel", channel, "err", err, "backoff", backoff)

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}

		if next := backoff * 2; next < maxBackoff {
			backoff = next
		} else {
			backoff = maxBackoff
		}
	}
}

func (l *Listener) listenOnce(ctx context.Context, channel string, handle NotifyHandler, status ListenStatusHandler) error {
	// postgres listen connections are session scoped, so we can't use connection pools
	// for shared connection pools, postgres' notify queued would remain blocked until
	// the connection is released
	conn, err := pgx.Connect(ctx, l.cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect to postgres: %w", err)
	}
	defer conn.Close(ctx)

	// Sanitize - the channel name is an SQL identifier, not a bound parameter.
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{channel}.Sanitize()); err != nil {
		return fmt.Errorf("LISTEN %s: %w", channel, err)
	}
	if status != nil {
		status(true)
		defer status(false)
	}
	l.logger.Info("listener started", "channel", channel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("wait for notification: %w", err)
		}
		handle(n.Payload)
	}
}
