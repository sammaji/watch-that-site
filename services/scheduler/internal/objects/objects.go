// Package objects is the scheduler's view of object storage: the key layout
// (mirrored in packages/cloudflare/src/shared/keys.ts and
// packages/cloudflare_go/r2), a small Store interface satisfied by the R2
// clients in packages/cloudflare_go, gzip JSON helpers, an LRU for Capture
// blocks, and an in-memory Store for tests.
package objects

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrNotFound is returned by Get when the object does not exist.
var ErrNotFound = errors.New("objects: not found")

// Store reads and writes objects. SignedURL returns a short-lived link that
// a browser or chat client can fetch without credentials.
type Store interface {
	Put(ctx context.Context, key string, data []byte, contentType string) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
	SignedURL(key string, ttl time.Duration) (string, error)
}

// Content types.
const (
	TypePNG  = "image/png"
	TypeWebP = "image/webp"
	TypeGzip = "application/gzip"
	TypeJSON = "application/json"
)

// Key builders. The first id is always the Monitor's, so ownership can be
// checked from the key alone.

func BlocksKey(monitorID, runID string) string {
	return fmt.Sprintf("captures/%s/%s/blocks.json.gz", monitorID, runID)
}

func ShotKey(monitorID, runID, format string) string {
	return fmt.Sprintf("captures/%s/%s/shot.%s", monitorID, runID, format)
}

func RecordKey(monitorID, changeID string) string {
	return fmt.Sprintf("changes/%s/%s.json.gz", monitorID, changeID)
}

func DiffImageKey(monitorID, changeID string) string {
	return fmt.Sprintf("changes/%s/%s-diff.png", monitorID, changeID)
}

func CropKey(monitorID, changeID string) string {
	return fmt.Sprintf("changes/%s/%s-crop.png", monitorID, changeID)
}

func StorageStateKey(monitorID string) string {
	return fmt.Sprintf("state/%s.json", monitorID)
}

// PutJSONGzip gzips v's JSON encoding and stores it.
func PutJSONGzip(ctx context.Context, s Store, key string, v any) error {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(v); err != nil {
		return fmt.Errorf("encode %s: %w", key, err)
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("gzip %s: %w", key, err)
	}
	return s.Put(ctx, key, buf.Bytes(), TypeGzip)
}

// GetJSONGzip loads and decodes a gzipped JSON object.
func GetJSONGzip(ctx context.Context, s Store, key string, v any) error {
	raw, err := s.Get(ctx, key)
	if err != nil {
		return err
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("gunzip %s: %w", key, err)
	}
	defer zr.Close()
	body, err := io.ReadAll(zr)
	if err != nil {
		return fmt.Errorf("gunzip %s: %w", key, err)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return fmt.Errorf("decode %s: %w", key, err)
	}
	return nil
}

// Memory is an in-memory Store for tests and local experiments.
type Memory struct {
	mu      sync.Mutex
	objects map[string][]byte
	types   map[string]string
	deleted []string
}

// NewMemory returns an empty in-memory Store.
func NewMemory() *Memory {
	return &Memory{objects: map[string][]byte{}, types: map[string]string{}}
}

func (m *Memory) Put(_ context.Context, key string, data []byte, contentType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = bytes.Clone(data)
	m.types[key] = contentType
	return nil
}

func (m *Memory) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objects[key]
	if !ok {
		return nil, fmt.Errorf("%s: %w", key, ErrNotFound)
	}
	return bytes.Clone(data), nil
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	m.deleted = append(m.deleted, key)
	return nil
}

func (m *Memory) SignedURL(key string, ttl time.Duration) (string, error) {
	return "memory://" + key + "?ttl=" + ttl.String(), nil
}

// Keys lists the stored keys with the given prefix, sorted.
func (m *Memory) Keys(prefix string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// Deleted lists every key passed to Delete, in order.
func (m *Memory) Deleted() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.deleted...)
}
