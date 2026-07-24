'use strict';
// 🧾 EVIDENCE CONSENSUS & THESIS CHANGE — routes (folded into api/tracker.js, no new function).
//
//   op=evidencetick  : PRIVILEGED cron. Build the daily evidence snapshot over the active-
//                      attention universe (names the screeners already surfaced): fetch each
//                      name's provenance-rich news, extract structured events, cluster/dedup,
//                      score evidence-weighted consensus, assemble a thesis-change object, and
//                      persist to the `evidence/<date>.json` ledger. LLM-gated + per-ticker
//                      cached on a news fingerprint so unchanged names never re-extract.
//   op=evidence      : public read. Serve the latest snapshot, filtered by ?view= (thesis /
//                      swing / longterm / contrarian / market / all).
//   op=evidencestock : public read. Per-ticker evidence & thesis panel (stock-detail stage L).
//
// Reuse-first: ingestion = lib/fundamentals.fetchCompanyNewsRich; universe = the screener
// candidates (like lib/tone-routes); scoring = lib/evidence-* + lib/decision + lib/redundancy.

const { internalHeaders } = require('./auth');
const { nowET } = require('./stats');
const {
  hasStore, writeEvidenceDay, readLatestEvidence, readJSON, writeJSON,
} = require('./store');
const { fetchCompanyNewsRich } = require('./fundamentals');
const { extractEvents } = require('./evidence-extract');
const { clusterEvents } = require('./evidence-cluster');
const { scoreConsensus } = require('./evidence-consensus');
const { buildThesisChange } = require('./thesis-change');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SNAPSHOT_VERSION = 'evidence-v1';
const MAX_TICKERS_PER_TICK = 14;   // LLM-bounded; unchanged names (cache hit) are ~free on top
const CONCURRENCY = 4;
const DEADLINE_MS = 48000;         // stop starting new extractions past this (60s function wall)
const NEWS_LOOKBACK_DAYS = 10;

