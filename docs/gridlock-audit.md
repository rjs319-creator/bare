# GRIDLOCK — Repository Audit (Phase 1)

**Date:** 2026-07-31 · **Module:** `gridlock-v1` (Physical Constraint & Marginal Beneficiary Engine) · **Status:** SHADOW / weight-0 / research-only

This audit was completed BEFORE any production code was modified. It maps what
already exists, what GRIDLOCK reuses, what is genuinely missing, and where the
integration risks are.

---

## 1. Relevant existing files

### Platform / conventions
| Concern | Where | Facts that shaped GRIDLOCK |
|---|---|---|
| API surface | `api/tracker.js` | Single `op=` multiplexer (Hobby plan caps 12 serverless functions; 10 in use). New ops = dispatch lines + membership in `PRIVILEGED_OPS` (cron writes) / `SHARED_FORCE_OPS` (public cached reads). |
| Auth | `lib/auth.js` | `CRON_SECRET` bearer via `requireTrusted`; fail-closed in production. Writers are cron-only. |
| Storage | `lib/store.js` | Vercel Blob; generic `readJSON`/`writeJSON(path, obj, cacheMaxAge)`; ledger convention = `prefix/YYYY-MM-DD.json` day files + a dated regex + `readAll*Days()` pager. `cacheMaxAge 0` for cron-rewritten docs. |
| Scheduling | `lib/warm-chains.js`, `api/warm.js`, `vercel.json` | ONE daily cron (22:00 UTC) fans out to `ROOT_CHAINS`; a chain that is neither a root nor `@`-nested never runs (asserted in `test/warm-chains.test.js`). Heavy verticals get their OWN root so they can't budget-starve shared chains (govdemand precedent). |
| HTTP | `lib/http.js` | `fetchWithTimeout` (8s default, opt-in retries w/ full-jitter backoff, retry only on 429/5xx/timeouts). `lib/map-limit.js` for bounded fan-out. |
| LLM discipline | `lib/evidence-extract.js`, `lib/alerts-fable.js`, `lib/readthrough.js` | `maxRetries: 0` (universal), hard `{ timeout }` < 60s wall, `tool_choice` forced tool, pure `parse*`/`normalize*` sanitizer as the single choke point, fingerprint caching. Stated principle (`lib/evidence-schema.js`): "the LLM proposes; normalize disposes; ungrounded numbers stay NULL, never fabricated." |
| Module system | CommonJS everywhere; `node --test`; flat `test/<module>.test.js`; fixtures under `test/fixtures/` |

