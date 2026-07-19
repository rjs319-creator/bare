// ORBIT-ML ↔ EVOLVE specialist adapter (orbit-ml-evolve-v1).
//
// ORBIT-ML is registered in lib/evolve.js as the specialist `idiosyncraticPersistence`
// with NO SOURCE_SPECIALIST mapping — the structural shadow flag: it can never fire
// on a live decision-engine candidate, so it cannot alter any ensemble probability or
// the live rank (the decision engine never imports EVOLVE at all). This adapter is the
// one-way bridge that lets ORBIT-ML's OWN resolved cross-section be MEASURED alongside
// the existing specialists (redundancy / incremental-value), without wiring it live.
//
// Promotion to a live source mapping is gated (see docs/orbit-ml-promotion.md) and is
// NOT performed here.

const SPECIALIST_ID = 'idiosyncraticPersistence';
const ADAPTER_VERSION = 'orbit-ml-evolve-v1';

// The shadow contract, asserted in tests and echoed on every payload.
function shadowStatus() {
  return {
    specialist: SPECIALIST_ID,
    shadow: true,
    affectsLiveRank: false,
    routerWeight: 0,
    sourceMapped: false,   // no SOURCE_SPECIALIST entry → never fires on a live candidate
    note: 'Registered EVOLVE archetype for legend/health only. No source mapping = cannot reach live rank. Measured via redundancy before any promotion.',
  };
}

// Convert ORBIT-ML resolved predictions → redundancy rows for lib/redundancy.js
// (`buildRedundancyModel` expects [{date, ticker, algorithm, excess}]). `excess` is
// the market/sector-neutral residual net return at the chosen horizon — the same
// currency the existing specialists' excess uses, so credits are comparable.
function specialistRows(resolved, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const rows = [];
  for (const key in (resolved || {})) {
    const r = resolved[key];
    if (!r || !r.horizons) continue;
    const h = r.horizons[horizon];
    if (!h || !h.resolved) continue;
    const excess = h.residualReturn != null ? h.residualReturn : h.netReturn;
    if (excess == null || !Number.isFinite(excess)) continue;
    rows.push({ date: r.decisionTs, ticker: r.ticker, algorithm: SPECIALIST_ID, excess: +excess });
  }
  return rows;
}

// A compact per-prediction record shaped for the shadow ledger / EVOLVE health
// surface. Carries the specialist tag + the shadow flags so nothing downstream can
// mistake it for a live contribution.
function toShadowRecord(pred, opts = {}) {
  const horizon = opts.horizon || 'days21';
  const h = pred && pred.horizon && pred.horizon[horizon];
  return {
    specialist: SPECIALIST_ID,
    ticker: pred.ticker, decisionTs: pred.decisionTs,
    rankScore: h ? h.rankScore : null,
    pResidualUp: h ? h.pResidualUp : null,
    expectedNetReturn: h ? h.expectedNetReturn : null,
    classification: pred.classification,
    ...shadowStatus(),
  };
}

module.exports = { SPECIALIST_ID, ADAPTER_VERSION, shadowStatus, specialistRows, toShadowRecord };
