package cache

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
	"github.com/stretchr/testify/require"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestCache(fetch NotificationConfigFetcher) *NotificationConfigCache {
	return NewNotificationConfigCache(0, fetch, nil, testLogger())
}

func TestGetCachesAfterMiss(t *testing.T) {
	calls := 0
	expected := []db.NotificationConfig{{ID: "cfg-1"}}
	c := newTestCache(func(context.Context, string) ([]db.NotificationConfig, error) {
		calls++
		return expected, nil
	})

	got, err := c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	require.Equal(t, expected, got)
	require.Equal(t, 1, calls)

	// Second Get is served from cache — fetcher not called again.
	got, err = c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	require.Equal(t, expected, got)
	require.Equal(t, 1, calls)
	require.Equal(t, 1, c.Len())
}

func TestGetBypassesCacheWhenListenerInactive(t *testing.T) {
	calls := 0
	c := newTestCache(func(context.Context, string) ([]db.NotificationConfig, error) {
		calls++
		return []db.NotificationConfig{{ID: "cfg"}}, nil
	})

	_, err := c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	require.Equal(t, 1, c.Len())

	c.setActive(false)
	require.Zero(t, c.Len())

	_, err = c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	_, err = c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	require.Equal(t, 3, calls)
	require.Zero(t, c.Len())
}

func TestReconnectClearsCacheBeforeServingAgain(t *testing.T) {
	calls := 0
	c := newTestCache(func(context.Context, string) ([]db.NotificationConfig, error) {
		calls++
		return []db.NotificationConfig{{ID: "cfg"}}, nil
	})

	_, err := c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	require.Equal(t, 1, c.Len())

	c.setActive(true)
	require.Zero(t, c.Len())

	_, err = c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	_, err = c.Get(context.Background(), "user-1")
	require.NoError(t, err)
	require.Equal(t, 2, calls)
	require.Equal(t, 1, c.Len())
}

func TestGetPropagatesFetchError(t *testing.T) {
	c := newTestCache(func(context.Context, string) ([]db.NotificationConfig, error) {
		return nil, errors.New("fetch failed")
	})

	_, err := c.Get(context.Background(), "user-1")
	require.ErrorContains(t, err, "fetch failed")
	require.Zero(t, c.Len())
}

func TestHandleChangeInvalidatesUser(t *testing.T) {
	c := newTestCache(func(context.Context, string) ([]db.NotificationConfig, error) {
		return []db.NotificationConfig{{ID: "x"}}, nil
	})

	_, _ = c.Get(context.Background(), "user-1")
	_, _ = c.Get(context.Background(), "user-2")
	require.Equal(t, 2, c.Len())

	c.handleChange(`{"channel_id":"email","user_id":"user-1"}`)
	require.Equal(t, 1, c.Len())

	// Malformed payload clears the whole cache.
	c.handleChange(`{"channel_id":`)
	require.Zero(t, c.Len())
}
