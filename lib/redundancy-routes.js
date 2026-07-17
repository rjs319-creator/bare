'use strict';

// op=redundancy — build the MEASURED redundancy model from the live ledgers and cache it.
//
// Reuses, never reimplements: the picks + ghost ledgers (lib/store.js), the forward-return
// resolvers already exported by lib/apex-routes.js (`forwardReturn`, `spyForwardReturn`),
// and the pure model in lib/redundancy.js. Folded into api/tracker.js as an op — no new
// serverless function (11/12 used on Hobby).
//
// Read-only: it never writes a ledger, only the derived model doc. Rate-limited via
// EXPENSIVE_OPS because it fetches candles for every distinct ticker in the history.

const { readAllPicks, readAllGhost, hasStore, readJSON, writeJSON } = require('./store');
const { forwardReturn, spyForwardReturn } = require('./apex-routes');
const { fetchDailyHistory } = require('./screener');
const D = require('./decision');
const RD = require('./redundancy');

const MODEL_DOC = 'apex/redundancy.json';

// The horizon the model is measured on. 5 sessions = the app's standard fast-resolving
// window (matches HORIZON_METRIC.swing and the allocation sleeve horizon), so the model
// fills in weeks rather than quarters.
const HORIZON_DAYS = 5;

// Ledger section → the decision-engine source key, so measured credits are addressable by
// the same names `rankSignals` sees. Unmapped sections fall back to their lowercased
// section name and simply won't match a live source — honest, not silently mislabelled.
const SECTION_SOURCE = {
  screener: 'screener', momentum: 'momentum', Ghost: 'ghost', DownDay: 'downday',
  daytrade: 'daytrade', coil: 'coil', gapgo: 'gapgo', gapdown: 'gapdown', Biotech: 'biotech',
};
const sourceForSection = (s) => SECTION_SOURCE[s] || String(s || '').toLowerCase() || null;

// Turn the raw ledgers into the { date, ticker, algorithm, excess } rows the pure model
// wants. Excess is SPY-relative over HORIZON_DAYS — the same definition the Scoreboard
// uses, so a credit measured here is comparable to the track record shown on a card.
async function buildRows({ limitTickers = 400 } = {}) {
  const [picks, ghost] = await Promise.all([readAllPicks(), readAllGhost()]);
  const raw = [
    ...picks.map(p => ({ ...p, section: p.section || 'screener' })),
    ...ghost.map(g => ({ ...g, section: 'Ghost' })),
  ].filter(r => r && r.date && r.ticker);

  if (!raw.length) return { rows: [], tickers: 0, spans: null };

  // First appearance per (algorithm, ticker, date) — mirrors the Scoreboard's dedup so a
  // name re-logged daily doesn't inflate overlap.
  const seen = new Set();
  const deduped = [];
  for (const r of raw.sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const algorithm = sourceForSection(r.section);
    if (!algorithm) continue;
    const k = `${algorithm}|${String(r.ticker).toUpperCase()}|${r.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Carry `tier`/`short` through: forwardReturn() inverts a short's return so that
    // positive always means "the call was right". Dropping them would score every
    // StrongSell backwards and silently corrupt the correlation between a long sleeve
    // and a short one.
    deduped.push({
      date: r.date, ticker: String(r.ticker).toUpperCase(), algorithm,
      entry: r.entry ?? null, tier: r.tier ?? null, short: r.short ?? false,
    });
  }

  const tickers = [...new Set(deduped.map(r => r.ticker))].slice(0, limitTickers);
  const spyDoc = await fetchDailyHistory('SPY');
  const spy = spyDoc ? spyDoc.candles : null;

  // Bounded concurrency — the same worker-pool shape used across the repo.
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  // Both resolvers take the PICK object (they read .date/.entry/.tier/.short) and return
  // null until the horizon has fully elapsed — so unresolved rows stay honestly null
  // rather than being scored against a truncated window.
  const rows = deduped.map((r) => {
    const candles = hist.get(r.ticker);
    let excess = null;
    if (candles && spy) {
      const pr = forwardReturn(candles, r, HORIZON_DAYS);
      const sr = spyForwardReturn(spy, r, HORIZON_DAYS);
      if (Number.isFinite(pr) && Number.isFinite(sr)) excess = +(pr - sr).toFixed(3);
    }
    return { date: r.date, ticker: r.ticker, algorithm: r.algorithm, excess };
  });

  const dates = rows.map(r => r.date).sort();
  return { rows, tickers: tickers.length, spans: { from: dates[0], to: dates[dates.length - 1] } };
}

async function runRedundancy(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  if (!hasStore()) {
    return res.json({
      configured: false, verdict: 'insufficient',
      note: 'Blob store not provisioned — no ledger to measure redundancy from.',
      generatedAt: new Date().toISOString(),
    });
  }

  const fresh = req.query && (req.query.force === '1' || req.query.refresh === '1');
  if (!fresh) {
    try {
      const cached = await readJSON(MODEL_DOC);
      if (cached && cached.generatedAt) return res.json({ ...cached, cached: true });
    } catch { /* fall through to rebuild */ }
  }

  try {
    const { rows, tickers, spans } = await buildRows({
      limitTickers: Math.min(800, Math.max(50, Number(req.query && req.query.limit) || 400)),
    });
    const model = RD.buildRedundancyModel(rows, {
      priorCredit: D.CORR_DISCOUNT,
      familyOf: (s) => D.SOURCE_FAMILY[s] || null,
    });
    const payload = {
      ...model,
      configured: true,
      cached: false,
      horizonDays: HORIZON_DAYS,
      coverage: { rows: rows.length, resolved: rows.filter(r => Number.isFinite(r.excess)).length, tickers, span: spans },
      familyLabel: D.FAMILY_LABEL,
      generatedAt: new Date().toISOString(),
    };
    try { await writeJSON(MODEL_DOC, payload, 0); } catch { /* cache is best-effort */ }
    return res.json(payload);
  } catch (e) {
    return res.status(502).json({
      configured: true, error: String((e && e.message) || e), verdict: 'insufficient',
      note: 'Redundancy build failed — the ranking falls back to the static family prior.',
      generatedAt: new Date().toISOString(),
    });
  }
}

// Loader for the live decision path. Returns null on ANY failure or when no pair has
// earned a measured credit, so `rankSignals` transparently keeps the static family rule.
async function loadRedundancyModel() {
  try {
    if (!hasStore()) return null;
    const m = await readJSON(MODEL_DOC);
    if (!m || !m.credits || !m.summary || !m.summary.measurablePairs) return null;
    return m;
  } catch { return null; }
}

module.exports = { runRedundancy, loadRedundancyModel, buildRows, MODEL_DOC, HORIZON_DAYS, SECTION_SOURCE };
