# Tech Operational Evidence

An evidence-first technology intelligence layer that detects unexpected changes in real
operating activity **between** financial reports, renders them with full provenance on the
Technology Command Center page, and tests them honestly in a forward, sector-neutral,
net-of-cost ledger.

**What it claims:** a private, immutable, point-in-time history of fragmented public
operational evidence, normalized against each company's own history and its peers.
**What it does not claim:** alpha. Every arm starts at `COLLECTING`/`INSUFFICIENT_DATA`
and can only earn `PROMISING_RESEARCH` through the prespecified gate below. `VALIDATED`
is reserved for the repository's stricter `docs/model-promotion-policy.md` on a
subsequent untouched sample and is never auto-assigned.

## Declared hypothesis and experiment family

> Among developer-led technology companies with a verified product-to-ticker mapping,
> does unexpected product-adoption acceleration predict net sector-neutral returns over
> the following 5 and 10 trading sessions?

- Experiment id: `techev-adoption-2026-08` (`lib/tech-evidence/experiment.js`).
- FDR family (declared 2026-08-15, before any data accrued): scored arms
  `{npm, github, sec}` × horizons `{5, 10}` on the positive-surprise cohort — 6 tests,
  Benjamini–Hochberg α = 0.10 (`evidence-stats.fdrAdjust`, field `survives`).
- 1-session results are reported **descriptively only**. Negative-surprise cohorts are
  tracked and reported but are not part of the declared family.

### Promotion gate (prespecified — do not loosen after seeing results)

All must hold for `PROMISING_RESEARCH`: ≥100 independent resolved events AND ≥40
independent dates for that exact arm×horizon; mean net sector-neutral residual > 0
(from `avgExact`, never the rounded display fields); 95% CI lower bound > 0 (wider of
Newey-West-t and moving-block bootstrap); ≥3 of 4 chronological folds positive; FDR
q ≤ 0.10 across the declared family; mean still positive after removing the 5 largest
wins. Below the floor the state is `COLLECTING` (or `INSUFFICIENT_DATA` when nothing
has been observed); `NULL` is only reachable **with** a full sample. An empty panel can
never print `NULL` — pinned by `test/tech-evidence-experiment.test.js`.

## Architecture

```
lib/tech-evidence/
  registry.js       verified ticker↔product mapping registry (version-controlled here)
  schema.js         deterministic IDs, content hashes, timestamp semantics
  adapters/         one official public source per file (common.js = guarded fetch)
  store.js          Blob layout, series folds (= dedup), day ledgers, forward index
  signals.js        per-arm surprise math (pure, PIT-cutoff enforced)
  forward.js        forward-ledger event creation + 1/5/10-session resolution math
  experiment.js     scorecard stats, gate, honest state ladder
  collect.js        cron orchestration: collect → fold → derive → event creation
lib/tech-evidence-routes.js   tracker ops (below)
public/js/tech-evidence-render.js  the page section (mounted in tech-command.js)
```

### Data flow

collect (per source, isolated) → fold into `series/<source>.json` (fold decides
freshness; identical observations are no-ops → idempotent cron retries) → NEW
observations appended to `obs/<source>/<retrievalDay>.json` (first-wins by
deterministic id; history never overwritten; restatements become linked revision
observations) → signal derivation at the last completed regular session → eligible
signals (|robust z| ≥ 1, quality `ok`) become forward events (write-once via index
membership; overlapping open events deduped per ticker×arm) → resolution scores
matured days whole-or-not-at-all (partial resolution would bias selection).

### Storage (Vercel Blob, `techev/v1/`)

| Key | Meaning |
|---|---|
| `obs/<source>/<day>.json` | append-only audit ledger of newly observed facts |
| `series/<source>.json` | compact fold the signal math reads (rebuildable from obs) |
| `signals/latest.json` | latest derived-signal snapshot |
| `forward/index.json`, `forward/<date>.json`, `forward/rows.json` | forward ledger |
| `health.json` | per-source health + cursors (single writer: the tick) |

### Timestamp semantics (all stored UTC; UI shows ET)

`effectiveDate` = when the activity happened · `firstObservedAt` = first time this
system saw it (backfill runs are labeled `basis:'backfill'`) · `retrievedAt` = fetch
time · `publicAt` = best-known public availability (npm day counts publish the next
day; SEC facts at the `filed` date). Signals at cutoff C use only: npm days ≤ C−1,
GitHub releases published ≤ C, SEC facts **filed** ≤ C. Forward entry is the next
regular-session **open** after C (`candles[i+1].open`, exits `candles[i+H].close` —
mirrors `research/lib/experiment-kit.forwardFromNextOpen`). Benchmark residual uses
identical geometry on the mapping's subsector ETF; costs use `lib/costs.roundTripCostPct`
(PERCENT → divided by 100 exactly once, tier by ADV ≥ $20M = liquid, else small).

## Sources

| Arm | Endpoint | History | Scored | Notes |
|---|---|---|---|---|
| sec | data.sec.gov companyfacts + submissions | backfillable (filed dates) | yes | directly-tagged comparable quarters only; no Q4 arithmetic; amendments = revisions; 8-K Item 1.05 captured as events |
| npm | api.npmjs.org downloads/range | backfillable (≤540d) | yes | complete days only; missing days lower quality, never filled |
| github | api.github.com releases | backfillable (published_at) | yes | company-owned SDK repos; drafts skipped; stars/commits deliberately not used |
| statuspage | `<host>/api/v2/incidents.json` | recent window backfillable | context | maintenance excluded; company-reported label |
| greenhouse/lever | official board APIs | forward-only | context | hiring MIX by function; management intent, not completed hiring; no personal data |
| huggingface | huggingface.co/api/models | forward-only | context | rolling 30d counter snapshots; history is never reconstructed |
| usaspending | api.usaspending.gov | action dates | context | verified-alias recipient match only; no mappings seeded yet |
| pricing | explicitly configured official company URLs | forward-only | context | normalized-hash change detection, bounded diff; company-domain hosts only |

