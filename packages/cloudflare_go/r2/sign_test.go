package r2

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Cross-language test vector. The same key, secret, exp and expected
// signature appear in packages/cloudflare/test/signing.test.ts; if either
// side changes the algorithm, both tests fail.
const (
	vectorKey    = "changes/8dea949d-d40b-49f6-8f9a-9e31f891eb4e/2136440b-8e77-4a2d-8fe2-fcaea8af11f7.json.gz"
	vectorSecret = "wts-test-vector-secret"
	vectorExp    = int64(1790000000)
	vectorSig    = "8930f280ad5550761f7abe127901c6c59d04d4c7004add5819cc21d987e14592"
)

func TestSignatureMatchesTheSharedVector(t *testing.T) {
	if got := Signature(vectorSecret, vectorKey, vectorExp); got != vectorSig {
		t.Errorf("got = %v, want %v", got, vectorSig)
	}
}

func TestSignBuildsTheWorkerURL(t *testing.T) {
	got := Sign("https://objects.example///", vectorSecret, vectorKey, time.Unix(vectorExp, 999))
	want := "https://objects.example/objects/" + vectorKey + "?exp=1790000000&sig=" + vectorSig
	if got != want {
		t.Errorf("got = %v, want %v", got, want)
	}
}

func TestClientSignedURLPointsAtTheWorker(t *testing.T) {
	client, err := New(context.Background(), Config{
		AccessKeyID: "key", SecretAccessKey: "secret", Bucket: "watchthatsite",
		Endpoint: "http://localhost:9000", WorkerURL: "http://localhost:8787/", SigningSecret: vectorSecret,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	before := time.Now()
	raw, err := client.SignedURL(vectorKey, 5*time.Minute)
	if err != nil {
		t.Fatalf("SignedURL: %v", err)
	}
	if !strings.HasPrefix(raw, "http://localhost:8787/objects/"+vectorKey+"?") {
		t.Fatalf("got = %v", raw)
	}
	u, _ := url.Parse(raw)
	exp, _ := strconv.ParseInt(u.Query().Get("exp"), 10, 64)
	if d := time.Unix(exp, 0).Sub(before); d < 5*time.Minute-time.Second || d > 5*time.Minute+2*time.Second {
		t.Errorf("exp is %v from now, want ~5m", d)
	}
	if u.Query().Get("sig") != Signature(vectorSecret, vectorKey, exp) {
		t.Errorf("signature does not verify")
	}
}

func TestSignedURLNeedsConfiguration(t *testing.T) {
	client, err := New(context.Background(), Config{
		AccessKeyID: "key", SecretAccessKey: "secret", Bucket: "watchthatsite", Endpoint: "http://localhost:9000",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := client.SignedURL(vectorKey, time.Minute); !errors.Is(err, ErrSigningNotConfigured) {
		t.Errorf("got = %v, want ErrSigningNotConfigured", err)
	}
}

func TestSignedURLRejectsAnInvalidKey(t *testing.T) {
	w, err := NewWorkerClient(WorkerConfig{BaseURL: "http://w", Token: "t", SigningSecret: "s"})
	if err != nil {
		t.Fatalf("NewWorkerClient: %v", err)
	}
	if _, err := w.SignedURL("screenshots/x.png", time.Minute); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("got = %v, want ErrInvalidKey", err)
	}
}

func TestNewRejectsAnIncompleteConfig(t *testing.T) {
	_, err := New(context.Background(), Config{})
	if !errors.Is(err, ErrMissingConfig) {
		t.Errorf("got = %v, want ErrMissingConfig", err)
	}
}