async function getJSON(path) {
  const r = await fetch('https://' + HOST + path, { headers: internalHeaders() });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

// Deterministic per-day rotation so a bounded tick eventually covers the whole universe
// (mirrors rotateByDay in screener-routes). Offset from the calendar day.
function rotateByDay(arr, date) {
  const n = arr.length;
  if (n < 2) return arr.slice();
  const day = parseInt(String(date).replace(/-/g, ''), 10) || 0;
  const off = (day * 97) % n;
  return arr.slice(off).concat(arr.slice(0, off));
}

// The active-attention universe: names the screeners surfaced today, with the light market
// context the consensus score needs (price/momentum/regime). One row per ticker, first wins.
async function attentionUniverse() {
  const seen = new Map();
  let regime = 'neutral';
  for (const scope of ['large', 'small', 'micro']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { continue; }
    if (scope === 'large' && d.ghost && d.ghost.regime) regime = d.ghost.regime;
    (d.results || []).forEach(r => {
      if (!r || !r.ticker || seen.has(r.ticker)) return;
      const f = r.factors || {};
      seen.set(r.ticker, {
        ticker: r.ticker, company: r.company || null, sector: r.sector || null, price: r.price ?? null,
        mom: f.mom63 ?? f.mom21 ?? null, rs: f.rsVsSpy63 ?? null, dollarVol: f.dollarVol ?? null,
      });
    });
  }
  return { universe: [...seen.values()], regime };
}

// Map macro regime → a regimeFit in [-1,1] for the consensus score (the project's one
// validated lever: long edge inverts in risk-off).
function regimeFitOf(regime) {
  return regime === 'risk-off' ? -0.5 : regime === 'risk-on' ? 0.4 : 0;
}

// Light market-confirmation: does recent price momentum agree with the event direction?
// +1 fully confirms, -1 contradicts, null when momentum is unknown. Honest and bounded.
function marketConfirmationOf(cand, direction) {
  if (cand.mom == null || direction === 'neutral' || direction === 'mixed') return null;
  const dirSign = direction === 'positive' ? 1 : -1;
  const momSign = cand.mom > 0 ? 1 : cand.mom < 0 ? -1 : 0;
  if (momSign === 0) return 0;
  return dirSign === momSign ? Math.min(Math.abs(cand.mom) / 10, 1) : -Math.min(Math.abs(cand.mom) / 10, 1);
}

// Expectation saturation proxy: a very large recent move suggests the news may be priced in.
function saturationOf(cand) {
  if (cand.mom == null) return null;
  return Math.min(Math.abs(cand.mom) / 40, 1); // ~40% move → fully saturated
}

// Build the full evidence bundle for ONE ticker (news → events → clusters → consensus → thesis).
// Uses a per-ticker extraction cache keyed on the news fingerprint (no LLM on unchanged news).
async function buildTickerEvidence(cand, ctx) {
  const { date, regime, redundancyModel } = ctx;
  const from = new Date(Date.now() - NEWS_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const to = date;
  let news = [];
  try { news = await fetchCompanyNewsRich(cand.ticker, from, to, 24); } catch { news = []; }
  if (!news.length) return null;

  const cachePath = `evidence/cache/${cand.ticker}.json`;
  const { newsFingerprint } = require('./evidence-extract');
  const fp = newsFingerprint(news);
  let events, cached = false;
  const prior = await readJSON(cachePath, null).catch(() => null);
  if (prior && prior.fingerprint === fp && Array.isArray(prior.events)) {
    events = prior.events; cached = true;                 // unchanged news → reuse, no LLM
  } else {
    const ex = await extractEvents(cand.ticker, { company: cand.company, news, detectedAt: date, timeoutMs: 38000 });
    events = ex.events;
    try { await writeJSON(cachePath, { fingerprint: ex.fingerprint, events, at: new Date().toISOString() }, 0); } catch { /* cache is best-effort */ }
  }
  if (!events.length) return null;

  const clusters = clusterEvents(events);
  const dirGuess = clusters[0] ? clusters[0].primary.direction : 'neutral';
  const consensus = scoreConsensus({
    clusters,
    redundancyModel,
    marketConfirmation: marketConfirmationOf(cand, dirGuess),
    regimeFit: regimeFitOf(regime),
    expectationSaturation: saturationOf(cand),
    freshnessDays: freshnessDays(events, date),
  });
  const thesis = buildThesisChange({ ticker: cand.ticker, clusters, consensus, extras: {} });

  return {
    ticker: cand.ticker, company: cand.company, sector: cand.sector, price: cand.price,
    cached, eventCount: events.length, clusterCount: clusters.length,
    consensus, thesis,
    clusters: clusters.map(c => ({
      fingerprint: c.fingerprint, coverageCount: c.coverageCount, derivativeCount: c.derivativeCount,
      hasPrimarySource: c.hasPrimarySource, family: c.independentFamilies[0] || null, primary: c.primary,
    })),
  };
}

function freshnessDays(events, date) {
  const dates = events.map(e => e.catalystDate || e.detectedAt).filter(Boolean).map(d => String(d).slice(0, 10));
  if (!dates.length) return null;
  const newest = dates.sort().slice(-1)[0];
  const diff = (new Date(date) - new Date(newest)) / 864e5;
  return isFinite(diff) ? Math.max(0, diff) : null;
}

// mapLimit — bounded concurrency (no dep; mirrors the app's own pattern).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// ── op=evidencetick ──────────────────────────────────────────────────────────
async function runEvidenceTick(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.', count: 0 });
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });
  }
  const started = Date.now();
  let redundancyModel = null;
  try { redundancyModel = await require('./redundancy-routes').loadRedundancyModel(); } catch { /* prior rule */ }

  let universe = [], regime = 'neutral';
  try { const u = await attentionUniverse(); universe = u.universe; regime = u.regime; } catch { /* empty */ }
  const rotated = rotateByDay(universe.filter(c => c.ticker), date).slice(0, MAX_TICKERS_PER_TICK);

  const ctx = { date, regime, redundancyModel };
  const results = (await mapLimit(rotated, CONCURRENCY, async (cand) => {
    if (Date.now() - started > DEADLINE_MS) return null;   // time-box: don't start past the wall
    return buildTickerEvidence(cand, ctx);
  })).filter(Boolean);

  // Scoreboard-compatible pick rows: one per name whose thesis actually changed, with a tier
  // by consensus strength, so a new signal folds into runScoreboard exactly like Ghost.
  const signals = results
    .filter(r => r.thesis && r.thesis.changed && r.consensus.state === 'scored')
    .map(r => ({
      date, ts: started, ticker: r.ticker, company: r.company, sector: r.sector,
      section: 'Evidence',
      tier: r.consensus.score >= 60 ? 'EV_STRONG' : r.consensus.score >= 40 ? 'EV_MODERATE' : 'EV_WEAK',
      score: r.consensus.score, direction: r.thesis.level, horizon: r.thesis.horizon,
      entry: r.price, short: r.thesis.directionPressure < 0,  // weakening theses tracked short
    }));

  const snapshot = {
    version: SNAPSHOT_VERSION, regime, universeSize: universe.length, processed: results.length,
    cachedHits: results.filter(r => r.cached).length,
    tookMs: Date.now() - started, results, signals,
  };
  let url = null, err = null;
  try { const w = await writeEvidenceDay(date, snapshot); url = w.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({
    ok: !err, date, regime, universeSize: universe.length, processed: results.length,
    thesisChanges: signals.length, url, error: err, tookMs: snapshot.tookMs,
  });
}

