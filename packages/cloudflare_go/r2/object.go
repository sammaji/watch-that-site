package r2

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// MaxObjectBytes caps the size of an object read fully into memory by
// Download. Streaming reads via DownloadStream are not capped.
const MaxObjectBytes = 25 << 20 // 25 MiB

// deleteBatchSize is the maximum number of keys per DeleteObjects request,
// fixed by the S3 API.
const deleteBatchSize = 1000

// Object is the metadata of a stored object.
type Object struct {
	// Key is the object key.
	Key string

	// Size is the object size in bytes.
	Size int64

	// ETag is the entity tag, without surrounding quotes.
	ETag string

	// ContentType is the stored MIME type, empty when none was recorded.
	ContentType string

	// LastModified is when the object was last written.
	LastModified time.Time
}

// UploadOptions tunes a single upload. A nil *UploadOptions means defaults.
type UploadOptions struct {
	// ContentType is the MIME type to store. Default: guessed from the key's
	// extension.
	ContentType string

	// CacheControl is stored with the object. Default: none. The
	// object-store Worker ignores it and sets its own (objects are private).
	CacheControl string

	// Metadata is stored as user metadata alongside the object. Keys are
	// lower-cased by the S3 API. Default: none.
	Metadata map[string]string
}

// DefaultUploadOptions returns the options used when nil is passed.
func DefaultUploadOptions() *UploadOptions {
	return &UploadOptions{}
}

// ListOptions tunes a listing. A nil *ListOptions means defaults.
type ListOptions struct {
	// Limit is the maximum number of objects to return in one page.
	// Default 1000, which is also the maximum the S3 API will return.
	Limit int32

	// Cursor continues a previous listing. Pass Listing.Cursor. Default: start
	// from the beginning.
	Cursor string
}

// Listing is one page of objects.
type Listing struct {
	// Objects are the objects in this page, ordered lexicographically by key.
	Objects []Object

	// Cursor continues the listing, or "" when there are no more pages.
	Cursor string

	// Truncated reports whether more pages follow.
	Truncated bool
}

// Upload stores data under key and returns the resulting object.
//
// An existing object at the same key is replaced, which makes a retried job
// safe to re-run. The key is validated first, so a malformed key never
// reaches the bucket.
func (c *Client) Upload(ctx context.Context, key string, data []byte, opts *UploadOptions) (*Object, error) {
	return c.UploadReader(ctx, key, bytes.NewReader(data), int64(len(data)), opts)
}

// UploadReader is Upload for a streamed body.
//
// size must be the exact byte length of body: the S3 API requires a known
// content length, and an unseekable reader cannot supply one on its own.
func (c *Client) UploadReader(ctx context.Context, key string, body io.Reader, size int64, opts *UploadOptions) (*Object, error) {
	if err := validateKey(key); err != nil {
		return nil, err
	}
	if size < 0 {
		return nil, fmt.Errorf("r2: upload %q: size must not be negative", key)
	}
	if opts == nil {
		opts = DefaultUploadOptions()
	}

	contentType := opts.ContentType
	if contentType == "" {
		contentType = ContentTypeForKey(key)
	} else if want := ContentTypeForKey(key); contentType != want {
		// The object-store Worker enforces the same rule, so both Store
		// implementations accept exactly the same writes.
		return nil, fmt.Errorf("%w: %q must be stored as %s, got %s", ErrInvalidKey, key, want, contentType)
	}
	input := &s3.PutObjectInput{
		Bucket:        aws.String(c.bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentLength: aws.Int64(size),
		ContentType:   aws.String(contentType),
	}
	if opts.CacheControl != "" {
		input.CacheControl = aws.String(opts.CacheControl)
	}
	if len(opts.Metadata) > 0 {
		input.Metadata = opts.Metadata
	}

	out, err := c.s3.PutObject(ctx, input)
	if err != nil {
		return nil, fmt.Errorf("r2: upload %q: %w", key, mapError(err))
	}

	return &Object{
		Key:          key,
		Size:         size,
		ETag:         trimETag(out.ETag),
		ContentType:  contentType,
		LastModified: time.Now().UTC(),
	}, nil
}

// Download reads an object fully into memory.
//
// It returns ErrNotFound when the key does not exist, and ErrTooLarge when
// the object exceeds MaxObjectBytes. Use DownloadStream for larger objects.
func (c *Client) Download(ctx context.Context, key string) ([]byte, *Object, error) {
	body, obj, err := c.DownloadStream(ctx, key)
	if err != nil {
		return nil, nil, err
	}
	defer body.Close()

	if obj.Size > MaxObjectBytes {
		return nil, nil, fmt.Errorf("r2: download %q: %w (%d bytes)", key, ErrTooLarge, obj.Size)
	}

	// Read one byte past the cap so a mis-reported Content-Length cannot
	// smuggle in an oversized body.
	data, err := io.ReadAll(io.LimitReader(body, MaxObjectBytes+1))
	if err != nil {
		return nil, nil, fmt.Errorf("r2: download %q: %w", key, err)
	}
	if int64(len(data)) > MaxObjectBytes {
		return nil, nil, fmt.Errorf("r2: download %q: %w", key, ErrTooLarge)
	}
	return data, obj, nil
}

// DownloadStream opens an object for reading. The caller must close the
// returned reader.
func (c *Client) DownloadStream(ctx context.Context, key string) (io.ReadCloser, *Object, error) {
	if err := validateKey(key); err != nil {
		return nil, nil, err
	}

	out, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, nil, fmt.Errorf("r2: download %q: %w", key, mapError(err))
	}

	return out.Body, &Object{
		Key:          key,
		Size:         aws.ToInt64(out.ContentLength),
		ETag:         trimETag(out.ETag),
		ContentType:  aws.ToString(out.ContentType),
		LastModified: aws.ToTime(out.LastModified),
	}, nil
}

