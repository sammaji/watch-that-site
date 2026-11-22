package objects

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/sammaji/watchthatsite/packages/cloudflare_go/r2"
)

// r2Store adapts an r2.Store (the S3 client or the Worker client) to Store,
// translating its not-found error.
type r2Store struct {
	s r2.Store
}

// FromR2 wraps an r2.Store.
func FromR2(s r2.Store) Store { return r2Store{s: s} }

func (a r2Store) Put(ctx context.Context, key string, data []byte, contentType string) error {
	return a.s.Put(ctx, key, data, contentType)
}

func (a r2Store) Get(ctx context.Context, key string) ([]byte, error) {
	data, err := a.s.Get(ctx, key)
	if errors.Is(err, r2.ErrNotFound) {
		return nil, fmt.Errorf("%s: %w", key, ErrNotFound)
	}
	return data, err
}

func (a r2Store) Delete(ctx context.Context, key string) error {
	err := a.s.Delete(ctx, key)
	if errors.Is(err, r2.ErrNotFound) {
		return nil
	}
	return err
}

func (a r2Store) SignedURL(key string, ttl time.Duration) (string, error) {
	return a.s.SignedURL(key, ttl)
}
