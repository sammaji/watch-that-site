package r2_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/sammaji/watchthatsite/packages/cloudflare_go/r2"
)

// newIntegrationClient builds a client from the ambient environment, skipping
// the test when it is not configured. Run these against MinIO with:
//
//	docker compose -f infra/docker-compose.yml --profile storage up -d minio
//	R2_ENDPOINT=http://localhost:9000 R2_USE_PATH_STYLE=true \
//	R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=watchthatsite \
//	go test ./r2/ -run Integration -v
func newIntegrationClient(t *testing.T) *r2.Client {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	cfg, err := r2.ConfigFromEnv()
	if err != nil {
		t.Skipf("skipping integration test: %v", err)
	}

	client, err := r2.New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	// The bucket is created on demand so a fresh MinIO container needs no
	// separate provisioning step.
	if _, err := client.S3().CreateBucket(context.Background(), &s3.CreateBucketInput{
		Bucket: aws.String(cfg.Bucket),
	}); err != nil && !bucketAlreadyExists(err) {
		t.Fatalf("CreateBucket returned error: %v", err)
	}
	return client
}

// newUUID returns a random version 4 UUID. Generating it here keeps the
// module's dependencies to the AWS SDK alone.
func newUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand.Read returned error: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func bucketAlreadyExists(err error) bool {
	msg := err.Error()
	return bytes.Contains([]byte(msg), []byte("BucketAlreadyOwnedByYou")) ||
		bytes.Contains([]byte(msg), []byte("BucketAlreadyExists"))
}

// testKey returns a key unique to this test run, so parallel or repeated runs
// never collide and cleanup is unambiguous.
func testKey(t *testing.T) string {
	t.Helper()
	key, err := r2.CaptureShotKey(newUUID(t), newUUID(t), r2.FormatPNG)
	if err != nil {
		t.Fatalf("CaptureShotKey returned error: %v", err)
	}
	return key
}

func TestIntegrationUploadDownloadRoundTrip(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()
	key := testKey(t)
	t.Cleanup(func() { _ = client.Delete(ctx, key) })

	payload := []byte("\x89PNG\r\n\x1a\n not really a png, but bytes are bytes")

	uploaded, err := client.Upload(ctx, key, payload, nil)
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if uploaded.Size != int64(len(payload)) {
		t.Errorf("got = %v, want %v", uploaded.Size, len(payload))
	}
	if uploaded.ETag == "" {
		t.Error("got an empty ETag, want one")
	}
	if uploaded.ContentType != "image/png" {
		t.Errorf("got = %v, want image/png", uploaded.ContentType)
	}

	downloaded, obj, err := client.Download(ctx, key)
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if !bytes.Equal(downloaded, payload) {
		t.Errorf("got %d bytes, want the %d uploaded", len(downloaded), len(payload))
	}
	if obj.ContentType != "image/png" {
		t.Errorf("got = %v, want image/png", obj.ContentType)
	}
}

func TestIntegrationUploadOverwritesAnExistingKey(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()
	key := testKey(t)
	t.Cleanup(func() { _ = client.Delete(ctx, key) })

	if _, err := client.Upload(ctx, key, []byte("first"), nil); err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if _, err := client.Upload(ctx, key, []byte("second"), nil); err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}

	got, _, err := client.Download(ctx, key)
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if string(got) != "second" {
		t.Errorf("got = %q, want %q", got, "second")
	}
}

func TestIntegrationHeadAndExists(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()
	key := testKey(t)
	t.Cleanup(func() { _ = client.Delete(ctx, key) })

	missing, err := client.Exists(ctx, key)
	if err != nil {
		t.Fatalf("Exists returned error: %v", err)
	}
	if missing {
		t.Error("got = true, want false for an object that was never written")
	}

	payload := []byte("some bytes")
	if _, err := client.Upload(ctx, key, payload, nil); err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}

	obj, err := client.Head(ctx, key)
	if err != nil {
		t.Fatalf("Head returned error: %v", err)
	}
	if obj.Size != int64(len(payload)) {
		t.Errorf("got = %v, want %v", obj.Size, len(payload))
	}
	if obj.LastModified.IsZero() {
		t.Error("got a zero LastModified, want a timestamp")
	}

	present, err := client.Exists(ctx, key)
	if err != nil {
		t.Fatalf("Exists returned error: %v", err)
	}
	if !present {
		t.Error("got = false, want true after upload")
	}
}

func TestIntegrationMissingObjectIsErrNotFound(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()
	key := testKey(t)

	if _, _, err := client.Download(ctx, key); !errors.Is(err, r2.ErrNotFound) {
		t.Errorf("Download: got = %v, want ErrNotFound", err)
	}
	if _, err := client.Head(ctx, key); !errors.Is(err, r2.ErrNotFound) {
		t.Errorf("Head: got = %v, want ErrNotFound", err)
	}
}

func TestIntegrationDeleteIsIdempotent(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()
	key := testKey(t)

	if _, err := client.Upload(ctx, key, []byte("bytes"), nil); err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if err := client.Delete(ctx, key); err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if _, _, err := client.Download(ctx, key); !errors.Is(err, r2.ErrNotFound) {
		t.Errorf("got = %v, want ErrNotFound after delete", err)
	}
	if err := client.Delete(ctx, key); err != nil {
		t.Errorf("second Delete returned error: %v, want nil", err)
	}
}