### Systems GRIDLOCK integrates with
| System | Where | Reuse |
|---|---|---|
| **Read-Through** | `lib/readthrough.js`, `lib/readthrough-routes.js` | `benchFor()` sector-ETF resolver; `alreadyMovedFlag` tape-check concept (generalized into the deterministic `notYetRepricedScore`); forward-ledger `logSurfaced` shape; Scoreboard `SECTOR_BENCH` membership. |
| **OMEGA-SWING** | `lib/omega-swing.js` (`evaluateCandidate`), `lib/omega-execution.js`, `lib/omega-sizing.js` | ALL market-timing (RS, momentum, volume, vol, regime fit, entry class, stop/target/R:R, earnings risk, sizing caps) comes from `evaluateCandidate` — GRIDLOCK does not recompute any of it. |
| **Evidence families** | `lib/decision.js` (`EVIDENCE_FAMILIES`, `FAMILY_LABEL`, `FAMILY_DOMAIN`) | GRIDLOCK registers `physicalConstraint` as a NEW family (new `physical` domain) so ensemble breadth logic can see it as independent of `priceTrend` — while the strategy stays shadow so it can never reach a live rank. |
| **Strategy governance** | `lib/strategy-registry.js`, `lib/strategy-gate.js` | Registry entry `id:'gridlock'`, `maturity:'shadow'` → `isTradeEligible=false`; `PROMOTION_GATE` text is the promotion policy anchor. |
| **Market Pulse lifecycle** | `lib/pulse-schema.js` (`LIFECYCLES`), `lib/pulse-episodes.js` | GRIDLOCK reuses the same lifecycle VOCABULARY (New/Emerging/Building/Crowded/Fading) and adds project-terminal states (Completed/Delayed/Cancelled/Invalidated). The Pulse `deriveLifecycle` itself is hard-wired to LLM velocity/crowding enums → not reusable; GRIDLOCK's transitions are deterministic-evidence-driven instead. |
| **Scoreboard** | `lib/apex-routes.js` `runScoreboard` | Fold-in block pattern (`sectionRows(days,'Gridlock')`), first-seen episode dedup `section:tier:ticker`, SPY + sector + regime-split resolution already generic. |
| **Evidence/maturity badges** | `lib/maturity.js`, `lib/sectionscore.js`, `public/js/evidence-badge.js` | `section:'Gridlock'` join key + `mountVerdict(sub)` hook = automatic earned-grade badge. |
| **Regime** | `lib/macro.js` | `fetchMacro()` live; `buildMacroLookup(range).at(date)` PIT. |
| **Costs/baselines/no-lookahead** | `lib/costs.js`, `lib/drift-eval.js`, `lib/baselines.js`, `lib/walk-forward.js` | `roundTripCostPct` net returns; `evalDrift` SPY-excess event-time evaluation (enters close AFTER event); `purgedWalkForward` date-grouped CV. |
| **News→event extraction** | `lib/evidence-schema.js`, `lib/evidence-extract.js`, `lib/evidence-cluster.js` | The repo ALREADY has a full news→structured-event pipeline with deterministic source primacy + clustering. GRIDLOCK mirrors its discipline (deterministic first, bounded grounded LLM second) for physical events. |
| **SEC EDGAR** | `lib/edgar.js` | Mature adapter (CIK map, filings, SEC_USER_AGENT etiquette, throttle) — reusable for filing-evidence enrichment in a later slice. |
| **Closest precedent** | `lib/govdemand-*.js` (PR #221) | The architectural template: adapter / identity-map / pure-schema / ops separation, SHADOW_FLAGS threaded through every doc + response, prospective-only PIT honesty, rejected candidates recorded with reason codes, static causal-chain templates with invalidating measurements, own warm-chain root. |

## 2. Missing capabilities (confirmed by grep — genuinely absent)
- **No power/energy adapters at all**: no EIA, NWS/NOAA, PJM/ERCOT/CAISO/MISO client anywhere. Only incidental strings (an LLM prompt in `lib/crossasset.js`, a display regex in `public/js/themes.js`).
- No physical-event schema (existing `EVENT_TYPES` in `lib/evidence-schema.js` are corporate/news types, not physical-infrastructure types).
- No regional constraint model, no exposure-role graph (govdemand's map is recipient→ticker identity, not role/region exposure).
- govdemand has NO UI — so the "shadow vertical UI" pattern comes from `rltlab`/`orbitlab` instead.

## 3. Proposed schema additions (all new, versioned; no existing schema altered)
- `PhysicalConstraintEvent` — `gridlock-event-v1` (`lib/gridlock-schema.js`): full field set incl. PIT triplet, sourceEvidence[], unresolvedFields[], fieldConflicts[], parserVersion. Canonical dedup: `eventType:ISO:normalizedProjectName` → duplicate stories MERGE evidence (independentSourceCount = distinct publishers), never create new events.
- `PowerRegionState` — `gridlock-regionstate-v1` (`lib/gridlock-region.js`): every value labeled observed/derived/assumed/estimated-proxy; staleFields + dataCoverage explicit.
- `constraintPressureScore` — `gridlock-cps-v1`: 8 weighted components, availability-renormalized, per-region/per-season normalization anchors, missing components reported.
- `GridlockOpportunityScore` — `gridlock-score-v1`: 8 weighted components + explicit penalty list; no probability output.
- Exposure graph — `gridlock-exposure-v1`: hand-curated, cited, effective-dated, verified-vs-inferred labeled (govdemand-map discipline).
- Blob prefixes (new, isolated): `gridlock/state.json`, `gridlock/events.json`, `gridlock/latest.json`, `gridlock/day/<date>.json` (Scoreboard ledger), `gridlock/resolved.json`.

## 4. Overlap with Read-Through — and the boundary
Read-Through answers: *given a price-confirmed catalyst on ticker A, which OTHER ticker hasn't repriced?* — relational, LLM-proposed, tape-filtered.
GRIDLOCK answers: *given a PHYSICAL/CONTRACTUAL event, which regional constraint changed, and which VERIFIED-exposure company benefits/suffers?* — mechanism-first, deterministic classification over a curated graph.
Shared: the "has it repriced yet?" tape logic and sector benchmarking. GRIDLOCK **reuses** `benchFor` from `lib/readthrough.js` and generalizes `alreadyMovedFlag` into a decomposed deterministic `notYetRepricedScore` (`lib/gridlock-readthrough.js`) rather than duplicating the module. GRIDLOCK deliberately does NOT extend the `READTHROUGH_TOOL` LLM schema: that call runs at a hard latency budget (50s wall, 3 triggers max) and adding fields there degrades an unrelated production surface. A stock that hasn't moved because its exposure is weak scores LOW (exposure confidence gates the score) — weak-link non-movers are never labeled hidden opportunities.

## 5. Integration risks (and mitigations)
1. **60s function wall** — the tick does source fetches + candle fetches. Mitigation: govdemand-style bounded fan-out constants, lazy price gates (only candidates surviving cheaper gates fetch candles), deadline guards.
2. **Warm-chain budget starvation** — mitigated by an OWN root chain (`gridlock: ['op=gridlocktick','op=gridlockresolve']`), the exact govdemand rationale.
3. **Blob read-modify-write races** — known repo hazard (insider.json lost-update). Mitigation: single nightly cron writer per doc + cache-busted reads (already in `readJSON`) + `cacheMaxAge 0`.
4. **Missing API keys** — EIA (`EIA_API_KEY`) and PJM Data Miner (`PJM_API_KEY`) are keyed; NWS is keyless. Adapters degrade to explicit `partial`/`missing` states; the CPS renormalizes over available components and reports what's missing. **No API access is invented**: without keys the region state honestly shows `dataQuality: 'poor'` and the tick still runs (events + exposure + tape still work).
5. **Double-counting momentum** — GRIDLOCK's opportunity score contains NO momentum/RS/volume features; the timing component is a pass-through of OMEGA-SWING's `evaluateCandidate` output (tested: score is timing-free; timing is omega-only).
6. **Touching `lib/decision.js`** — adding the `physicalConstraint` family is a vocabulary addition only; no `SOURCE_FAMILY` mapping is added, so no live screener routes to it and the decision engine's live behavior is unchanged (asserted by test).
7. **Frontend regression** — UI follows the `rltlab` lazy-load pattern; failures render error states inside the section only.

## 6. Recommended implementation sequence (executed in this order)
1. ✅ This audit.
2. Shared schemas + provenance (`gridlock-schema.js`), lifecycle machine (`gridlock-lifecycle.js`).
3. Physical event ledger: canonicalization/merge (`gridlock-schema.js`), deterministic + bounded-LLM extraction (`gridlock-events.js`), curated seed events (`gridlock-seed.js`).
4. Region adapters — PJM (keyed), EIA (keyed), NWS (keyless) — `gridlock-sources.js`; first vertical slice = **PJM** (chosen because: largest data-center load concentration [N. Virginia "Data Center Alley"], the seed events with the strongest verified public evidence are PJM, EIA covers the PJM footprint keyed-free-tier, and NWS gives keyless weather signal for its footprint).
5. Regional constraint state + CPS (`gridlock-region.js`).
6. Corporate exposure graph (`gridlock-exposure.js`).
7. Causal beneficiary classification (`gridlock-causal.js`).
8. Opportunity score + penalties (`gridlock-score.js`), notYetRepriced (`gridlock-readthrough.js`).
9. Routes/ops + storage + cron + registry + OMEGA shadow evidence family (`gridlock-routes.js`, edits).
10. UI (`public/js/gridlock.js` + wiring).
11. Prospective Scoreboard tracking + resolve (`gridlock-routes.js` resolve + `apex-routes.js` fold-in).
12. Scenario engine (`gridlock-scenario.js`).
13. Relative-value comparisons (inside routes payload; research-only).
14. Tests + docs.
15. LATER slices: ERCOT/CAISO regions, EDGAR filing-evidence enrichment, additional constraint domains (transformers/semis/cooling), calibration before any probability.
