package r2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// WorkerConfig configures a WorkerClient.
type WorkerConfig struct {
	// BaseURL is the object-store Worker origin (R2_WORKER_URL), e.g.
	// http://localhost:8787. Required.
	BaseURL string

	// Token is the Worker's shared bearer token (R2_API_TOKEN). Required.
	Token string

	// SigningSecret is R2_SIGNING_SECRET. Optional; SignedURL needs it.
	SigningSecret string

	// HTTPClient defaults to a client with a 30 s timeout.
	HTTPClient *http.Client
}

// WorkerConfigFromEnv reads R2_WORKER_URL, R2_API_TOKEN and R2_SIGNING_SECRET.
func WorkerConfigFromEnv() (WorkerConfig, error) {
	cfg := WorkerConfig{
		BaseURL:       strings.TrimSpace(os.Getenv(EnvWorkerURL)),
		Token:         strings.TrimSpace(os.Getenv(EnvAPIToken)),
		SigningSecret: strings.TrimSpace(os.Getenv(EnvSigningSecret)),
	}
	return cfg, cfg.validate()
}

func (c WorkerConfig) validate() error {
	var missing []string
	if c.BaseURL == "" {
		missing = append(missing, EnvWorkerURL)
	}
	if c.Token == "" {
		missing = append(missing, EnvAPIToken)
	}
	if len(missing) > 0 {
		return fmt.Errorf("%w: missing %s", ErrMissingConfig, strings.Join(missing, ", "))
	}
	return nil
}

// WorkerClient is a Store that reads and writes through the object-store
// Worker (packages/cloudflare) with the bearer token. It is safe for
// concurrent use.
type WorkerClient struct {
	baseURL       string
	token         string
	signingSecret string
	http          *http.Client
}

var _ Store = (*WorkerClient)(nil)

// WorkerError is a non-2xx response from the Worker other than 404.
type WorkerError struct {
	Status  int
	Code    string
	Message string
}

func (e *WorkerError) Error() string {
	return fmt.Sprintf("r2 worker: %d %s: %s", e.Status, e.Code, e.Message)
}

// NewWorkerClient builds a WorkerClient.
func NewWorkerClient(cfg WorkerConfig) (*WorkerClient, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	base := strings.TrimRight(cfg.BaseURL, "/")
	if u, err := url.Parse(base); err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("r2: %s %q is not an absolute URL", EnvWorkerURL, cfg.BaseURL)
	}
	hc := cfg.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	return &WorkerClient{baseURL: base, token: cfg.Token, signingSecret: cfg.SigningSecret, http: hc}, nil
}

// BaseURL returns the Worker origin.
func (w *WorkerClient) BaseURL() string { return w.baseURL }

// Put implements Store.
func (w *WorkerClient) Put(ctx context.Context, key string, data []byte, contentType string) error {
	parsed, err := ParseKey(key)
	if err != nil {
		return err
	}
	if contentType == "" {
		contentType = parsed.ContentType
	} else if contentType != parsed.ContentType {
		return fmt.Errorf("%w: %q must be stored as %s, got %s", ErrInvalidKey, key, parsed.ContentType, contentType)
	}
	if len(data) == 0 {
		return fmt.Errorf("r2: put %q: refusing to store an empty object", key)
	}
	if len(data) > MaxObjectBytes {
		return fmt.Errorf("r2: put %q: %w (%d bytes)", key, ErrTooLarge, len(data))
	}
	resp, err := w.do(ctx, http.MethodPut, key, data, contentType)
	if err != nil {
		return fmt.Errorf("r2: put %q: %w", key, err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("r2: put %q: %w", key, workerError(resp))
	}
	return nil
}

// Get implements Store.
func (w *WorkerClient) Get(ctx context.Context, key string) ([]byte, error) {
	if err := validateKey(key); err != nil {
		return nil, err
	}
	resp, err := w.do(ctx, http.MethodGet, key, nil, "")
	if err != nil {
		return nil, fmt.Errorf("r2: get %q: %w", key, err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("r2: get %q: %w", key, workerError(resp))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxObjectBytes+1))
	if err != nil {
		return nil, fmt.Errorf("r2: get %q: %w", key, err)
	}
	if len(data) > MaxObjectBytes {
		return nil, fmt.Errorf("r2: get %q: %w", key, ErrTooLarge)
	}
	return data, nil
}

// Delete implements Store.
func (w *WorkerClient) Delete(ctx context.Context, key string) error {
	if err := validateKey(key); err != nil {
		return err
	}
	resp, err := w.do(ctx, http.MethodDelete, key, nil, "")
	if err != nil {
		return fmt.Errorf("r2: delete %q: %w", key, err)
	}
	defer drain(resp)
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("r2: delete %q: %w", key, workerError(resp))
	}
	return nil
}

// SignedURL implements Store.
func (w *WorkerClient) SignedURL(key string, ttl time.Duration) (string, error) {
	return signedURL(w.baseURL, w.signingSecret, key, ttl)
}

// do sends one request, retrying once on a transport error or a 5xx. Every
// operation here is idempotent, so a retry is safe.
func (w *WorkerClient) do(ctx context.Context, method, key string, body []byte, contentType string) (*http.Response, error) {
	const attempts = 2
	var lastErr error
	for attempt := range attempts {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, w.baseURL+"/objects/"+key, reader)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+w.token)
		if body != nil {
			req.Header.Set("Content-Type", contentType)
			req.ContentLength = int64(len(body))
		}
		resp, err := w.http.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, err
			}
			lastErr = err
			continue
		}
		if resp.StatusCode >= 500 && attempt < attempts-1 {
			lastErr = workerError(resp)
			drain(resp)
			continue
		}
		return resp, nil
	}
	return nil, lastErr
}

// workerError maps a non-success response: 404 → ErrNotFound, anything else
// → *WorkerError carrying the Worker's error code.
func workerError(resp *http.Response) error {
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	e := &WorkerError{Status: resp.StatusCode, Code: "unknown_error", Message: strconv.Itoa(resp.StatusCode)}
	if json.Unmarshal(raw, &body) == nil && body.Error.Code != "" {
		e.Code, e.Message = body.Error.Code, body.Error.Message
	} else if len(raw) > 0 {
		e.Message = strings.TrimSpace(string(raw))
	}
	return e
}

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
}

// IsWorkerError reports whether err carries a *WorkerError with the given code.
func IsWorkerError(err error, code string) bool {
	var we *WorkerError
	return errors.As(err, &we) && we.Code == code
}
