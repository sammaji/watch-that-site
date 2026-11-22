package r2

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testToken  = "test-token"
	testSecret = "test-signing-secret"
)

// fakeWorker mimics the object-store Worker's /objects contract closely
// enough to exercise WorkerClient: bearer auth, signed GETs, key validation,
// content-type enforcement and 404s.
type fakeWorker struct {
	mu      sync.Mutex
	objects map[string]fakeObject
	fail5xx atomic.Int32 // respond 503 this many times first
	calls   atomic.Int32
}

type fakeObject struct {
	data        []byte
	contentType string
}

func newFakeWorker(t *testing.T) (*fakeWorker, *httptest.Server) {
	t.Helper()
	fw := &fakeWorker{objects: map[string]fakeObject{}}
	srv := httptest.NewServer(fw)
	t.Cleanup(srv.Close)
	return fw, srv
}

func jsonErr(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `{"error":{"code":"`+code+`","message":"`+code+`"}}`)
}

func (f *fakeWorker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls.Add(1)
	if f.fail5xx.Load() > 0 {
		f.fail5xx.Add(-1)
		jsonErr(w, 503, "unavailable")
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/objects/")
	parsed, err := ParseKey(key)
	if err != nil {
		jsonErr(w, 400, "invalid_key")
		return
	}
	bearer := r.Header.Get("Authorization") == "Bearer "+testToken
	if r.Method == http.MethodGet && !bearer {
		q := r.URL.Query()
		exp, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
		if r.Header.Get("Authorization") != "" || exp <= time.Now().Unix() || q.Get("sig") != Signature(testSecret, key, exp) {
			jsonErr(w, 401, "unauthorized")
			return
		}
	} else if !bearer {
		jsonErr(w, 401, "unauthorized")
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.Method {
	case http.MethodPut:
		if r.Header.Get("Content-Type") != parsed.ContentType {
			jsonErr(w, 415, "unsupported_media_type")
			return
		}
		data, _ := io.ReadAll(r.Body)
		f.objects[key] = fakeObject{data, r.Header.Get("Content-Type")}
		w.WriteHeader(201)
		_, _ = io.WriteString(w, `{"key":"`+key+`","url":""}`)
	case http.MethodGet:
		obj, ok := f.objects[key]
		if !ok {
			jsonErr(w, 404, "not_found")
			return
		}
		w.Header().Set("Content-Type", obj.contentType)
		_, _ = w.Write(obj.data)
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(204)
	default:
		jsonErr(w, 405, "method_not_allowed")
	}
}

func newTestWorkerClient(t *testing.T, srv *httptest.Server, token string) *WorkerClient {
	t.Helper()
	w, err := NewWorkerClient(WorkerConfig{BaseURL: srv.URL + "/", Token: token, SigningSecret: testSecret, HTTPClient: srv.Client()})
	if err != nil {
		t.Fatalf("NewWorkerClient: %v", err)
	}
	return w
}

func TestWorkerClientRoundTrip(t *testing.T) {
	fw, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, testToken)
	ctx := context.Background()
	key := must(CaptureShotKey(monitorID, runID, "png"))

	if _, err := w.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing: got = %v, want ErrNotFound", err)
	}
	if err := w.Put(ctx, key, []byte("png-bytes"), ""); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got := fw.objects[key].contentType; got != ContentTypePNG {
		t.Errorf("stored content type = %v, want image/png", got)
	}
	got, err := w.Get(ctx, key)
	if err != nil || string(got) != "png-bytes" {
		t.Fatalf("Get: got = %q, %v", got, err)
	}
	if err := w.Delete(ctx, key); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := w.Delete(ctx, key); err != nil {
		t.Fatalf("second Delete: %v", err)
	}
	if _, err := w.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after delete: got = %v, want ErrNotFound", err)
	}
}

func TestWorkerClientSignedURLIsAcceptedByTheWorker(t *testing.T) {
	_, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, testToken)
	key := must(ChangeDiffKey(monitorID, runID))
	if err := w.Put(context.Background(), key, []byte("diff"), ContentTypePNG); err != nil {
		t.Fatalf("Put: %v", err)
	}

	signed, err := w.SignedURL(key, time.Minute)
	if err != nil {
		t.Fatalf("SignedURL: %v", err)
	}
	resp, err := srv.Client().Get(signed)
	if err != nil {
		t.Fatalf("GET signed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "diff" {
		t.Errorf("signed GET = %d %q, want 200 diff", resp.StatusCode, body)
	}

	resp, err = srv.Client().Get(srv.URL + "/objects/" + key)
	if err != nil {
		t.Fatalf("GET unsigned: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("unsigned GET = %d, want 401", resp.StatusCode)
	}
}

func TestWorkerClientSurfacesWorkerErrors(t *testing.T) {
	_, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, "wrong")
	key := must(StorageStateKey(monitorID))

	err := w.Put(context.Background(), key, []byte("{}"), "")
	var we *WorkerError
	if !errors.As(err, &we) || we.Status != 401 || we.Code != "unauthorized" {
		t.Errorf("got = %v, want a 401 WorkerError", err)
	}
	if !IsWorkerError(err, "unauthorized") {
		t.Errorf("IsWorkerError = false")
	}
}

func TestWorkerClientValidatesLocally(t *testing.T) {
	fw, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, testToken)
	ctx := context.Background()

	if err := w.Put(ctx, "screenshots/"+monitorID+"/"+runID+".png", []byte("x"), ""); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("old key: got = %v, want ErrInvalidKey", err)
	}
	key := must(BlocksKey(monitorID, runID))
	if err := w.Put(ctx, key, []byte("x"), ContentTypeJSON); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("wrong content type: got = %v, want ErrInvalidKey", err)
	}
	if err := w.Put(ctx, key, nil, ""); err == nil {
		t.Errorf("empty body: got nil error")
	}
	if n := fw.calls.Load(); n != 0 {
		t.Errorf("made %d requests, want 0", n)
	}
}

func TestWorkerClientRetriesA5xxOnce(t *testing.T) {
	fw, srv := newFakeWorker(t)
	w := newTestWorkerClient(t, srv, testToken)
	fw.fail5xx.Store(1)
	key := must(StorageStateKey(monitorID))
	if err := w.Put(context.Background(), key, []byte("{}"), ""); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if n := fw.calls.Load(); n != 2 {
		t.Errorf("calls = %d, want 2", n)
	}

	fw.fail5xx.Store(5)
	err := w.Put(context.Background(), key, []byte("{}"), "")
	var we *WorkerError
	if !errors.As(err, &we) || we.Status != 503 {
		t.Errorf("got = %v, want a 503 WorkerError", err)
	}
}

func TestNewWorkerClientValidatesConfig(t *testing.T) {
	if _, err := NewWorkerClient(WorkerConfig{}); !errors.Is(err, ErrMissingConfig) {
		t.Errorf("got = %v, want ErrMissingConfig", err)
	}
	if _, err := NewWorkerClient(WorkerConfig{BaseURL: "not a url", Token: "t"}); err == nil {
		t.Errorf("got nil error for a relative URL")
	}
}
