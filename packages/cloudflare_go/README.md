# cloudflare_go

The Go side of the watchthatsite object store: key builders, signed read URLs,
and two interchangeable `Store` implementations.

```go
import "github.com/sammaji/watchthatsite/packages/cloudflare_go/r2"
```

| Store             | Talks to                                             | Use                                                    |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `*r2.Client`      | R2 (or MinIO) over the S3 API, via `aws-sdk-go-v2`   | Production                                             |
| `*r2.WorkerClient`| The object-store Worker (`packages/cloudflare`) over HTTP with the bearer token | Local development: one bucket for everyone |

## Why the S3 API in production

R2 has three access paths, and only one suits a background service:

| Path | Verdict |
| ---- | ------- |
| Cloudflare REST API (`cloudflare-go`) | Rate limited to **1,200 requests per 5 minutes account-wide**, shared with the dashboard and `wrangler`. Going over blocks *all* Cloudflare API calls for five minutes. |
| Workers binding API | Only reachable from inside a Worker. `WorkerClient` reaches it indirectly, through our Worker. |
| **S3-compatible API** | No comparable limit. Portable to MinIO and AWS S3. |

## Quick start

```go
store, err := r2.NewStoreFromEnv(ctx)
if err != nil {
    return err
}

key, err := r2.ChangeRecordKey(monitorID, changeID)
if err != nil {
    return err
}
if err := r2.PutJSONGzip(ctx, store, key, record); err != nil {
    return err
}

var back ChangeRecord
if err := r2.GetJSONGzip(ctx, store, key, &back); errors.Is(err, r2.ErrNotFound) {
    // not written yet
}

link, err := store.SignedURL(diffKey, 7*24*time.Hour) // e.g. a notification image
```

## API

```go
type Store interface {
    Put(ctx context.Context, key string, data []byte, contentType string) error // "" = the key's own type
    Get(ctx context.Context, key string) ([]byte, error)                        // missing → wraps ErrNotFound
    Delete(ctx context.Context, key string) error                               // idempotent
    SignedURL(key string, ttl time.Duration) (string, error)                    // points at R2_WORKER_URL
}
```

**Construction.** `NewStoreFromEnv(ctx)` picks a store (see below).
`New(ctx, Config)` / `NewFromEnv(ctx)` build the S3 client, and
`NewWorkerClient(WorkerConfig{BaseURL, Token, SigningSecret, HTTPClient})` /
`WorkerConfigFromEnv()` build the Worker client. Both are safe for concurrent
use: build one and share it.

**Helpers.** `PutJSONGzip` / `GetJSONGzip` handle `blocks.json.gz` and Change
Records. `PutJSON` / `GetJSON` handle `state/{m}.json`.

**Keys.** `CaptureShotKey(m, r, format)`, `LearnShotKey(m, r, i, format)`,
`BlocksKey(m, r)`, `ChangeRecordKey(m, c)`, `ChangeDiffKey(m, c)`,
`ChangeCropKey(m, c)` and `StorageStateKey(m)` build keys. `ParseKey(key)`
returns a `Key` with `Prefix`, `Kind`, `MonitorID`, `RunID`/`ChangeID`,
`LearnIndex` and `ContentType`. Also available: `ValidKey`, `MonitorPrefix`
and `ContentTypeForKey`.

**Signing.** `Signature(secret, key, exp)` and `Sign(baseURL, secret, key, exp)`.

**S3-only extras on `*Client`.** `Upload`, `UploadReader`, `Download`,
`DownloadStream`, `Head`, `Exists`, `DeleteAll`, `List`, `ListAll` and `S3()`.

**Errors.** `ErrNotFound`, `ErrInvalidKey`, `ErrMissingConfig`,
`ErrSigningNotConfigured` and `ErrTooLarge` (test with `errors.Is`), plus
`*WorkerError{Status, Code, Message}` for other Worker failures.

## Object keys

```
captures/{monitor}/{run}/{shot|learn-0|learn-1|learn-2}.{png|webp}   image/png | image/webp
captures/{monitor}/{run}/blocks.json.gz                               application/gzip
changes/{monitor}/{change}.json.gz                                    application/gzip
changes/{monitor}/{change}-diff.png                                   image/png
changes/{monitor}/{change}-crop.png                                   image/png
state/{monitor}.json                                                  application/json
```

UUIDs are lower-case (the builders lower-case their input), and the first one
is always the Monitor id. Each key has exactly one content type. Both stores
reject a write with a different type before making a request, and so does the
Worker. This mirrors `packages/cloudflare/src/shared/keys.ts`; keep them in
sync.

## Signed URLs

Objects are private. Store keys, never URLs. A reader without the token uses a
signed URL on the Worker:

```
{R2_WORKER_URL}/objects/{key}?exp={unix seconds}&sig={hex}
sig = hex(HMAC-SHA256(R2_SIGNING_SECRET, key + "\n" + exp))
```

