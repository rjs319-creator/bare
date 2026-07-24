# Trade Alerts — Collector v2 Ingest Contract

The external social collector (the browser box, **outside this repo** — the reference
implementation is `~/trade-alert-ranker/trade_alert_ranker.py`) POSTs raw posts to the app.
This document specifies the **v2** payload the collector emits so the app can capture
trustworthy provenance and earn per-account track records.

> **Status (shipped 2026-07-23):** the reference collector emits v2 and is live in production —
> pushing on a 2-hour launchd schedule (`collectorVersion: "2.0.0"`). First live batch took the
> app's `sources` count from `0` → `400+` with stable-ID accounts. Trade Alerts remains
> **shadow / weight 0**.

> **Source of truth:** `lib/alerts-schema.js` (`normalizeV2Post` / `adaptLegacyPost` /
> `normalizeBatch`). If this doc and the code disagree, the code wins — update this doc.

---

## Endpoint & auth

```
POST /api/tracker?op=alertsingest
Content-Type: application/json
```

Authentication (any one, see `lib/auth.js` → `ingestAuthorized`):

- `x-ingest-token: <ALERTS_INGEST_TOKEN>` header, **or**
- `?token=<ALERTS_INGEST_TOKEN>` query param, **or**
- `Authorization: Bearer <CRON_SECRET>`.

Set `ALERTS_INGEST_TOKEN` as a Vercel env var **and** in the collector. Without a configured
token or `CRON_SECRET`, ingest is accepted only in non-production (bootstrap).

**Reset the store** (start a clean feed): `POST …?op=alertsingest&reset=1` — wipes both the v1
and v2 stores.

---

## Request body

```jsonc
{
  "collectorId": "box-1",          // optional; also accepted as header x-collector-id
  "collectorVersion": "2.0.0",     // optional
  "posts": [ /* v2 post objects (or legacy objects — see below) */ ],
  "sourceHealth": { /* optional — see "Source-health" below. Currently NOT consumed by ingest. */ }
}
```

The server routes each row to the **v2** normalizer or the **legacy** adapter automatically
(`isV2Payload`): a row is treated as v2 if it carries any of `authorId` / `author_id` /
`userId` / `postId` / `platform` / `schemaVersion`. Otherwise it's treated as legacy
`{text, account, timestamp}`.

The reference collector sends `collectorId` both as the batch field **and** the
`x-collector-id` header, and stamps `collectorVersion` from its own `COLLECTOR_VERSION`
constant. Unknown top-level keys (like `sourceHealth`) are ignored by ingest, so the payload is
forward-compatible.

---

## v2 post object

Only `text` is strictly required, but **`authorId` is what unlocks account track records** — a
post without it is ingested as raw activity but earns **no** per-account credit and is never
pooled under a shared `"?"` bucket.

| Field | Type | Required | Notes |
|---|---|:--:|---|
| `platform` | string | rec. | `x` (alias `twitter`), `stocktwits`, `reddit`, `discord`, `telegram`, `youtube`, `unknown`. Unknown values → `unknown`. |
| `authorId` | string | **strongly rec.** | **Stable platform user id** — the canonical account key (`platform:authorId`). Handles change and get recycled; the id must not. Aliases accepted: `author_id`, `userId`, `user_id`. Max 64 chars. |
| `handle` | string | rec. | Current @handle (display only; **not** identity). |
| `displayName` | string | opt. | |
| `postId` | string | rec. | Original platform post id (enables dedup + reply/quote threading). |
| `postUrl` | string | opt. | Permalink. |
| `text` | string | **yes** | Full post text. **Max 4000 chars** — longer is **rejected** (not truncated). |
| `kind` | string | opt. | `original` (default), `reply`, `quote`, `repost`, `edited`. |
| `parentPostId` | string | opt. | For replies. |
| `quotedPostId` | string | opt. | For quotes — used in coordination detection (same quoted source ⇒ echo cluster). |
| `referencedUrls` | string[] | opt. | Links in the post (alias `urls`). Max 20. Domains are derived server-side for link-ring detection. |
| `publishedAt` | ISO-8601 string | **strongly rec.** | Exact publication time (aliases `published_at`, `timestamp`). See validation below. |
| `media` | `{type, hash}[]` | opt. | Media metadata. `hash` (perceptual/file hash) links copied-image clusters. Max 8. |
| `engagement` | object | opt. | `{likes, reposts, replies, quotes, views, bookmarks}` — integers. **Integrity/analytics only; never treated as predictive skill.** |
| `followers` | integer | opt. | Snapshot. Integrity only. |
| `following` | integer | opt. | Snapshot. Integrity only. |
| `paidPromotion` | boolean | opt. | `true` if disclosed paid/sponsored. Surfaces as an integrity flag. |
| `positionDisclosed` | boolean | opt. | `true` if the author disclosed a position. |
| `flags` | string[] | opt. | Collector/data-quality flags → stored as `collectorFlags`. Max 12, ≤40 chars each. See **Collector-emitted flags** below for the vocabulary the reference collector uses. |
| `collectedAt` | — | **ignored** | **The server sets `collectedAt` from its own clock.** Any collector-supplied value is discarded (prevents backdating). |

