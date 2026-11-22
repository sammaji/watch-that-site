package r2

import (
	"errors"
	"strings"
	"testing"
)

// setValidEnv populates the minimum required variables for ConfigFromEnv.
func setValidEnv(t *testing.T) {
	t.Helper()
	t.Setenv(EnvAccountID, "abc123")
	t.Setenv(EnvAccessKeyID, "key")
	t.Setenv(EnvSecretAccessKey, "secret")
	t.Setenv(EnvBucket, "watchthatsite")
	t.Setenv(EnvWorkerURL, "")
	t.Setenv(EnvSigningSecret, "")
	t.Setenv(EnvEndpoint, "")
	t.Setenv(EnvUsePathStyle, "")
}

func TestConfigFromEnvReadsEveryVariable(t *testing.T) {
	setValidEnv(t)
	t.Setenv(EnvWorkerURL, "http://localhost:8787")
	t.Setenv(EnvSigningSecret, "sign")
	t.Setenv(EnvEndpoint, "http://localhost:9000")
	t.Setenv(EnvUsePathStyle, "true")

	cfg, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv returned error: %v", err)
	}
	want := Config{
		AccountID:       "abc123",
		AccessKeyID:     "key",
		SecretAccessKey: "secret",
		Bucket:          "watchthatsite",
		WorkerURL:       "http://localhost:8787",
		SigningSecret:   "sign",
		Endpoint:        "http://localhost:9000",
		UsePathStyle:    true,
	}
	if cfg != want {
		t.Errorf("got = %+v, want %+v", cfg, want)
	}
}

func TestConfigFromEnvTrimsWhitespace(t *testing.T) {
	setValidEnv(t)
	t.Setenv(EnvBucket, "  watchthatsite  ")

	cfg, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("ConfigFromEnv returned error: %v", err)
	}
	if cfg.Bucket != "watchthatsite" {
		t.Errorf("got = %q, want %q", cfg.Bucket, "watchthatsite")
	}
}

func TestConfigFromEnvNamesEveryMissingVariable(t *testing.T) {
	t.Setenv(EnvAccountID, "")
	t.Setenv(EnvAccessKeyID, "")
	t.Setenv(EnvSecretAccessKey, "")
	t.Setenv(EnvBucket, "")
	t.Setenv(EnvWorkerURL, "")
	t.Setenv(EnvEndpoint, "")
	t.Setenv(EnvUsePathStyle, "")

	_, err := ConfigFromEnv()
	if err == nil {
		t.Fatal("got = nil error, want ErrMissingConfig")
	}
	if !errors.Is(err, ErrMissingConfig) {
		t.Fatalf("got = %v, want ErrMissingConfig", err)
	}
	for _, name := range []string{EnvAccessKeyID, EnvSecretAccessKey, EnvBucket, EnvAccountID} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q does not name %s", err, name)
		}
	}
}

func TestConfigFromEnvRejectsANonBooleanPathStyle(t *testing.T) {
	setValidEnv(t)
	t.Setenv(EnvUsePathStyle, "yes-please")

	if _, err := ConfigFromEnv(); err == nil {
		t.Error("got = nil error, want a parse failure")
	}
}

func TestValidateAcceptsAnEndpointInsteadOfAnAccountID(t *testing.T) {
	cfg := Config{
		AccessKeyID:     "key",
		SecretAccessKey: "secret",
		Bucket:          "watchthatsite",
		Endpoint:        "http://localhost:9000",
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("got = %v, want nil", err)
	}
}

func TestValidateTreatsWorkerSettingsAsOptional(t *testing.T) {
	cfg := Config{
		AccountID:       "abc123",
		AccessKeyID:     "key",
		SecretAccessKey: "secret",
		Bucket:          "watchthatsite",
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("got = %v, want nil", err)
	}
}

func TestResolveEndpoint(t *testing.T) {
	derived := Config{AccountID: "abc123"}.ResolveEndpoint()
	if want := "https://abc123.r2.cloudflarestorage.com"; derived != want {
		t.Errorf("got = %v, want %v", derived, want)
	}

	overridden := Config{AccountID: "abc123", Endpoint: "http://localhost:9000/"}.ResolveEndpoint()
	if want := "http://localhost:9000"; overridden != want {
		t.Errorf("got = %v, want %v", overridden, want)
	}
}