// Head returns an object's metadata without transferring its body. It returns
// ErrNotFound when the key does not exist.
func (c *Client) Head(ctx context.Context, key string) (*Object, error) {
	if err := validateKey(key); err != nil {
		return nil, err
	}

	out, err := c.s3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("r2: head %q: %w", key, mapError(err))
	}

	return &Object{
		Key:          key,
		Size:         aws.ToInt64(out.ContentLength),
		ETag:         trimETag(out.ETag),
		ContentType:  aws.ToString(out.ContentType),
		LastModified: aws.ToTime(out.LastModified),
	}, nil
}

// Exists reports whether an object is stored at key. A missing object is not
// an error.
func (c *Client) Exists(ctx context.Context, key string) (bool, error) {
	if _, err := c.Head(ctx, key); err != nil {
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Delete removes an object. Deleting a key that does not exist is not an
// error, so the call is safe to retry.
func (c *Client) Delete(ctx context.Context, key string) error {
	if err := validateKey(key); err != nil {
		return err
	}

	if _, err := c.s3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	}); err != nil {
		return fmt.Errorf("r2: delete %q: %w", key, mapError(err))
	}
	return nil
}

// DeleteAll removes many objects, batching them into the largest requests the
// S3 API accepts. Deleting an empty slice is a no-op.
func (c *Client) DeleteAll(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	for _, key := range keys {
		if err := validateKey(key); err != nil {
			return err
		}
	}

	for start := 0; start < len(keys); start += deleteBatchSize {
		end := min(start+deleteBatchSize, len(keys))

		identifiers := make([]types.ObjectIdentifier, 0, end-start)
		for _, key := range keys[start:end] {
			identifiers = append(identifiers, types.ObjectIdentifier{Key: aws.String(key)})
		}

		out, err := c.s3.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(c.bucket),
			Delete: &types.Delete{Objects: identifiers, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return fmt.Errorf("r2: delete %d objects: %w", end-start, mapError(err))
		}
		if len(out.Errors) > 0 {
			first := out.Errors[0]
			return fmt.Errorf("r2: delete %q: %s: %s",
				aws.ToString(first.Key), aws.ToString(first.Code), aws.ToString(first.Message))
		}
	}
	return nil
}

// List returns one page of objects under prefix.
//
// Pass Listing.Cursor back through ListOptions to page through the rest. A
// prefix built with MonitorPrefix lists one Monitor's objects under a prefix.
func (c *Client) List(ctx context.Context, prefix string, opts *ListOptions) (*Listing, error) {
	if opts == nil {
		opts = &ListOptions{}
	}

	input := &s3.ListObjectsV2Input{
		Bucket: aws.String(c.bucket),
		Prefix: aws.String(prefix),
	}
	if opts.Limit > 0 {
		input.MaxKeys = aws.Int32(opts.Limit)
	}
	if opts.Cursor != "" {
		input.ContinuationToken = aws.String(opts.Cursor)
	}

	out, err := c.s3.ListObjectsV2(ctx, input)
	if err != nil {
		return nil, fmt.Errorf("r2: list %q: %w", prefix, mapError(err))
	}

	objects := make([]Object, 0, len(out.Contents))
	for _, item := range out.Contents {
		key := aws.ToString(item.Key)
		objects = append(objects, Object{
			Key:          key,
			Size:         aws.ToInt64(item.Size),
			ETag:         trimETag(item.ETag),
			LastModified: aws.ToTime(item.LastModified),
		})
	}

	truncated := aws.ToBool(out.IsTruncated)
	listing := &Listing{Objects: objects, Truncated: truncated}
	if truncated {
		listing.Cursor = aws.ToString(out.NextContinuationToken)
	}
	return listing, nil
}

// ListAll pages through every object under prefix and returns them together.
// Prefer List when a prefix could hold a very large number of objects.
func (c *Client) ListAll(ctx context.Context, prefix string) ([]Object, error) {
	var all []Object
	opts := &ListOptions{}
	for {
		page, err := c.List(ctx, prefix, opts)
		if err != nil {
			return nil, err
		}
		all = append(all, page.Objects...)
		if !page.Truncated {
			return all, nil
		}
		opts.Cursor = page.Cursor
	}
}

// validateKey rejects keys that do not match the enforced layout, so a
// malformed key fails locally instead of creating a stray object.
func validateKey(key string) error {
	if !ValidKey(key) {
		return fmt.Errorf("%w: %q does not match %s", ErrInvalidKey, key, KeyLayout)
	}
	return nil
}

// mapError normalises "no such object" into ErrNotFound. GetObject reports it
// as NoSuchKey and HeadObject as NotFound, and some S3 implementations only
// set the API error code, so all three are checked.
func mapError(err error) error {
	var noSuchKey *types.NoSuchKey
	if errors.As(err, &noSuchKey) {
		return ErrNotFound
	}
	var notFound *types.NotFound
	if errors.As(err, &notFound) {
		return ErrNotFound
	}

	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NoSuchKey", "NotFound", "404":
			return ErrNotFound
		}
	}
	return err
}

// trimETag strips the quotes the S3 API wraps around entity tags.
func trimETag(etag *string) string {
	return strings.Trim(aws.ToString(etag), `"`)
}
