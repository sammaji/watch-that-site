package r2

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Store is what services need from object storage. Both implementations
// satisfy it:
//
//   - *Client talks to R2 (or MinIO) over the S3 API.
//   - *WorkerClient goes through the object-store Worker's HTTP API.
//
// Keys must match KeyLayout and are stored with the content type the key
// implies (see ContentTypeForKey); an empty contentType means exactly that.
type Store interface {
	// Put stores data at key, replacing anything already there.
	Put(ctx context.Context, key string, data []byte, contentType string) error

	// Get reads a whole object. A missing object is an error wrapping
	// ErrNotFound.
	Get(ctx context.Context, key string) ([]byte, error)

	// Delete removes key. Deleting a missing object is not an error.
	Delete(ctx context.Context, key string) error

	// SignedURL returns a read URL on the object-store Worker valid for ttl.
	// It returns ErrSigningNotConfigured without R2_WORKER_URL and
	// R2_SIGNING_SECRET. It does not check that the object exists.
	SignedURL(key string, ttl time.Duration) (string, error)
}

// NewStoreFromEnv picks a Store from the environment:
//
//  1. R2_ACCESS_KEY_ID set → S3 *Client (ConfigFromEnv: R2_SECRET_ACCESS_KEY,
//     R2_BUCKET and R2_ACCOUNT_ID or R2_ENDPOINT are then required). SignedURL
//     additionally needs R2_WORKER_URL and R2_SIGNING_SECRET.
//  2. otherwise R2_WORKER_URL set → *WorkerClient (Worker-only mode;
//     R2_API_TOKEN required, R2_SIGNING_SECRET needed for SignedURL).
//  3. neither → ErrMissingConfig.
//
// S3 credentials win because they are the production path (no per-request
// Worker invocation). Worker-only mode exists for local development, where
// `wrangler dev`'s simulated bucket and MinIO are different buckets: leaving
// the S3 credentials unset makes every service read and write the Worker's
// bucket, so there is one source of truth.
func NewStoreFromEnv(ctx context.Context) (Store, error) {
	if strings.TrimSpace(os.Getenv(EnvAccessKeyID)) != "" {
		return NewFromEnv(ctx)
	}
	if strings.TrimSpace(os.Getenv(EnvWorkerURL)) != "" {
		cfg, err := WorkerConfigFromEnv()
		if err != nil {
			return nil, err
		}
		return NewWorkerClient(cfg)
	}
	return nil, fmt.Errorf("%w: set %s (+ S3 credentials) or %s (+ %s)",
		ErrMissingConfig, EnvAccessKeyID, EnvWorkerURL, EnvAPIToken)
}

// PutJSONGzip marshals v to JSON, gzips it and stores it at key as
// application/gzip. Use it for blocks.json.gz and Change Records.
func PutJSONGzip(ctx context.Context, store Store, key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("r2: marshal %q: %w", key, err)
	}
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(raw); err != nil {
		return fmt.Errorf("r2: gzip %q: %w", key, err)
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("r2: gzip %q: %w", key, err)
	}
	return store.Put(ctx, key, buf.Bytes(), ContentTypeGzip)
}

// GetJSONGzip reads a gzipped JSON object into v. A missing object is an
// error wrapping ErrNotFound.
func GetJSONGzip(ctx context.Context, store Store, key string, v any) error {
	data, err := store.Get(ctx, key)
	if err != nil {
		return err
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("r2: gunzip %q: %w", key, err)
	}
	defer zr.Close()
	// Cap the inflated size too, so a hostile object cannot balloon memory.
	raw, err := io.ReadAll(io.LimitReader(zr, 8*MaxObjectBytes+1))
	if err != nil {
		return fmt.Errorf("r2: gunzip %q: %w", key, err)
	}
	if len(raw) > 8*MaxObjectBytes {
		return fmt.Errorf("r2: gunzip %q: %w", key, ErrTooLarge)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("r2: unmarshal %q: %w", key, err)
	}
	return nil
}

// PutJSON stores v as plain JSON (application/json). Use it for state/{m}.json.
func PutJSON(ctx context.Context, store Store, key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("r2: marshal %q: %w", key, err)
	}
	return store.Put(ctx, key, raw, ContentTypeJSON)
}

// GetJSON reads a plain JSON object into v.
func GetJSON(ctx context.Context, store Store, key string, v any) error {
	data, err := store.Get(ctx, key)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("r2: unmarshal %q: %w", key, err)
	}
	return nil
}