Known biases/manipulation risks: npm counts include CI/bots/mirrors; releases measure
producer investment, not demand; job boards can be groomed; status pages are
company-reported; all noted on every card ("why it may be noise").

## Verified mapping registry

`lib/tech-evidence/registry.js` is the registry — auditable through git. Active
verified companies (2026-08-15): **MDB, DDOG, NET, TWLO, ESTC** (CIKs verified against
the SEC's `company_tickers.json`). **CFLT** is retained but inactive
(`activeTo: 2026-03-27` — Form 15-12G deregistration), demonstrating point-in-time
mapping correctness. Unverifiable ideas live in `CANDIDATES` with explicit exclusion
reasons and never produce signals.

To add a mapping: add an entry with ticker/CIK/subsector/benchmark, source + sourceId,
official `sourceUrl`, `ownershipEvidence` (how you verified the company owns the
source), `revenueConnection`, `monetizationWeight`, `verifiedAt`, `activeFrom`.
`validateMapping` must pass (`test/tech-evidence-registry.test.js` enforces it for
every entry) — it rejects non-official hosts, so a bad mapping cannot become an SSRF
vector (`adapters/common.guardedFetch` re-checks at fetch time: https-only, allowlist,
bounded body, no redirects).

## Operations

| Op | Access | Purpose |
|---|---|---|
| `op=techev` | public (rate-limited) | page summary: health, signals, scorecard, coverage |
| `op=techevdetail&ticker=X` | public (rate-limited) | provenance + raw evidence excerpts per ticker |
| `op=techevtick` | PRIVILEGED | collect all sources (deadline-aware, per-source isolation) + derive + create events |
| `op=techevresolve[&limit=N]` | PRIVILEGED | resolve matured days (≥16 calendar days; ≤3 fetch attempts before excluding a dead ticker; postpone-whole-day otherwise) |
| `op=techevbackfill&src=npm\|github\|sec\|statuspage\|derive` | PRIVILEGED, **manual only** | bounded PIT backfill; `derive` replays weekly cutoffs over backfilled series |

Cron: the `techev` root warm chain (`op=techevtick` → `op=techevresolve`) rides the
existing daily 22:00 UTC `/api/warm` dispatch — no new Vercel cron. Public reads never
write and never CDN-cache empty states. Rate etiquette: SEC ≤10 req/s with per-call
throttle and the standard UA; unauthenticated GitHub stays within 60/hr (one page per
repo per tick) and degrades honestly on 403 — set `GITHUB_TOKEN` to lift it.

### Environment variables

Required for persistence: `BLOB_READ_WRITE_TOKEN` (missing → honest not-configured
state; writers 503). Required for cron auth: `CRON_SECRET` (fail-closed in prod).
Optional: `GITHUB_TOKEN` (higher rate limit), `SEC_USER_AGENT` (defaults to the
repo-standard contact UA). No new secrets introduced.

### First-time setup (after deploy, manual, with the cron bearer)

```
op=techevbackfill&src=npm      # ~540 days of download history
op=techevbackfill&src=github   # release history (up to 5 pages/repo)
op=techevbackfill&src=sec      # full companyfacts history
op=techevbackfill&src=statuspage
op=techevbackfill&src=derive   # replay weekly cutoffs → seed the forward ledger
op=techevresolve&limit=20      # repeat until the matured backlog drains
```

### Failure recovery

Everything is idempotent: re-dispatching the tick/backfill adds nothing new; the series
docs are rebuildable from the obs ledgers; `forward/index.json` is the only creation
authority for events. A day whose candles cannot be fetched is retried up to 3 resolve
passes, then its unfetchable events are excluded with the reason recorded (delisted
names do not wedge the pipeline).

### Rollback / disable

Remove `'techev'` from `ROOT_CHAINS` in `lib/warm-chains.js` (collection stops; nothing
is deleted). The page section degrades to an honest stale/"collection has not run"
state. Historical evidence under `techev/v1/` must never be deleted.

## UI

Rendered inside the Technology Command Center (`#tech-command`) as the **Operational
Evidence** section: plain-English header with the standing disclosure ("Research
evidence, not a trade recommendation…"), health/coverage strip, arm/status filters,
evidence cards (exact change, first-observed time, own-baseline and peer comparison,
revenue connection, mapping confidence, why-it-may-matter / why-it-may-be-noise,
expandable provenance with timestamps and windows), the research scorecard, mapping
coverage incl. excluded candidates, and per-source health. The **Research Attention
Score** is sort order only (abnormality × freshness × mapping quality) and says so in
its tooltip. All upstream text is escaped (`test/tech-evidence-frontend.test.js` pins a
hostile-string case).

## Current status (2026-08-15)

Implemented and tested; **not deployed** (deploy happens when the branch merges to
main per repo policy). No production data has accrued; the local end-to-end smoke
(real public APIs, in-memory store) produced ~67 resolved backfill events — far below
the 100-event floor, so every arm reports `COLLECTING`. **No historical alpha
conclusion is possible yet, and none is claimed.** Known limitation: companies that do
not tag fiscal-Q4 quarters (e.g. MDB) cannot compute ΔYoY at fiscal-Q1 filings — those
events are rejected, not approximated.
