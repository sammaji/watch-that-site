package r2

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// region is required by the AWS SDK but ignored by R2, which aliases "auto",
// "" and "us-east-1" to the same place.
const region = "auto"

// Client reads and writes objects in one bucket.
//
// Build one with New or NewFromEnv and share it; it is safe for concurrent
// use and holds a pooled HTTP client underneath.
type Client struct {
	s3            *s3.Client
	bucket        string
	workerURL     string
	signingSecret string
}

var _ Store = (*Client)(nil)

// New builds a Client from cfg.
//
// It validates cfg first, so a blank or half-filled configuration fails here
// with ErrMissingConfig rather than at the first request.
func New(ctx context.Context, cfg Config) (*Client, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	workerURL := strings.TrimRight(cfg.WorkerURL, "/")
	if workerURL != "" {
		if _, err := url.Parse(workerURL); err != nil {
			return nil, fmt.Errorf("r2: %s is not a valid URL: %w", EnvWorkerURL, err)
		}
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		),
		// R2 does not implement the checksum headers newer SDK versions send
		// by default, and sending them has broken uploads before. Restricting
		// them to operations that genuinely require one keeps this client
		// working against R2 and MinIO alike.
		awsconfig.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
		awsconfig.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
	)
	if err != nil {
		return nil, fmt.Errorf("r2: load aws config: %w", err)
	}

	endpoint := cfg.ResolveEndpoint()
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = cfg.UsePathStyle
	})

	return &Client{
		s3:            client,
		bucket:        cfg.Bucket,
		workerURL:     workerURL,
		signingSecret: cfg.SigningSecret,
	}, nil
}

// NewFromEnv builds a Client from the R2_* environment variables.
func NewFromEnv(ctx context.Context) (*Client, error) {
	cfg, err := ConfigFromEnv()
	if err != nil {
		return nil, err
	}
	return New(ctx, cfg)
}

// Bucket returns the bucket this client is bound to.
func (c *Client) Bucket() string { return c.bucket }

// S3 exposes the underlying SDK client for operations this package does not
// wrap, such as multipart uploads or bucket configuration.
func (c *Client) S3() *s3.Client { return c.s3 }

// Put implements Store. The key is validated and contentType defaults to the
// key's own (see ContentTypeForKey) when empty.
func (c *Client) Put(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := c.Upload(ctx, key, data, &UploadOptions{ContentType: contentType})
	return err
}

// Get implements Store. A missing object is an error wrapping ErrNotFound.
func (c *Client) Get(ctx context.Context, key string) ([]byte, error) {
	data, _, err := c.Download(ctx, key)
	return data, err
}

// SignedURL implements Store. The URL points at the object-store Worker
// (R2_WORKER_URL), not at the bucket: objects are private and the Worker is
// the only read path. Note that in S3 mode the Worker must be bound to the
// same bucket this client writes to.
func (c *Client) SignedURL(key string, ttl time.Duration) (string, error) {
	return signedURL(c.workerURL, c.signingSecret, key, ttl)
}