`SignedURL` on **both** stores points at the Worker, because the Worker is the
only read path for private objects. In S3 mode the Worker must therefore be
bound to the same bucket that `*Client` writes to, which is true in
production. `sign_test.go` holds a test vector that also appears in the
Worker's `test/signing.test.ts`.

## Configuration and store selection

`NewStoreFromEnv` chooses a store in this order:

1. **`R2_ACCESS_KEY_ID` set** → S3 `*Client`. This also requires
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and either `R2_ACCOUNT_ID` or
   `R2_ENDPOINT`. `SignedURL` additionally needs `R2_WORKER_URL` and
   `R2_SIGNING_SECRET`.
2. **otherwise, `R2_WORKER_URL` set** → `*WorkerClient` (Worker-only mode).
   `R2_API_TOKEN` is required. `R2_SIGNING_SECRET` is needed for `SignedURL`.
3. **neither** → `ErrMissingConfig`.

| Variable | Used by | Purpose |
| -------- | ------- | ------- |
| `R2_ACCOUNT_ID` | S3 | Derives the S3 endpoint (unless `R2_ENDPOINT` is set) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | S3 | R2 API token id / SHA-256 of its value |
| `R2_BUCKET` | S3 | Bucket name |
| `R2_ENDPOINT` / `R2_USE_PATH_STYLE` | S3 | MinIO: `http://localhost:9000` / `true` |
| `R2_WORKER_URL` | both | Worker origin; target of signed URLs; Worker-only mode |
| `R2_API_TOKEN` | Worker | Bearer token |
| `R2_SIGNING_SECRET` | both | HMAC key for signed URLs |

## Local development

**Worker-only (recommended).** Run the Worker with `pnpm --filter
@watchthatsite/cloudflare dev` (port 8787, `.dev.vars` holding
`R2_API_TOKEN` and `R2_SIGNING_SECRET`), then:

```sh
export R2_WORKER_URL=http://localhost:8787
export R2_API_TOKEN=<same as .dev.vars>
export R2_SIGNING_SECRET=<same as .dev.vars>
unset R2_ACCESS_KEY_ID
```

Every service now shares the Worker's simulated bucket.

**MinIO (S3 path).** Use this only to exercise `*Client`. It is a
**different bucket** from `wrangler dev`'s.

```sh
docker compose -f infra/docker-compose.yml --profile storage up -d watchthatsite-minio
export R2_ENDPOINT=http://localhost:9000
export R2_USE_PATH_STYLE=true
export R2_ACCESS_KEY_ID=$MINIO_ROOT_USER          # default minioadmin
export R2_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD  # default minioadmin
export R2_BUCKET=watchthatsite
```

The console is at http://localhost:9001.

## Tests

```sh
go test ./...          # unit tests; integration tests skip without config
go test -race ./...
go vet ./...
```

The unit tests need no credentials. `WorkerClient` is tested against an
in-process fake of the Worker. The integration tests run against whatever the
environment points at:

```sh
go test ./r2/ -run Integration -v                    # S3 tests: MinIO or a real bucket (creates the bucket)
R2_WORKER_URL=http://localhost:8787 R2_API_TOKEN=... R2_SIGNING_SECRET=... \
  go test ./r2/ -run TestIntegrationWorkerClient -v  # against a running wrangler dev
```

`go test -short` skips them explicitly.

## r2ctl

A CLI for manual checks. It picks its store like `NewStoreFromEnv`.

```sh
go run ./cmd/r2ctl key  shot <monitor> <run> webp
go run ./cmd/r2ctl put  captures/<m>/<r>/shot.webp shot.webp
go run ./cmd/r2ctl get  captures/<m>/<r>/shot.webp out.webp
go run ./cmd/r2ctl sign captures/<m>/<r>/shot.webp 5m
go run ./cmd/r2ctl rm   captures/<m>/<r>/shot.webp
go run ./cmd/r2ctl head captures/<m>/<r>/shot.webp   # S3 mode only
go run ./cmd/r2ctl ls   captures/<m>/                # S3 mode only
```

## Notes

- `RequestChecksumCalculation` is pinned to `WhenRequired`. The checksum
  headers that newer AWS SDKs send by default broke R2 uploads in early 2025.
  Pinning removes that failure class for R2 and MinIO alike.
- `GetObject` reports a missing object as `NoSuchKey`, and `HeadObject` as
  `NotFound`. Both, plus the raw API codes, are normalised to `ErrNotFound`.
  The Worker's 404 is normalised the same way.
- `WorkerClient` retries once on a transport error or a 5xx. Every operation
  is idempotent.
- R2 limits writes to a single key to one per second. Run and change ids keep
  keys distinct. `state/{m}.json` is written rarely.
