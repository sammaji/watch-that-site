package cache

import (
	"context"
	"encoding/json"
	"log/slog"
	"maps"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/sammaji/watchthatsite/services/core/heap"
	"github.com/sammaji/watchthatsite/services/scheduler/internal/db"
)

// notificationConfigChannel is the Postgres LISTEN/NOTIFY channel that fires
// when notification_config rows change.
const notificationConfigChannel = "notification_config_changed"

// NotificationConfigFetcher loads a user's configs from the source of truth
// (Postgres). Injected so the cache stays decoupled from the db implementation.
type NotificationConfigFetcher func(ctx context.Context, userID string) ([]db.NotificationConfig, error)

type notificationConfigSnapshotEntry struct {
	configs  []db.NotificationConfig
	size     int64
	lastUsed atomic.Uint64
}

// notificationConfigSnapshot is an immutable snapshot of the whole cache. Readers
// load it via an atomic pointer and never take a lock; writers copy-on-write and
// swap it in. Entry pointers are shared across snapshots so reader recency stamps
// survive.
type notificationConfigSnapshot struct {
	entries map[string]*notificationConfigSnapshotEntry
	bytes   int64
}

// NotificationConfigCache is a byte-bounded, least-recently-used cache of
// notification_config rows keyed by user ID.
//
// Immutable-snapshot design: the entry map lives behind an atomic.Pointer so
// Get() is lock-free and never blocks. Writes (miss-fill, eviction, invalidation)
// are serialized by a plain writer Mutex — not an RWLock — and publish a new
// snapshot with a single atomic store. Copy-on-write makes writes O(n) in entry
// count, traded for contention-free reads. Sync keeps entries fresh off the
// Postgres change feed.
type NotificationConfigCache struct {
	maxBytes int64
	fetch    NotificationConfigFetcher
	listener *db.Listener
	logger   *slog.Logger

	clock   atomic.Uint64 // monotonic recency counter
	active  atomic.Bool   // true only while LISTEN/NOTIFY invalidations are live
	writeMu sync.Mutex    // serializes writers only; readers are lock-free
	state   atomic.Pointer[notificationConfigSnapshot]
}

var _ Cache[string, []db.NotificationConfig] = (*NotificationConfigCache)(nil)

// NewNotificationConfigCache builds a per-user cache bounded to maxBytes. fetch
// loads a user on a miss; listener drives Sync. A non-positive maxBytes uses
// the default budget.
func NewNotificationConfigCache(maxBytes int64, fetch NotificationConfigFetcher, listener *db.Listener, logger *slog.Logger) *NotificationConfigCache {
	if maxBytes <= 0 {
		maxBytes = defaultMaxCacheBytes
	}
	c := &NotificationConfigCache{
		maxBytes: maxBytes,
		fetch:    fetch,
		listener: listener,
		logger:   logger,
	}
	c.active.Store(listener == nil)
	c.state.Store(&notificationConfigSnapshot{entries: make(map[string]*notificationConfigSnapshotEntry)})
	return c
}

// Get returns a user's configs, lazily loading from the fetcher and
// caching the result on a miss.
func (c *NotificationConfigCache) Get(ctx context.Context, userID string) ([]db.NotificationConfig, error) {
	active := c.active.Load()
	if active {
		if e, ok := c.state.Load().entries[userID]; ok {
			// Bump recency without the write lock - entry is shared across snapshots.
			e.lastUsed.Store(c.clock.Add(1))
			return e.configs, nil
		}
	}

	configs, err := c.fetch(ctx, userID)
	if err != nil {
		return nil, err
	}
	if active && c.active.Load() {
		c.insert(userID, configs)
	}
	return configs, nil
}

func (c *NotificationConfigCache) setActive(active bool) {
	c.active.Store(active)
	c.Clear()
}

