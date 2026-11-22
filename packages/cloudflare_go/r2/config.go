package r2

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Environment variables read by ConfigFromEnv.
const (
	EnvAccountID       = "R2_ACCOUNT_ID"
	EnvAccessKeyID     = "R2_ACCESS_KEY_ID"
	EnvSecretAccessKey = "R2_SECRET_ACCESS_KEY"
	EnvBucket          = "R2_BUCKET"
	EnvEndpoint        = "R2_ENDPOINT"
	EnvUsePathStyle    = "R2_USE_PATH_STYLE"

	// EnvWorkerURL is the object-store Worker's origin, e.g.
	// http://localhost:8787. Signed URLs point here, and in Worker-only mode
	// every read and write goes through it.
	EnvWorkerURL = "R2_WORKER_URL"

	// EnvAPIToken is the Worker's shared bearer token (Worker-only mode).
	EnvAPIToken = "R2_API_TOKEN"

	// EnvSigningSecret is the HMAC key for signed read URLs. Must match the
	// Worker's and the web app's R2_SIGNING_SECRET.
	EnvSigningSecret = "R2_SIGNING_SECRET"
)

// Config holds everything needed to reach a bucket.
//
// Build it with ConfigFromEnv, or construct it directly when the values come
// from somewhere other than the environment.
type Config struct {
	// AccountID is the Cloudflare account ID, used to derive the S3
	// endpoint. It is ignored when Endpoint is set.
	AccountID string

	// AccessKeyID is the R2 API token's id.
	AccessKeyID string

	// SecretAccessKey is the SHA-256 hash of the R2 API token's value, as
	// issued in the Cloudflare dashboard.
	SecretAccessKey string

	// Bucket is the bucket name.
	Bucket string

	// WorkerURL is the object-store Worker's origin. Optional; SignedURL
	// returns ErrSigningNotConfigured without it.
	WorkerURL string

	// SigningSecret is R2_SIGNING_SECRET. Optional; SignedURL returns
	// ErrSigningNotConfigured without it.
	SigningSecret string

	// Endpoint overrides the derived R2 endpoint. Set it to run against
	// MinIO or another S3 implementation. Optional.
	Endpoint string

	// UsePathStyle addresses buckets as a path segment rather than a
	// subdomain. Required by MinIO, unnecessary for R2. Default false.
	UsePathStyle bool
}

// ConfigFromEnv reads a Config from the R2_* environment variables.
//
// It returns ErrMissingConfig when a required variable is unset, naming every
// one that is missing so a misconfigured deployment fails with one clear
// message instead of a 403 later.
func ConfigFromEnv() (Config, error) {
	cfg := Config{
		AccountID:       strings.TrimSpace(os.Getenv(EnvAccountID)),
		AccessKeyID:     strings.TrimSpace(os.Getenv(EnvAccessKeyID)),
		SecretAccessKey: strings.TrimSpace(os.Getenv(EnvSecretAccessKey)),
		Bucket:          strings.TrimSpace(os.Getenv(EnvBucket)),
		WorkerURL:       strings.TrimSpace(os.Getenv(EnvWorkerURL)),
		SigningSecret:   strings.TrimSpace(os.Getenv(EnvSigningSecret)),
		Endpoint:        strings.TrimSpace(os.Getenv(EnvEndpoint)),
	}

	if raw := strings.TrimSpace(os.Getenv(EnvUsePathStyle)); raw != "" {
		usePathStyle, err := strconv.ParseBool(raw)
		if err != nil {
			return Config{}, fmt.Errorf("r2: %s must be a boolean: %w", EnvUsePathStyle, err)
		}
		cfg.UsePathStyle = usePathStyle
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate reports whether the config can be used to build a Client.
//
// AccountID is only required when Endpoint is unset, since the endpoint is
// otherwise derived from it. WorkerURL and SigningSecret are optional.
func (c Config) Validate() error {
	var missing []string
	if c.AccessKeyID == "" {
		missing = append(missing, EnvAccessKeyID)
	}
	if c.SecretAccessKey == "" {
		missing = append(missing, EnvSecretAccessKey)
	}
	if c.Bucket == "" {
		missing = append(missing, EnvBucket)
	}
	if c.AccountID == "" && c.Endpoint == "" {
		missing = append(missing, EnvAccountID+" (or "+EnvEndpoint+")")
	}
	if len(missing) > 0 {
		return fmt.Errorf("%w: missing %s", ErrMissingConfig, strings.Join(missing, ", "))
	}
	return nil
}

// ResolveEndpoint returns the S3 endpoint the client will talk to: Endpoint
// when set, otherwise the account's R2 endpoint.
func (c Config) ResolveEndpoint() string {
	if c.Endpoint != "" {
		return strings.TrimRight(c.Endpoint, "/")
	}
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", c.AccountID)
}
