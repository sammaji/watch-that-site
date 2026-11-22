# proxy

HTTP reverse proxy that fetches external URLs and rewrites HTML/CSS so all assets load back through itself. Used to render live previews of third-party sites inside the WatchThatSite UI.

## What it does

- Proxies any `http`/`https` URL via `/v1/proxy/:scheme/:host/*path`
- Rewrites document asset URLs to `/api/v1/proxy/:scheme/:host/*path` for the web app
- Rewrites HTML — rewrites `src`, `href`, `action`, `srcset`, CSS `url()` refs — so the page stays self-contained
- Strips CSP and `X-Frame-Options` headers that would block iframe embedding
- Injects a runtime script (`runtime.html`) for visual selection and preview-ready messaging
- Requires `x-api-key` on every route, matched against `PROXY_API_KEY` (skip with `DISABLE_AUTH=true`)
- SSRF guard: blocks requests to loopback, RFC1918, and link-local addresses (disable with `ALLOW_PRIVATE_TARGETS=true`)
- Passes through non-HTML/CSS responses unchanged

## Routes

| Method | Path                                        | Description     |
| ------ | ------------------------------------------- | --------------- |
| `GET`  | `/health`                                   | Liveness check  |
| `*`    | `/v1/proxy/:scheme/:host/*path`             | Short alias     |

All routes require the `x-api-key` header unless `DISABLE_AUTH=true`.

## Config

| Env var                 | Default | Description                            |
| ----------------------- | ------- | -------------------------------------- |
| `ADDR`                  | `:8080` | Listen address                         |
| `PROXY_API_KEY`         | none    | Required API key for `x-api-key` auth  |
| `DISABLE_AUTH`          | `false` | Disable API key auth entirely          |
| `ALLOW_PRIVATE_TARGETS` | `false` | Allow proxying to private/loopback IPs |

## Run

```bash
PROXY_API_KEY=secret go run .
# or
ADDR=:9000 PROXY_API_KEY=secret go run .
```

## Build

```bash
go build -o proxy .
```

## Stack

- [fasthttp](https://github.com/valyala/fasthttp) + [fasthttprouter](https://github.com/buaazp/fasthttprouter) — HTTP server
- [golang.org/x/net/html](https://pkg.go.dev/golang.org/x/net/html) — HTML parse/rewrite
- [sonic](https://github.com/bytedance/sonic) — JSON encoding
