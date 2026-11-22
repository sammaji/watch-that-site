package r2

import "errors"

var (
	// ErrNotFound is returned when an object does not exist. Both Store
	// implementations report it, wrapped, for reads and metadata lookups.
	ErrNotFound = errors.New("r2: object not found")

	// ErrInvalidKey is returned when a key does not match KeyLayout.
	ErrInvalidKey = errors.New("r2: invalid object key")

	// ErrMissingConfig is returned when a required setting is empty. The
	// wrapped message names the offending variables.
	ErrMissingConfig = errors.New("r2: incomplete configuration")

	// ErrSigningNotConfigured is returned by SignedURL when R2_WORKER_URL or
	// R2_SIGNING_SECRET is not set. Signed URLs always point at the
	// object-store Worker, the only read path for private objects.
	ErrSigningNotConfigured = errors.New("r2: signed URLs need R2_WORKER_URL and R2_SIGNING_SECRET")

	// ErrTooLarge is returned when an object exceeds MaxObjectBytes.
	ErrTooLarge = errors.New("r2: object exceeds maximum size")
)
