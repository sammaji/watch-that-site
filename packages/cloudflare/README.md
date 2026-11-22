# @watchthatsite/cloudflare

A Cloudflare Worker that fronts the `watchthatsite` R2 bucket as a small,
**private** object store, plus a Node client for it.

- The **browser worker** uploads Captures (screenshots) and reads/writes
  Monitor storage state through it, so it never holds R2 credentials.
- The **scheduler** writes `blocks.json.gz`, Change Records and diff images.
  In production it uses the S3 API directly (`packages/cloudflare_go`); in
  local development it can go through this Worker instead (Worker-only mode,
  see [Local development](#local-development)).
- The **web app** never holds the token. It checks that the viewer can see the
  Monitor in a key and redirects to a short-lived [signed URL](#signed-urls).

Nothing is public. Persist object **keys**, never URLs.

## HTTP API

| Method   | Path                              | Auth             | Result                                                           |
| -------- | --------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `PUT`    | `/objects/{key}`                  | bearer           | `201` with the stored object (`url` is always `""`)              |
| `GET`    | `/objects/{key}`                  | bearer or signed | `200` with the bytes, `206` for a `Range`, `304` when unmodified |
| `HEAD`   | `/objects/{key}`                  | bearer or signed | `200` with metadata headers, no body                             |
| `DELETE` | `/objects/{key}`                  | bearer           | `204`, idempotent                                                |
| `GET`    | `/objects?prefix=&cursor=&limit=` | bearer           | `200` with a page of objects                                     |
| `GET`    | `/health`                         | none             | `200 {"ok":true}`                                                |

"bearer" is `Authorization: Bearer $R2_API_TOKEN`. "signed" is a query string
`?exp=<unix seconds>&sig=<hex>`, described under [Signed URLs](#signed-urls).
A read with neither gets `401`. A request that sends an `Authorization`
header is judged on the token alone, even if it also carries a signature.

Errors are JSON: `{ "error": { "code": "...", "message": "..." } }`. The 401
codes are `unauthorized`, `invalid_signature` and `expired_signature`.

### Object keys

Keys are enforced, not free-form. The first UUID is always the Monitor id,
and all UUIDs are lower-case:

| Key                                                    | Content type       | Written by                  |
| ------------------------------------------------------ | ------------------ | --------------------------- |
| `captures/{monitor}/{run}/shot.{png\|webp}`            | `image/png`/`webp` | browser worker              |
| `captures/{monitor}/{run}/learn-{0\|1\|2}.{png\|webp}` | `image/png`/`webp` | browser worker (learning)   |
| `captures/{monitor}/{run}/blocks.json.gz`              | `application/gzip` | scheduler                   |
| `changes/{monitor}/{change}.json.gz`                   | `application/gzip` | scheduler (Change Record)   |
| `changes/{monitor}/{change}-diff.png`                  | `image/png`        | scheduler                   |
| `changes/{monitor}/{change}-crop.png`                  | `image/png`        | scheduler                   |
| `state/{monitor}.json`                                 | `application/json` | browser worker              |
| `steps/{monitor}/{run or macro}/{seq}.webp`            | `image/webp`       | browser worker (step shots) |

A `steps/` key holds the screenshot taken after step `seq` of a Run's trace or
of a Macro recording; `seq` is a non-negative integer written without leading
zeros, and the second UUID is the Run's id or the Macro's.

Anything else, including the old `screenshots/` and `diffs/` layout, is
rejected with `400 invalid_key`. This also rules out path traversal. Build
keys with the helpers (`captureShotKey`, `learnShotKey`, `blocksKey`,
`changeRecordKey`, `changeDiffKey`, `changeCropKey`, `storageStateKey`,
`stepShotKey`), never
by concatenation.

Listing is restricted to the `captures/`, `changes/`, `state/` and `steps/` prefixes.
R2 lifecycle rules for retention target the same prefixes.

### Upload rules

- `Content-Type` must be one of `image/png`, `image/webp`, `application/json`
  or `application/gzip`, **and** must be the one the key implies (table
  above). Otherwise `415`.
- `.json.gz` objects are stored as opaque gzip bytes (`application/gzip`, no
  `Content-Encoding`), so clients get exactly the bytes that were written.
- `Content-Length` is required, because R2 needs a known length to stream a
  body in (`411` otherwise).
- The maximum object size is 25 MiB (`413` otherwise). An empty body is
  rejected with `400`.
- Re-uploading the same key overwrites it, so a retried job is safe.

Bodies are streamed straight into and out of R2. Nothing is buffered in the
Worker.

### Caching

- Bearer reads: `Cache-Control: private, no-store`.
- Signed reads: `Cache-Control: private, max-age=<seconds until exp, capped at 300>`.

There is no public or `immutable` caching. Whatever `Cache-Control` was
stored with an object (for example by an S3 upload) is ignored on read.

## Signed URLs

```
{R2_WORKER_URL}/objects/{key}?exp={unix seconds}&sig={hex}
sig = lowercase hex(HMAC-SHA256(R2_SIGNING_SECRET, key + "\n" + exp))
```

`exp` is a base-10 integer and must be in the future. The key is signed
exactly as it appears in the path. Keys only contain `[a-z0-9./-]`, so
percent-encoding never comes into it.

Three copies of the algorithm exist. A shared test vector pins them together:

| Where                                     | Function                                               |
| ----------------------------------------- | ------------------------------------------------------ |
| `src/shared/signing.ts` (Worker + client) | `objectSignature`, `signObjectUrl`, `signObjectUrlFor` |
| `packages/cloudflare_go/r2/sign.go`       | `r2.Signature`, `r2.Sign`, `Store.SignedURL`           |
| `apps/web/lib/objects.ts`                 | `objectSignature`, `signObjectUrl`                     |

```
key    = changes/8dea949d-d40b-49f6-8f9a-9e31f891eb4e/2136440b-8e77-4a2d-8fe2-fcaea8af11f7.json.gz
secret = wts-test-vector-secret
exp    = 1790000000
sig    = 8930f280ad5550761f7abe127901c6c59d04d4c7004add5819cc21d987e14592
```

TTLs in use: 5 minutes for the web app's `/api/v1/objects/{key}` redirect,
and 7 days for image links in notifications.

### Why `url` is empty

`PUT` and listing still return a `url` field so the response shape is
stable, but it is always `""`. A long-lived link to a private object would be
a leak, and a short-lived one would be stale by the time anything used it.
Store the key. When a URL is needed, sign one at that moment.

## Node client

`@watchthatsite/cloudflare/client` (build with `pnpm build`, output in
`dist/`):

```ts
import {
    captureShotKey,
    createObjectStoreClient,
} from "@watchthatsite/cloudflare/client";

const store = createObjectStoreClient({
    baseUrl: process.env.R2_WORKER_URL!, // http://localhost:8787
    token: process.env.R2_API_TOKEN!,
    signingSecret: process.env.R2_SIGNING_SECRET, // optional, for signedUrl()
});

const key = captureShotKey(monitorId, runId, "webp");
await store.putObject(key, bytes, { contentType: "image/webp" });
const back = await store.getObject(key); // Uint8Array | null
const state = await store.getStorageState(monitorId); // parsed JSON | null
const link = await store.signedUrl(key, 300);
```

| Member                                                                | Notes                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `putObject(key, bytes, { contentType? })`                             | Content type defaults to the key's own                     |
| `getObject(key)`                                                      | Bearer read, `null` on 404                                 |
| `headObject(key)` / `deleteObject(key)`                               | `headObject` is `null` on 404; delete is idempotent        |
| `listObjects(prefix, { cursor?, limit? })`                            | One page                                                   |
| `signedUrl(key, ttlSeconds)`                                          | Needs `signingSecret`; throws `ObjectStoreError` otherwise |
| `uploadCaptureShot(monitorId, runId, bytes, format)`                  | `captures/{m}/{r}/shot.{format}`                           |
| `uploadLearnShot(monitorId, runId, index, bytes, format)`             | `captures/{m}/{r}/learn-{index}.{format}`                  |
| `getStorageState<T>(monitorId)` / `putStorageState(monitorId, state)` | `state/{m}.json`                                           |

Key builders, `parseObjectKey` and the signing functions are re-exported from
the same entry point and from `@watchthatsite/cloudflare/shared`. Network
errors and 5xx are retried (`retries`, default 1). Everything else throws
`ObjectStoreError { status, code }`.

## Local development

```sh
cp .dev.vars.example .dev.vars   # set R2_API_TOKEN and R2_SIGNING_SECRET
pnpm install
pnpm dev                         # wrangler dev on http://localhost:8787
```

`.dev.vars` needs both secrets:

```
R2_API_TOKEN=<any string, shared with the browser worker and scheduler>
R2_SIGNING_SECRET=<openssl rand -hex 32, shared with apps/web and the scheduler>
```

No R2 subscription is needed locally. The bucket named in `wrangler.jsonc` is
simulated by Miniflare and persisted under `.wrangler/state/v3/r2/`. No
command creates a local bucket; the binding alone is enough.

### One bucket locally: Worker-only mode

`wrangler dev`'s simulated bucket is **not** MinIO's bucket. If the browser
worker writes a screenshot through the Worker and the scheduler reads it from
MinIO, the object is not there. To keep one source of truth, run the
scheduler in **Worker-only mode**: set these and leave the S3 credentials
unset:

```sh
R2_WORKER_URL=http://localhost:8787
R2_API_TOKEN=<same as .dev.vars>
R2_SIGNING_SECRET=<same as .dev.vars>
# R2_ACCESS_KEY_ID must be empty; otherwise the S3 client wins
```

`r2.NewStoreFromEnv` then returns a `*r2.WorkerClient` and every read and
write goes through this Worker.

MinIO (`docker compose -f infra/docker-compose.yml --profile storage up -d`,
`R2_ENDPOINT=http://localhost:9000`, `R2_USE_PATH_STYLE=true`) is still
useful for exercising the S3 path. It is a separate bucket, so objects
written there cannot be read through `wrangler dev`.

### Trying it by hand

```sh
TOKEN=... SECRET=...
KEY=captures/$(uuidgen | tr A-Z a-z)/$(uuidgen | tr A-Z a-z)/shot.png

curl -X PUT "http://localhost:8787/objects/$KEY" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/png" \
  --data-binary @shot.png

curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:8787/objects/$KEY"   # 401

EXP=$(( $(date +%s) + 300 ))
SIG=$(printf '%s\n%s' "$KEY" "$EXP" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s "http://localhost:8787/objects/$KEY?exp=$EXP&sig=$SIG" -o out.png          # 200
```

`go run ./cmd/r2ctl sign $KEY` in `packages/cloudflare_go` does the same.
The objects are also visible to the CLI:

```sh
npx wrangler r2 object get "watchthatsite/$KEY" --local --pipe > out.png
```

## Configuration

| Name                   | Kind    | Purpose                                                              |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| `WATCHTHATSITE_BUCKET` | binding | The R2 bucket.                                                       |
| `R2_API_TOKEN`         | secret  | Bearer token for writes, deletes, listing and bearer reads.          |
| `R2_SIGNING_SECRET`    | secret  | HMAC key for signed reads. Must match the web app and the scheduler. |

Set both with `wrangler secret put <NAME>` for a deployment, or in `.dev.vars`
locally. Both are under `secrets.required` in `wrangler.jsonc`, so `wrangler
types` includes them and `wrangler dev` warns when either is missing. The
Worker fails closed with `500 not_configured` if the one it needs is unset.

## Commands

```sh
pnpm test        # vitest, against the local R2 simulation
pnpm typecheck   # tsc --noEmit (Worker and Node client)
pnpm build       # emit dist/ for @watchthatsite/cloudflare/{client,shared}
pnpm cf-typegen  # regenerate worker-configuration.d.ts after binding changes
pnpm deploy      # wrangler deploy
```
