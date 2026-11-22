// Package r2 is the Go side of the watchthatsite object store: key builders,
// signed read URLs, and two interchangeable [Store] implementations.
//
//   - [*Client] talks to Cloudflare R2 (or MinIO) over the S3-compatible API
//     via aws-sdk-go-v2. It is the production path: the Cloudflare REST API
//     is rate limited to 1,200 requests per five minutes account-wide, and the
//     Workers binding API is only reachable from inside a Worker.
//   - [*WorkerClient] reads and writes through the object-store Worker
//     (packages/cloudflare) with its bearer token. It exists for local
//     development: `wrangler dev` simulates its own bucket, which is not the
//     MinIO bucket, so running every service through the Worker gives one
//     source of truth.
//
// [NewStoreFromEnv] picks one (S3 credentials win; see its doc).
//
// # Getting started
//
//	store, err := r2.NewStoreFromEnv(ctx)
//	if err != nil {
//		return err
//	}
//	key, err := r2.ChangeRecordKey(monitorID, changeID)
//	if err != nil {
//		return err
//	}
//	if err := r2.PutJSONGzip(ctx, store, key, record); err != nil {
//		return err
//	}
//	link, err := store.SignedURL(key, 7*24*time.Hour) // for a notification
//
// # Object keys
//
// Keys follow a fixed layout (see [KeyLayout]); the first UUID is always the
// Monitor id:
//
//	captures/{monitor}/{run}/{shot|learn-0|learn-1|learn-2}.{png|webp}
//	captures/{monitor}/{run}/blocks.json.gz
//	changes/{monitor}/{change}.json.gz
//	changes/{monitor}/{change}-diff.png
//	changes/{monitor}/{change}-crop.png
//	state/{monitor}.json
//
// Build them with [CaptureShotKey], [LearnShotKey], [BlocksKey],
// [ChangeRecordKey], [ChangeDiffKey], [ChangeCropKey] and [StorageStateKey];
// never by concatenation. [ParseKey] splits one back into its parts. Every
// key has exactly one content type ([ContentTypeForKey]); both stores and the
// Worker reject a write with any other.
//
// # Private objects and signed URLs
//
// Objects are private. Persist keys, never URLs. A reader without the bearer
// token uses a short-lived signed URL on the object-store Worker:
//
//	{R2_WORKER_URL}/objects/{key}?exp={unix seconds}&sig={hex}
//	sig = hex(HMAC-SHA256(R2_SIGNING_SECRET, key + "\n" + exp))
//
// [Sign] builds one for an explicit expiry, and [Store.SignedURL] for a TTL.
// The algorithm is shared with packages/cloudflare/src/shared/signing.ts and
// apps/web/lib/objects.ts; a common test vector pins them together.
//
// # Errors
//
// A missing object is an error wrapping [ErrNotFound] from both stores. Test
// with errors.Is. Worker failures other than 404 are [*WorkerError].
//
// # Concurrency
//
// [*Client] and [*WorkerClient] are safe for concurrent use and are meant to
// be built once and shared. R2 limits writes to a single key to one per
// second; the key layout embeds a run or change id, so distinct writes use
// distinct keys (state/{monitor}.json is the exception and is written rarely).
package r2
