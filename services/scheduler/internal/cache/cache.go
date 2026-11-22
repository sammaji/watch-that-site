// Package cache provides a size-bounded, self-populating cache abstraction and
// the notification_config implementation used for notification fan-out.
package cache

import "context"

// defaultMaxCacheBytes bounds a cache's total entry footprint (~200MB).
const defaultMaxCacheBytes int64 = 200 * 1024 * 1024

// Cache is a size-bounded, self-populating cache kept in sync with a backing
// store.
//
// Get lazily loads on a miss; Sync keeps entries fresh off the store's change
// feed. Insertion and eviction are internal to each implementation - there is
// deliberately no Put/Delete on the contract.
type Cache[K comparable, V any] interface {
	// Get returns the value for key, loading and caching it on a miss.
	Get(ctx context.Context, key K) (V, error)
	// Sync keeps the cache consistent with the backing store (via LISTEN/NOTIFY)
	// and blocks until ctx is cancelled.
	Sync(ctx context.Context) error
	// Clear drops every entry.
	Clear()
	// Len returns the number of cached entries.
	Len() int
	// Bytes returns the current estimated footprint of all entries.
	Bytes() int64
}
