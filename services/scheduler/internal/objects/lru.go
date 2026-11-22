package objects

import (
	"container/list"
	"sync"
)

// LRU is a small, concurrency-safe least-recently-used cache. The pipeline
// keeps about 64 Captures' blocks in one, since every Run re-reads its
// baseline's blocks.
type LRU[V any] struct {
	mu    sync.Mutex
	size  int
	order *list.List
	items map[string]*list.Element
}

type lruEntry[V any] struct {
	key   string
	value V
}

// NewLRU returns a cache holding at most size entries.
func NewLRU[V any](size int) *LRU[V] {
	if size < 1 {
		size = 1
	}
	return &LRU[V]{size: size, order: list.New(), items: map[string]*list.Element{}}
}

// Get returns the cached value and marks it recently used.
func (c *LRU[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.order.MoveToFront(el)
		return el.Value.(*lruEntry[V]).value, true
	}
	var zero V
	return zero, false
}

// Add stores a value, evicting the least recently used entry when full.
func (c *LRU[V]) Add(key string, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		el.Value.(*lruEntry[V]).value = value
		c.order.MoveToFront(el)
		return
	}
	c.items[key] = c.order.PushFront(&lruEntry[V]{key: key, value: value})
	for c.order.Len() > c.size {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*lruEntry[V]).key)
	}
}