func TestIntegrationListByMonitorPrefix(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()

	monitor := newUUID(t)
	keys := make([]string, 0, 3)
	for range 3 {
		key, err := r2.CaptureShotKey(monitor, newUUID(t), r2.FormatPNG)
		if err != nil {
			t.Fatalf("CaptureShotKey returned error: %v", err)
		}
		if _, err := client.Upload(ctx, key, []byte("bytes"), nil); err != nil {
			t.Fatalf("Upload returned error: %v", err)
		}
		keys = append(keys, key)
	}
	t.Cleanup(func() { _ = client.DeleteAll(ctx, keys) })

	prefix, err := r2.MonitorPrefix(r2.PrefixCaptures, monitor)
	if err != nil {
		t.Fatalf("MonitorPrefix returned error: %v", err)
	}

	listed, err := client.ListAll(ctx, prefix)
	if err != nil {
		t.Fatalf("ListAll returned error: %v", err)
	}
	if len(listed) != len(keys) {
		t.Fatalf("got %d objects, want %d", len(listed), len(keys))
	}
	for _, obj := range listed {
		if obj.Size == 0 {
			t.Errorf("object %q has size 0, want the uploaded length", obj.Key)
		}
	}
}

func TestIntegrationDeleteAllRemovesEveryKey(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()

	monitor := newUUID(t)
	keys := make([]string, 0, 2)
	for range 2 {
		key, err := r2.ChangeDiffKey(monitor, newUUID(t))
		if err != nil {
			t.Fatalf("ChangeDiffKey returned error: %v", err)
		}
		if _, err := client.Upload(ctx, key, []byte("bytes"), nil); err != nil {
			t.Fatalf("Upload returned error: %v", err)
		}
		keys = append(keys, key)
	}

	if err := client.DeleteAll(ctx, keys); err != nil {
		t.Fatalf("DeleteAll returned error: %v", err)
	}
	for _, key := range keys {
		present, err := client.Exists(ctx, key)
		if err != nil {
			t.Fatalf("Exists returned error: %v", err)
		}
		if present {
			t.Errorf("key %q still exists after DeleteAll", key)
		}
	}
	if err := client.DeleteAll(ctx, nil); err != nil {
		t.Errorf("DeleteAll(nil) returned error: %v, want nil", err)
	}
}

func TestIntegrationStoreJSONGzipRoundTrip(t *testing.T) {
	client := newIntegrationClient(t)
	ctx := context.Background()
	key, err := r2.BlocksKey(newUUID(t), newUUID(t))
	if err != nil {
		t.Fatalf("BlocksKey returned error: %v", err)
	}
	t.Cleanup(func() { _ = client.Delete(ctx, key) })

	in := map[string]any{"blocks": []any{map[string]any{"id": "b0", "text": "hello"}}}
	if err := r2.PutJSONGzip(ctx, client, key, in); err != nil {
		t.Fatalf("PutJSONGzip returned error: %v", err)
	}
	var out map[string]any
	if err := r2.GetJSONGzip(ctx, client, key, &out); err != nil {
		t.Fatalf("GetJSONGzip returned error: %v", err)
	}
	if _, ok := out["blocks"]; !ok {
		t.Errorf("got = %v, want the blocks back", out)
	}
	obj, err := client.Head(ctx, key)
	if err != nil {
		t.Fatalf("Head returned error: %v", err)
	}
	if obj.ContentType != r2.ContentTypeGzip {
		t.Errorf("got = %v, want %v", obj.ContentType, r2.ContentTypeGzip)
	}
}

// TestIntegrationWorkerClient runs against a live object-store Worker
// (`pnpm --filter @watchthatsite/cloudflare dev`) when R2_WORKER_URL and
// R2_API_TOKEN are set, and checks that a signed URL reads back and an
// unsigned GET is refused.
func TestIntegrationWorkerClient(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}
	cfg, err := r2.WorkerConfigFromEnv()
	if err != nil {
		t.Skipf("skipping integration test: %v", err)
	}
	w, err := r2.NewWorkerClient(cfg)
	if err != nil {
		t.Fatalf("NewWorkerClient returned error: %v", err)
	}
	ctx := context.Background()
	key := testKey(t)
	t.Cleanup(func() { _ = w.Delete(ctx, key) })

	payload := []byte("\x89PNG through the worker")
	if err := w.Put(ctx, key, payload, ""); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}
	got, err := w.Get(ctx, key)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("Get = %q, %v", got, err)
	}

	unsigned, err := http.Get(cfg.BaseURL + "/objects/" + key)
	if err != nil {
		t.Fatalf("unsigned GET: %v", err)
	}
	unsigned.Body.Close()
	if unsigned.StatusCode != http.StatusUnauthorized {
		t.Errorf("unsigned GET = %d, want 401", unsigned.StatusCode)
	}

	if cfg.SigningSecret == "" {
		t.Skipf("skipping signed read: %s is not set", r2.EnvSigningSecret)
	}
	signed, err := w.SignedURL(key, time.Minute)
	if err != nil {
		t.Fatalf("SignedURL returned error: %v", err)
	}
	resp, err := http.Get(signed)
	if err != nil {
		t.Fatalf("signed GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, payload) {
		t.Errorf("signed GET = %d (%d bytes), want 200 with the payload", resp.StatusCode, len(body))
	}
}

func TestIntegrationUploadRejectsAnInvalidKey(t *testing.T) {
	client := newIntegrationClient(t)

	_, err := client.Upload(context.Background(), "screenshots/whatever.png", []byte("bytes"), nil)
	if !errors.Is(err, r2.ErrInvalidKey) {
		t.Errorf("got = %v, want ErrInvalidKey", err)
	}
}
