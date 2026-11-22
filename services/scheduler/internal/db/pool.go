package db

import (
	"context"
	"fmt"
	"runtime"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// poolHeadroom is how many connections stay free for everything that is not
// an evaluation: ticks, the admin API, digests, notifications.
const poolHeadroom = 8

// NewPool opens a pgx connection pool and verifies connectivity.
//
// evaluations is how many Captures are evaluated at once. Each evaluation
// holds one connection for its whole transaction, which includes the agent
// calls and so can last minutes; the pool is sized so that all of them
// together cannot starve the rest of the service.
func NewPool(ctx context.Context, databaseURL string, evaluations int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse pgx pool config: %w", err)
	}

	cfg.MaxConns = int32(max(runtime.NumCPU()*2, evaluations+poolHeadroom))
	cfg.MinConns = min(5, cfg.MaxConns) // keep warm connections
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create pgx pool: %w", err)
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}
	return pool, nil
}