// ── op=evidence (public read, view-filtered) ─────────────────────────────────
const VIEWS = ['all', 'thesis', 'swing', 'longterm', 'contrarian', 'market', 'improving', 'deteriorating'];

function filterView(results, view) {
  const changed = results.filter(r => r.thesis && r.thesis.changed);
  switch (view) {
    case 'thesis': return changed;
    case 'improving': return changed.filter(r => ['improving', 'strengthened'].includes(r.thesis.level));
    case 'deteriorating': return changed.filter(r => ['deteriorating', 'weakened'].includes(r.thesis.level));
    case 'swing': return changed.filter(r => ['swing', 'both'].includes(r.thesis.horizon));
    case 'longterm': return changed.filter(r => ['long_term', 'both'].includes(r.thesis.horizon));
    // Contrarian: news direction disagrees with market confirmation, OR conflicting evidence.
    case 'contrarian': return results.filter(r =>
      (r.thesis && r.consensus && (r.consensus.conflicting ||
        (r.consensus.subscores && r.consensus.direction !== 'neutral' && (r.consensus.subscores.marketConfirm || 0) === 0 && r.consensus.hasPrimarySource))));
    case 'market': return results.filter(r => r.clusters && r.clusters.some(c => ['macro', 'industry'].includes(c.primary.eventType)));
    default: return results;
  }
}

async function runEvidence(req, res) {
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'all';
  const snap = await readLatestEvidence();
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  if (!snap) {
    return res.status(200).json({ ok: true, ready: false, note: 'Evidence snapshot not yet built (runs on the daily cron).', view, results: [] });
  }
  const results = filterView(snap.results || [], view)
    .slice()
    .sort((a, b) => (b.consensus?.score || 0) - (a.consensus?.score || 0));
  return res.status(200).json({
    ok: true, ready: true, view, date: snap.date, regime: snap.regime,
    processed: snap.processed, cachedHits: snap.cachedHits,
    count: results.length, results,
  });
}

// ── op=evidencestock (per-ticker panel) ──────────────────────────────────────
async function runEvidenceStock(req, res) {
  const ticker = String(req.query.ticker || '').toUpperCase().replace(/[^A-Z.^-]/g, '').slice(0, 8);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  if (!ticker) return res.status(400).json({ ok: false, error: 'ticker required' });
  const snap = await readLatestEvidence();
  const found = snap && (snap.results || []).find(r => r.ticker === ticker);
  if (!found) {
    return res.status(200).json({ ok: true, ticker, ready: false, note: 'No evidence for this ticker in the latest snapshot.' });
  }
  return res.status(200).json({ ok: true, ticker, ready: true, date: snap.date, regime: snap.regime, evidence: found });
}

module.exports = {
  runEvidenceTick, runEvidence, runEvidenceStock,
  attentionUniverse, rotateByDay, marketConfirmationOf, regimeFitOf, filterView, VIEWS, SNAPSHOT_VERSION,
};
