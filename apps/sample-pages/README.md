# Sample Pages

Small Next.js app with a few intentionally dynamic pages for local testing.

## Run Locally

From `apps/sample-pages`:

```bash
pnpm dev
```

The app runs on `http://localhost:3003`.

## Routes

- `/blog`: blog sample
- `/shop`: ecommerce sample
- `/careers`: job listings sample
- `/finances`: table sample
- `/test/diff/*`: controllable fixtures for the diffing E2E suite (see [Diffing fixtures](#diffing-fixtures))

## How Refresh Behavior Works

These pages are server-rendered with `dynamic = "force-dynamic"` and generate deterministic fake data from the current time.

Each page supports query params that override the refresh interval for parts of the page. This makes it easier to test visual and content changes locally without editing code.

All interval values are in milliseconds.

If a value is missing, invalid, or less than or equal to `0`, the page falls back to its default interval.

## Query Params

### Blog

Route: `/blog`

Params:

- `content_refresh_interval`: refresh interval for the blog content
- `color_refresh_interval`: refresh interval for the subscribe button color

Notes:

- `content_refresh_interval` drives both blog paragraphs.
- The volatile paragraph changes every content interval.
- The stable paragraph keeps most of its text stable for a longer derived window, but still uses the same query param as its base interval.

Example:

```text
/blog?content_refresh_interval=1000&color_refresh_interval=2000
```

Defaults:

- `content_refresh_interval=3600000` (1 hour)
- `color_refresh_interval=900000` (15 minutes)

### Shop

Route: `/shop`

Params:

- `price_refresh_interval`: refresh interval for product prices
- `checkout_refresh_interval`: refresh interval for checkout enabled/disabled state

Example:

```text
/shop?price_refresh_interval=1000&checkout_refresh_interval=5000
```

Defaults:

- `price_refresh_interval=60000` (1 minute)
- `checkout_refresh_interval=3600000` (1 hour)

### Careers

Route: `/careers`

Params:

- `title_refresh_interval`: refresh interval for rotating job titles

Notes:

- Every third job listing gets a rotating title.
- The other listings remain fixed.

Example:

```text
/careers?title_refresh_interval=1000
```

Default:

- `title_refresh_interval=86400000` (24 hours)

### Finances

Route: `/finances`

Params:

- `amount_refresh_interval`: refresh interval for amounts
- `profit_refresh_interval`: refresh interval for profit percentages and sparklines

Example:

```text
/finances?amount_refresh_interval=1000&profit_refresh_interval=2000
```

Defaults:

- `amount_refresh_interval=3600000` (1 hour)
- `profit_refresh_interval=900000` (15 minutes)

## Implementation Notes

- Query parsing is handled server-side with `nuqs`.
- Shared query param loaders live in `lib/refresh-params.ts`.
- Page-specific fake data generators live in `lib/`.
- The query params only change data generation timing; they do not add client-side polling or auto-refresh.

## Local Testing Tips

- Reload the page manually to observe new server-rendered values.
- Use very small intervals like `1000` or `2000` while testing.
- Compare snapshots or recordings across reloads to verify the intended parts of the page are changing.

## Diffing fixtures

Routes under `/test/diff/*` are the fixtures for the diffing pipeline E2E suite (`tests/diffing`, plan §3.0 and §3.3). Each page is a `force-dynamic` server component (or route handler) with deterministic markup: a fixed 960 px column, system fonts only (Arial), no network assets and no random data. The only time-dependent fixture is `volatile`.

### Variant state

The variant is kept server-side, so a Monitor's URL never changes while a test flips variants. The state lives in a `Map` on `globalThis` (`lib/diff-state.ts`), shared by pages and route handlers in the same Node process. It resets when the dev server restarts.

`/test/api/diff-state`:

| Method | Request | Response |
|---|---|---|
| `POST` | JSON `{"scenario": "pricing", "variant": "v2"}` | `{"scenario", "variant"}`. 404 for an unknown scenario, 400 for an unknown variant (the body lists the valid ones) |
| `GET` | `?scenario=pricing` | `{"scenario", "variant"}` |
| `GET` | no query | `{"variants": {scenario: variant}, "scenarios": {scenario: [variants]}}` |
| `DELETE` | none | Resets every scenario to its first variant. Returns `{"variants"}` |

```bash
curl -X POST localhost:3003/test/api/diff-state -d '{"scenario":"pricing","variant":"v2"}'
curl 'localhost:3003/test/api/diff-state?scenario=pricing'
curl -X DELETE localhost:3003/test/api/diff-state
```

The first variant listed for each scenario below is its default.

### Routes

| Route | Scenario key | Variants | What changes |
|---|---|---|---|
| `/test/diff/pricing` | `pricing` | `v1`, `v2`, `v3`, `e1`–`e5` | `v1`: plan rows Starter $19, **Pro $49** (`li#plan-pro`), Business $99. `v2`: Pro $59. `v3`: Pro $59 plus an `li#plan-enterprise` row ("Enterprise $299 per month…"). `e1`–`e5`: v1 prices, and the intro paragraph (`#pricing-intro`) gains exactly one word per step: "Pick a plan that fits your team." → "…your growing team." → "…growing team quickly." → "Pick a simple plan…" → "…your whole growing team…" → "Pick a simple monthly plan…" |
| `/test/diff/volatile` | `volatile` | `v1` (any) | Every request renders the UTC clock ("Updated at 14:03:22 UTC"), "Posted N minutes ago", "N,NNN views" (changes every second), a `/static/app.css?ver=<unix seconds>` link text, and a rotating banner "Featured product: <name>" (`#promo-banner`) picked from 7 product names by `Date.now()`, never the same twice in a row. The banner matches no volatile-token pattern, so only the learning pass can silence it |
| `/test/diff/list` | `list` | `v1`, `v2`, `v3` | `v1`: items A–J (`li#item-a` …). `v2`: the same ten items reordered, identical text. `v3`: `v2` plus "Item K: Koa wood cheese board" at the end |
| `/test/diff/cookie` | `cookie` | `v1`, `v2` | Always renders a fixed OneTrust banner with the real markup (`#onetrust-consent-sdk`, `#onetrust-banner-sdk.optanon-alert-box-wrapper`, `#onetrust-policy-text` "Cookie consent: …", `#onetrust-accept-btn-handler` "Accept All Cookies") so cookie blocklists hide it. `v2` changes the body text ("opens at nine and closes at five" → "opens at eight and closes at six") |
| `/test/diff/shift` | `shift` | `v1`, `v2`, `v3` | About 2,900 px tall with 15 distinct sections and a 640×96 `#cta-button` (about 1.5 % of the full-page screenshot). `v2`: inserts a full-width 48 px `#promo-bar` at the very top, "Spring promotion: two months free on yearly plans" (about 1.65 % of the page). `v3`: the same promo bar (identical text) and the CTA button turns from green `#1f883d` to red `#cf222e` |
| `/test/diff/ab` | `ab` | `a`, `b` | The `h1#headline` inside `section#hero`: "Know the moment a page changes" / "Stop refreshing pages to spot changes" |
| `/test/diff/status` (route handler) | `status` | `ok`, `503`, `challenge`, `empty`, `partial` | `ok`: HTTP 200, 12 paragraphs (about 1,190 characters of text). `503`: HTTP 503 with a `Service Unavailable` page and `Retry-After`. `challenge`: HTTP 403, header `cf-mitigated: challenge`, Cloudflare's "Just a moment..." interstitial markup (title `Just a moment...`, `#challenge-running`, `_cf_chl_opt`). `empty`: HTTP 200, an empty `div`, no text. `partial`: HTTP 200, the heading plus about 5 % of the `ok` text (about 70 characters) |
| `/test/diff/element` | `element` | `v1`, `v2`, `v3`, `v4` | `section#watched` holds "Delivery times" / "Delivery takes three working days." `v2`: only `#outside` changes ("spring" → "summer"). `v3`: `v2` plus the text inside `#watched` ("three" → "five"). `v4`: `#watched` is removed |
| `/test/diff/lazy` | `lazy` | `v1`, `v2` | Twenty 150 px chapters, then `#lazy-section` at about y = 3,150. Its text (`#lazy-text`, at about y = 3,160) renders only after the section scrolls into view (IntersectionObserver, client component). `v1` "…ships in October." / `v2` "…ships in November." |
| `/test/diff/animated` | `animated` | `v1` | A CSS spinner and pulse (keyframe animations) plus `canvas#counter-canvas`, a counter redrawn on every animation frame. The canvas is pixels only; the DOM text never changes |
| `/test/diff/data.json` (route handler) | `data` | `v1`, `v2`, `v3` | JSON `{store, currency, items: [{id, name, price, stock}]}` with five items keyed by `id` (`sku-100` … `sku-500`). `v2`: `items[2].price` 25 → 29, nothing else. `v3`: the v1 items (same ids and values) in a different order |
| `/test/diff/ignored` | `ignored` | `v1`, `v2` | A main article plus `aside.sidebar`. Only the sidebar changes; its sentence always starts with "Sidebar note:" so an `ignore_text` rule can target it |
| `/test/diff/flap` | `flap` | `a`, `b` | `#availability`: "Availability: in the warehouse and ready to ship." / "Availability: temporarily sold out, back soon." Tests alternate the variants to exercise persistence |

### Notes

- The pages render inside the app's root layout, so the document title is "<Fixture> | WatchThatSite". The `status` and `data.json` route handlers return their own documents.
- Element XPaths follow the picker's format (`/html[1]/body[1]/…`). The E2E suite resolves them at run time from a CSS selector (`resolveXPath` in `tests/diffing/lib/api.ts`) instead of hard-coding them.
- The browser worker must reach these pages. When it runs in Docker, point Monitors at `http://host.docker.internal:3003` (`TEST_FIXTURE_BASE_URL`).