> **Collector extras (not parsed):** the reference collector also sends `referencedSymbols`
> (string[], StockTwits cashtags) and `captureLatencySeconds` on each post. These are **not** in
> the schema whitelist — the app ignores them. They're carried for auditability/forward use only.

### Server-side derived (do NOT send)

- `collectedAt` — server clock.
- `contentHash` — sha256 of the URL/whitespace-normalized text (exact-dedup + copy detection).
- `accountKey` — `platform:authorId` (or `legacy:<handle>` for legacy rows).
- `provenanceQuality` — `full` (stable id + valid published ts) / `partial` / `degraded` (legacy).
- `dataQualityFlags` — validation flags (see below).

---

## Validation & rejection rules

Per row (`normalizeV2Post`):

- **Missing/empty `text`** → **rejected** (`missing_text`).
- **`text` > 4000 chars** → **rejected** (`oversized_text`).
- **Missing `authorId`** → accepted, flagged `unknown_identity`, `accountKey: null` (raw
  activity only, no account credit).
- **`publishedAt` in the future** (> server `collectedAt` + 2 min skew tolerance) → `publishedAt`
  set to `null`, flagged `future_published_ts` (never coerced to "now" — that would leak lookahead).
- **Malformed `publishedAt`** → `null`, flagged `malformed_published_ts`.
- **Missing `publishedAt`** → flagged `missing_published_ts` (grading falls back to next open
  from `collectedAt`; provenance degrades to `partial`).
- **Very old `publishedAt`** (> ~13 months) → flagged `stale_published_ts` (kept).

Rejected rows are dropped and summarized in the response (`rejected`, `rejectedSamples`).

---

## Response

```jsonc
{
  "ok": true,
  "schema": "v2",
  "received": 50,          // rows in the batch
  "accepted": 48,          // passed validation
  "rejected": 2,
  "newEvidence": 41,       // net-new after content-hash dedup
  "evidenceInDay": 512,    // durable audit-shard size today
  "episodes": 37,          // total ticker-thesis episodes
  "openEpisodes": 12,
  "transitions": 6,        // opened/extended/flip/exit/expired this batch
  "sources": 19,           // accounts in the registry
  "rejectedSamples": [ { "errors": ["oversized_text"], "sample": "…" } ],
  "governance": { "maturity": "shadow", "tradeEligible": false, "weight": 0, … }
}
```

---

## What v2 changed from v1 (✅ shipped)

v1 emitted `{ text, account, timestamp }`. That **still works** through the legacy adapter, but
every legacy post gets **degraded provenance and zero account-history credit** (the `account`
string is treated as a non-canonical handle, `accountKey: legacy:<handle>`, never a stable id).

The reference collector now does all of the following (see **Reference implementation** below):

1. **Add `authorId`** — the single highest-value change. Emit the platform's **stable numeric/GUID
   user id**, not the handle. This is what lets an account build a track record and eventually
   earn (post-validation) source-skill weight.
2. **Add `postId`** and, where applicable, `parentPostId` / `quotedPostId` and `kind` — enables
   exact dedup, reply/quote threading, and coordination detection.
3. **Send `publishedAt`** as exact ISO-8601 (keep sending `timestamp` too — it's an accepted
   alias). **Stop sending any collection time** — the server owns `collectedAt`.
4. **Add `platform`** (e.g. `"x"`).
5. **Add `handle` + `displayName`** for display and alias-history tracking.
6. Optional but valuable for integrity/coordination analysis: `referencedUrls`, `media[].hash`,
   `engagement`, `followers`, `paidPromotion`, `positionDisclosed`.
7. Set `collectorId` / `collectorVersion` (batch-level) so captures are attributable.

### Minimal v2 example

```json
{
  "collectorId": "box-1",
  "collectorVersion": "2.0.0",
  "posts": [
    {
      "platform": "x",
      "authorId": "1533291841",
      "handle": "SwingSam",
      "displayName": "Swing Sam",
      "postId": "1780000000000000001",
      "postUrl": "https://x.com/SwingSam/status/1780000000000000001",
      "text": "Adding $ABCD here — breakout over 50 into earnings next week. entry 50, stop 45, target 65.",
      "kind": "original",
      "publishedAt": "2026-07-21T14:03:00Z",
      "referencedUrls": [],
      "engagement": { "likes": 120, "reposts": 8, "replies": 4 },
      "followers": 40100,
      "paidPromotion": false
    }
  ]
}
```

---

## Collector-emitted flags

