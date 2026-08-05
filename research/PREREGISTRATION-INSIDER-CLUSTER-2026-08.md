# Preregistration — Insider Cluster × Drawdown (2026-08)

**Registered:** 2026-08-05 · **Hypothesis id:** `insider-cluster-drawdown` (family `alt-signals`) · **Mode:** exploratory, ONE pass.
**Status at registration:** OPEN — the EDGAR Form-4 pull for this universe/window has not been made; no cluster event has been constructed or inspected. The seal is this document's commit hash.

## §1 Motivation

This program already measured insider data twice (2026-06 pilots): large-cap IN pillar −0.102 IC (sell-side artifact), small-cap +0.067 IC standalone but **redundant with momentum in a composite**. The composite-weight question is answered. This asks the different, literature-supported EVENT question: do *cluster* purchases (≥2 distinct insiders, real combined capital) *after a drawdown* — the specific pocket where limits-to-arbitrage protect the effect — carry drift? Deliberately low-novelty, high-prior, cheap: the EDGAR pipeline exists (`lib/edgar.js`, `scripts/build-insider.js` pilots).

## §2 Fixed design (frozen before the pull; the registry entry is the authority)

- **Universe:** `SMALL_CAPS ∪ MICRO_CAPS` with research price caches (~184 names; the 58 cache-less names are counted, not silently dropped).
- **Data:** EDGAR Form 4, filings from 2021-01-01, ≤150 filings/name, code-P open-market purchases only.
- **Cluster event:** ≥2 distinct owners, transaction dates within 14 calendar days, combined value ≥ $50,000. **Event date = the LATEST FILING date** of the cluster members (the cluster is only knowable when its last member files — transaction-date anchoring would leak, the congress-trades lesson). Per-name cooldown 21 sessions between events.
- **Drawdown condition:** event-date close ≤ 0.70 × trailing-252-bar max close.
- **Outcome:** SPY-excess drift, close-after-event-date → +21/+63 sessions, research caches only.
- **Primary:** cluster+drawdown mean 63s excess t ≥ 2 AND positive 21s mean. **Fail-closed:** < 40 cluster+drawdown events ⇒ verdict `invalid-data` (thin), no drift claim either way.
- **Controls/comparisons:** placebo (same events, entries shifted −126 sessions) must not show comparable drift; single-buyer and cluster-without-drawdown cohorts reported as internal comparisons (not gates).

## §3 Prohibitions

No threshold tuning (window, owner count, dollar floor, drawdown depth, cooldown are frozen above). No subgroup mining. No added horizons. The 2021-2026 window is spent on completion; any confirmatory claim requires a NEW preregistration on future filings (the EDGAR feed supplies them prospectively).

## §4 Analysis code

`research/69-insider-cluster.js` — resumable per-symbol EDGAR pull cached to `research/data/insider-edgar/`, pure cluster construction (`clusterEvents`, locked by `test/insider-cluster-prereg.test.js`), study, one append-only evidence record.
