# Evidence Consensus & Thesis Change Engine

Transforms the News section from a headline/summary/sentiment feed into a decision-support
engine that determines **what materially changed, whether independent evidence confirms it,
which horizon it affects, and whether the market has validated it** — calibrated against the
existing Signal Scoreboard. Honest by design: no return claims, no fabricated numbers, and an
explicit "insufficient evidence" state (consistent with the project's finding that regime is
the only durable lever).

## Audit — what already existed (reused, not rebuilt)

| Capability | Reused from |
|---|---|
| Evidence families + diminishing weight for correlated evidence | `lib/decision.js` (`EVIDENCE_FAMILIES`, `SOURCE_FAMILY`, `independentEvidence`), `lib/redundancy.js` (`effectiveEvidence` — discount *earned* from ledger correlation) |
| Separate swing vs long-term reads | `lib/decision.js` HORIZONS, `lib/longterm.js`, `lib/horizon-synthesis.js`, `lib/whynow.js` |
| Historical calibration at multiple horizons | Scoreboard `api/tracker.js` `op=scoreboard` + `lib/apex-routes.js` (`HORIZONS = 1/5/10/20/21/63d`, SPY-excess) |
| Provenance / PIT | `lib/immutable-ledger.js`, `lib/pit-contract.js`, `lib/provenance.js` |
| Per-ticker news ingestion (FMP Premium) | `lib/fundamentals.js` `fetchCompanyNews` (extended to `fetchCompanyNewsRich` — preserves url/publisher) |
| Active-attention universe | screener candidates (pattern from `lib/tone-routes.js`) |

The genuinely new work is the **event extraction → clustering/dedup → evidence-weighted
consensus → thesis-change** core. Everything else orchestrates existing engines.

## Phase 1 (backend core) — files

- **`lib/evidence-schema.js`** — structured Event object (`EVENT_TYPES`), `normalizeEvent`
  (null-discipline on every number, clamps scores, whitelists enums), and **deterministic
  source primacy** (`classifySource`: SEC/wires = primary, journalism tiers weighted). Source
  primacy is decided mechanically from URLs — never by the LLM — which is the anti-double-count
  defense's foundation.
- **`lib/evidence-cluster.js`** — `fingerprint` (ticker + eventType + day-bucket + salient
  number) + `clusterEvents` (near-duplicate claim merge via token Jaccard). Collapses derivative
  coverage under one primary event so consensus is measured over independent evidence, not
  headline volume.
- **`lib/evidence-consensus.js`** — `scoreConsensus`: transparent 0–100 with per-cap subscores
  (evidence 30 / revision 20 / marketConfirm 15 / catalyst 10 / regime 10 / source 10 / setup 10)
  minus penalties (contradiction −15 / duplication −10 / staleness −10 / crowding −10 /
  saturation −10). Breadth counts distinct evidence **families across clusters** (reusing
  `decision.independentEvidence` + `redundancy.effectiveEvidence`), never article count. Returns
  `state:'insufficient_evidence'` when there is no independent family.
- **`lib/evidence-extract.js`** — one bounded Haiku call per ticker (`maxRetries:0`, forced tool,
  timeout) over provenance-rich news; the model references headlines by index so primacy stays
  mechanical. Per-ticker cache keyed on a news fingerprint → unchanged news never re-extracts.
- **`lib/thesis-change.js`** — `buildThesisChange`: materiality×novelty-weighted directional
  pressure → strengthened/improving/deteriorating/weakened/conflicting/stable, with horizon,
  confirmation status, drivers, contradictions. Optional enrichment hooks for toneshift/revisions.
- **`lib/evidence-routes.js`** — ops (below).

## Ops (all folded into `api/tracker.js` — zero new serverless functions; still 10/12)

- `op=evidencetick` — **PRIVILEGED** (cron). Builds the daily snapshot over the rotated
  active-attention universe (≤14 LLM extractions/tick, concurrency 4, 48s deadline), clusters,
  scores consensus, assembles thesis-change, writes `evidence/<date>.json`. Wired as its own
  `evidence` **root warm-chain** (own 60s budget).
- `op=evidence&view=` — public read of the latest snapshot; views: `all|thesis|swing|longterm|
  contrarian|market|improving|deteriorating`. `s-maxage=300, swr=86400`.
- `op=evidencestock&ticker=` — per-ticker evidence & thesis panel (stock-detail data).

## Scoreboard calibration (stage I)

`runScoreboard` folds `readAllEvidence()` into an **"Evidence"** section (tiers
`EV_STRONG/EV_MODERATE/EV_WEAK`; weakening theses logged `short:true` so forward returns invert)
— same first-appearance dedup + 1/5/10/20/21/63d SPY-excess resolution as Ghost. The falsifiable
test: do STRONG thesis changes actually move in the flagged direction?

## Tests (19 new; full suite 2270 green)

`test/evidence-core.test.js`, `test/evidence-thesis.test.js` — source classification,
null-discipline, **the acceptance test that 5 reprints of one event = one cluster and do NOT
inflate consensus**, independent-family breadth raises score, insufficient-evidence state,
contradiction penalty, thesis-change classification, route pure helpers.

## Environment

Reuses existing keys — no new env vars: `ANTHROPIC_API_KEY` (Haiku extraction), `FMP_API_KEY`
(Premium — company news), `FINNHUB_API_KEY` (fallback), `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`.

## Data-provider limitations

- Company news depth/quality is FMP-Premium `stable/news/stock` (Finnhub fallback). No
  earnings-call transcripts (Ultimate-gated) or 13F institutional flow on the current tier.
- LLM cost bounds coverage to ~14 changed-news names/tick; rotation covers the universe over
  days; unchanged-news names are cache-free.

## Deployment

Additive/shadow — the existing News tab is untouched and keeps working. Deploy via
`vercel --prod` (git push does not auto-deploy this project). Live population requires one
`op=evidencetick` run (the daily cron does this) + a provisioned Blob store.

## Remaining (deferred phases)

- **Phase 3** — News-section UI redesign (Market Changes / Thesis Changes / Swing / Long-Term /
  Contrarian / Portfolio Impact / Failed Narratives / Raw Sources) + stock-detail "Evidence &
  Thesis" panel, consuming `op=evidence`/`op=evidencestock`. Old News tab stays behind until
  validated.
- **Phase 4** — feed the Scoreboard's realized `Evidence`-section record back as the consensus
  `historicalCalibration` input; adaptive weights once ≥ min-sample.
- **Phase 5** — alerts (dedup-aware), portfolio/watchlist impact, Failed Narratives, and folding
  toneshift/revisions/insider enrichment into `thesis-change`.