The reference collector puts these in `flags` (stored as `collectorFlags`; the app treats them
as metadata, never as predictive signal):

| Flag | Meaning |
|---|---|
| `st-sentiment:bullish` / `st-sentiment:bearish` | StockTwits' own sentiment tag. **Carried as a flag, never concatenated into `text`** (that would corrupt keyword parsing). |
| `capture:delayed` | Post was 15 min–6 h old when captured (not real-time). |
| `capture:historical` | 6 h–30 d old at capture. |
| `capture:backfill` | > 30 d old at capture — must never read as live evidence. |
| `authorId-source:manual-map` | `authorId` came from the explicit handle→id map, **not** the provider. |

`capture:*` is derived from `captureLatencySeconds = collectedAt − publishedAt`. Live posts
(≤15 min) carry no capture flag.

---

## Source-health (`sourceHealth`)

The collector sends a per-provider health block so a **failed fetch is never mistaken for a
quiet market**. **The app does not consume this yet** — it's sent for forward compatibility and
written locally by the collector (`collector_health.json`). Shape:

```jsonc
{
  "collectorId": "collector-1",
  "collectorVersion": "2.0.0",
  "generatedAt": "2026-07-23T…Z",
  "providers": {
    "stocktwits": {
      "attempted": true, "success": true,
      "lastAttemptAt": "…", "lastSuccessAt": "…",
      "postsReceived": 209,               // NEW posts after watermarking
      "newestPublishedAt": "…",
      "captureDelaySeconds": 39.7,         // now − newest publication
      "staleFeedWarning": false,           // true if newest post > ALERT_STALE_FEED_HOURS old
      "failureReason": null,               // e.g. "trending_or_stream_empty (blocked/down)"
      "coverage": { "maxSymbols": 20 }
    },
    "nitter": { … "coverage": { "accountsQueried": 14, "accountsWithPosts": 13, "zeroAccounts": ["Walter_Bloomberg"] } }
  }
}
```

---

## Reference implementation (what shipped)

`~/trade-alert-ranker/trade_alert_ranker.py` — merged, live on a 2-hour launchd schedule.

### Stable-identity coverage by provider

| Provider | `authorId` | `postId` | Notes |
|---|:--:|:--:|---|
| **StockTwits** | ✅ numeric user id | ✅ message id | Full provenance. `postUrl`, cashtags, reshare/reply `kind`, `since` cursor. |
| **X API** (official) | ✅ user id | ✅ tweet id | Full provenance. Referenced-tweet → `quote`/`reply`/`repost`; `since_id` cursor. |
| **Nitter** (keyless) | ❌ **null** | ✅ status id (from GUID/link) | **No stable author id exists in Nitter RSS.** Stays `unknown_identity` (no account credit) unless an explicit `X_ID_MAP` resolves the handle. Never handle-as-id. |
| **scrapegraph** | ❌ null (or map) | ❌ | Rendered-profile scrape → no stable id. |

### Watermarks (collector-side; no duplicate evidence)

Per-provider cursors persist in `collector_state.json` so a previously-captured post can't
re-enter as fresh evidence: seen-id ring + numeric high-water mark + a content-hash fallback for
id-less posts, plus provider `since`/`since_id` API cursors. This is what lets the app's
content-hash dedup stay effectively empty of re-sends (verified live: a re-run dropped 272 → 37).

### Collector environment variables

| Var | Purpose |
|---|---|
| `APP_INGEST_URL` | `https://<app>/api/tracker?op=alertsingest` |
| `ALERTS_INGEST_TOKEN` | Must match the app's Vercel env (see auth above). |
| `COLLECTOR_ID` | Batch attribution (default `collector-1`). |
| `X_ID_MAP` / `X_ID_MAP_FILE` | Explicit, labeled handle→stable-X-id map. Never inferred. |
| `ALERT_EMIT_LEGACY` | `1` forces the legacy `{text, account, timestamp}` shape. |
| `ALERT_STALE_FEED_HOURS` | Stale-feed warning threshold (default 24). |
| `ALERT_STATE_FILE` / `ALERT_HEALTH_FILE` | Override the state/health file paths. |

---

## Compatibility guarantee

- The legacy `{text, account, timestamp}` contract is **not removed** — mixed batches (some v2,
  some legacy) are supported; each row is routed independently.
- Existing v1 Blob keys (`alerts/raw|ranked|log|record|edge|assess`) are still written, so the
  legacy display buffer and edge/fade report keep working during migration.
- Migration can be **incremental**: add `authorId` first (biggest win), then the rest.

---

## Governance reminder

Trade Alerts is registered **shadow (weight 0)**. Richer collector data improves provenance and
lets accounts accrue a **prospective** record — it does **not** make the layer live-eligible.
Promotion out of shadow remains an explicit human governance change gated by
`lib/strategy-gate.js` `PROMOTION_GATE`.