func (c *NotificationConfigCache) insert(userID string, configs []db.NotificationConfig) {
	if !c.active.Load() {
		return
	}

	size := notificationConfigsSize(userID, configs)

	// A single entry larger than the whole budget is uncacheable
	if size > c.maxBytes {
		return
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if !c.active.Load() {
		return
	}

	old := c.state.Load()

	// OPTIMIZATION: If another goroutine already inserted this key due to a
	// concurrent cache miss, we can just return early. This saves us from doing
	// an O(N) map allocation and copy!
	if _, ok := old.entries[userID]; ok {
		return
	}

	entries := make(map[string]*notificationConfigSnapshotEntry, len(old.entries)+1)
	maps.Copy(entries, old.entries)

	bytes := old.bytes

	e := &notificationConfigSnapshotEntry{configs: configs, size: size}
	e.lastUsed.Store(c.clock.Add(1))
	entries[userID] = e
	bytes += size

	bytes = evictToBudget(entries, bytes, c.maxBytes)
	c.state.Store(&notificationConfigSnapshot{entries: entries, bytes: bytes})
}

// invalidate drops a user so the next Get re-fetches.
func (c *NotificationConfigCache) invalidate(userID string) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	old := c.state.Load()
	e, ok := old.entries[userID]
	if !ok {
		return
	}
	next := make(map[string]*notificationConfigSnapshotEntry, len(old.entries))
	for k, v := range old.entries {
		if k == userID {
			continue
		}
		next[k] = v
	}
	c.state.Store(&notificationConfigSnapshot{entries: next, bytes: old.bytes - e.size})
}

// Sync keeps the cache consistent with Postgres by listening for
// notification_config change events and invalidating the affected user. Blocks
// until ctx is cancelled.
func (c *NotificationConfigCache) Sync(ctx context.Context) error {
	return c.listener.ListenWithStatus(ctx, notificationConfigChannel, c.handleChange, c.setActive)
}

type notificationConfigChange struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
}

func (c *NotificationConfigCache) handleChange(payload string) {
	var p notificationConfigChange
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		c.logger.Warn("malformed cache invalidation payload, clearing cache",
			"payload", payload, "err", err)
		c.Clear()
		return
	}

	c.invalidate(p.UserID)
	c.logger.Debug("cache invalidated",
		"channel", p.ChannelID, "user", p.UserID)
}

func (c *NotificationConfigCache) Clear() {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.state.Store(&notificationConfigSnapshot{entries: make(map[string]*notificationConfigSnapshotEntry)})
}

func (c *NotificationConfigCache) Len() int { return len(c.state.Load().entries) }

func (c *NotificationConfigCache) Bytes() int64 { return c.state.Load().bytes }

// evictToBudget removes the least-recently-used entries from m (in place) until
// its total drops to max, returning the new total. Called on the writer path
// with an unpublished map, so mutating it is safe.
type victim struct {
	key      string
	lastUsed uint64
	size     int64
}

func evictToBudget(m map[string]*notificationConfigSnapshotEntry, bytes, max int64) int64 {
	if bytes <= max {
		return bytes
	}

	data := make([]victim, 0, len(m))
	for k, e := range m {
		data = append(data, victim{key: k, lastUsed: e.lastUsed.Load(), size: e.size})
	}

	// Use the generic wrapper!
	pq := heap.NewPriorityQueueFromSlice(data, func(a, b victim) bool {
		return a.lastUsed < b.lastUsed
	})

	for bytes > max && pq.Len() > 0 {
		v := pq.PopItem()
		delete(m, v.key)
		bytes -= v.size
	}
	return bytes
}

// notificationConfigsSize estimates the heap footprint of a cached user entry
// so the LRU can enforce its byte budget. Approximate: per-struct overhead plus
// the length of every variable-size string/JSON field.
func notificationConfigsSize(userID string, configs []db.NotificationConfig) int64 {
	const structOverhead = int64(unsafe.Sizeof(db.NotificationConfig{}))

	total := int64(len(userID)) + int64(unsafe.Sizeof([]db.NotificationConfig(nil)))
	for i := range configs {
		n := &configs[i]
		total += structOverhead
		total += int64(len(n.ID) + len(n.UserID) + len(n.ChannelID) + len(n.Name))
		total += int64(len(n.Credentials))
	}
	return total
}
