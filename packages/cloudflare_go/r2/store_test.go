package r2

import (
	"context"
	"errors"
	"testing"
)

func TestJSONGzipRoundTrip(t *testing.T) {
	fw, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, testToken)
	ctx := context.Background()
	key := must(ChangeRecordKey(monitorID, runID))

	type record struct {
		Version int      `json:"version"`
		Summary string   `json:"summary"`
		Ops     []string `json:"ops"`
	}
	in := record{Version: 1, Summary: "price changed", Ops: []string{"modify"}}
	if err := PutJSONGzip(ctx, w, key, in); err != nil {
		t.Fatalf("PutJSONGzip: %v", err)
	}
	stored := fw.objects[key]
	if stored.contentType != ContentTypeGzip || len(stored.data) < 2 || stored.data[0] != 0x1f || stored.data[1] != 0x8b {
		t.Errorf("stored %q with %d bytes, want a gzip stream", stored.contentType, len(stored.data))
	}

	var out record
	if err := GetJSONGzip(ctx, w, key, &out); err != nil {
		t.Fatalf("GetJSONGzip: %v", err)
	}
	if out.Summary != in.Summary || len(out.Ops) != 1 {
		t.Errorf("got = %+v, want %+v", out, in)
	}

	missing := must(ChangeRecordKey(monitorID, "00000000-0000-4000-8000-000000000000"))
	if err := GetJSONGzip(ctx, w, missing, &out); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: got = %v, want ErrNotFound", err)
	}
}

func TestJSONRoundTrip(t *testing.T) {
	_, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, testToken)
	ctx := context.Background()
	key := must(StorageStateKey(monitorID))

	if err := PutJSON(ctx, w, key, map[string]any{"cookies": []any{}}); err != nil {
		t.Fatalf("PutJSON: %v", err)
	}
	var out map[string]any
	if err := GetJSON(ctx, w, key, &out); err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if _, ok := out["cookies"]; !ok {
		t.Errorf("got = %v", out)
	}
}

func clearStoreEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{EnvAccountID, EnvAccessKeyID, EnvSecretAccessKey, EnvBucket, EnvEndpoint, EnvUsePathStyle, EnvWorkerURL, EnvAPIToken, EnvSigningSecret} {
		t.Setenv(name, "")
	}
}

func TestNewStoreFromEnvPrecedence(t *testing.T) {
	ctx := context.Background()

	t.Run("nothing set", func(t *testing.T) {
		clearStoreEnv(t)
		if _, err := NewStoreFromEnv(ctx); !errors.Is(err, ErrMissingConfig) {
			t.Errorf("got = %v, want ErrMissingConfig", err)
		}
	})

	t.Run("worker only", func(t *testing.T) {
		clearStoreEnv(t)
		t.Setenv(EnvWorkerURL, "http://localhost:8787")
		t.Setenv(EnvAPIToken, "tok")
		store, err := NewStoreFromEnv(ctx)
		if err != nil {
			t.Fatalf("NewStoreFromEnv: %v", err)
		}
		if _, ok := store.(*WorkerClient); !ok {
			t.Errorf("got %T, want *WorkerClient", store)
		}
	})

	t.Run("worker without token", func(t *testing.T) {
		clearStoreEnv(t)
		t.Setenv(EnvWorkerURL, "http://localhost:8787")
		if _, err := NewStoreFromEnv(ctx); !errors.Is(err, ErrMissingConfig) {
			t.Errorf("got = %v, want ErrMissingConfig", err)
		}
	})

	t.Run("s3 credentials win", func(t *testing.T) {
		clearStoreEnv(t)
		t.Setenv(EnvWorkerURL, "http://localhost:8787")
		t.Setenv(EnvAPIToken, "tok")
		t.Setenv(EnvAccessKeyID, "key")
		t.Setenv(EnvSecretAccessKey, "secret")
		t.Setenv(EnvBucket, "watchthatsite")
		t.Setenv(EnvEndpoint, "http://localhost:9000")
		store, err := NewStoreFromEnv(ctx)
		if err != nil {
			t.Fatalf("NewStoreFromEnv: %v", err)
		}
		if _, ok := store.(*Client); !ok {
			t.Errorf("got %T, want *Client", store)
		}
	})
}
