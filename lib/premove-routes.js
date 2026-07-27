'use strict';
// PRE-MOVE INVENTORY routes — Phases 8-10 of the redesign
// (docs/premove-transition-v2.md). Folded into api/tracker.js:
//
//   op=premove     : the server-authoritative shadow inventory (read, cached)
//   op=premovelog  : cron-only — capture the IMMUTABLE daily cross-section
//                    (selected + rejected + near-miss + controls, features +
//                    missingness masks, versions, regime) under premove/…
//
// SHADOW CONTRACT: this system is weight-zero. It reads the artifacts other
// shadow systems already persist (ATLAS-X episodes/board, the Ghost
// full-candidate observation, the Coil ledger) and derives the pre-move states
// from the Swing Episode Supervisor lifecycle (via the ATLAS-X episode book).
// It never touches op=today, ranks, or Day Trade anything.

const { readJSON, writeJSON, hasStore, readAllGhostObsDays, readAllCoilDays } = require('./store');
const { nowET, isMarketHoliday } = require('./stats');
const { loadCandleCache, cacheGet } = require('./candle-cache');
const { premoveGate, resolvePremoveMode, LIVE_VERSIONS } = require('./premove-flags');
const { computePremoveFeatures, PREMOVE_FEATURE_VERSION } = require('./premove-features');
const SA = require('./premove-stage-a');
const SB = require('./premove-stage-b');
const INV = require('./premove-inventory');
const STORE = require('./atlasx-store');
const LB = require('./research/live-bridge');

const STAGE_A_MODEL_PATH = 'premove/model-stage-a.json';
const CALIBRATION_PATH = 'premove/calibration.json';
const PROMOTION_PATH = 'premove/promotion.json';
const CROSS_SECTION_PREFIX = 'premove/cross-section/';
const MAX_CANDIDATES = 120;                        // serverless budget for feature computation
const ARMED_PROXIMITY = 0.02;                      // within 2% of the trigger = "near trigger"

const num = (v) => (Number.isFinite(v) ? v : null);

// Assemble the candidate set from the shadow artifacts (bounded, deduped, with
// provenance). Order matters (deterministic): open episodes → ghost standalone
// → coil selected → coil controls.
async function assembleCandidates() {
  const [episodes, ghostDays, coilDays] = await Promise.all([
    STORE.loadEpisodes().catch(() => []),
    readAllGhostObsDays().catch(() => []),
    readAllCoilDays().catch(() => []),
  ]);
  const latestGhost = ghostDays.length ? ghostDays[ghostDays.length - 1] : null;
  const latestCoil = coilDays.length ? coilDays[coilDays.length - 1] : null;

  const byTicker = new Map();
  const add = (ticker, src, extra = {}) => {
    if (!ticker) return;
    const prev = byTicker.get(ticker);
    if (prev) { if (!prev.sources.includes(src)) prev.sources.push(src); Object.assign(prev, { ...extra, ...prev }); return; }
    byTicker.set(ticker, { ticker, sources: [src], ...extra });
  };
  for (const ep of episodes) {
    if (ep && !ep.terminal && ep.origin) add(ep.origin.ticker, 'atlasx-episode', { episode: ep, company: ep.origin.company || null, sector: ep.origin.sector || null, entry: num(ep.origin.entry), stop: num(ep.origin.stop), target: num(ep.origin.target) });
  }
  for (const r of (latestGhost && latestGhost.selected) || []) {
    add(r.ticker, 'ghost-standalone', { company: r.company, sector: r.sector, entry: num(r.triggerLevel), stop: num(r.invalidation), target: num(r.target), selected: true });
  }
  for (const r of (latestGhost && latestGhost.nearThreshold) || []) add(r.ticker, 'ghost-near-threshold', { sector: r.sector, selected: false });
  for (const r of (latestCoil && latestCoil.picks) || []) {
    add(r.ticker, r.selected === false ? 'coil-control' : 'coil-selected', {
      sector: r.sector || null, selected: r.selected !== false,
      entry: r.plan ? num(r.plan.entry) : null, stop: r.plan ? num(r.plan.stop) : null, target: r.plan ? num(r.plan.target) : null,
      dailyVol: num(r.dailyVol),
    });
  }
  return { candidates: [...byTicker.values()].slice(0, MAX_CANDIDATES), counts: { episodes: episodes.filter(e => e && !e.terminal).length, ghostDay: latestGhost ? latestGhost.date : null, coilDay: latestCoil ? latestCoil.date : null } };
}

// Candle lookup across the cached scopes (read-only; no live fan-out here).
async function buildCandleLookup(tickers) {
  const docs = [];
  for (const scope of ['large', 'small', 'micro', 'expanded']) {
    const d = await loadCandleCache(scope).catch(() => null);
    if (d) docs.push(d);
  }
  const map = new Map();
  for (const t of tickers) {
    for (const d of docs) {
      const g = cacheGet(d, t);
      if (g && g.candles && g.candles.length) { map.set(t, g.candles); break; }
    }
  }
  // Benchmark for residual features.
  let spy = null;
  for (const d of docs) { const g = cacheGet(d, 'SPY'); if (g && g.candles) { spy = g.candles; break; } }
  return { map, spy };
}

async function buildInventory() {
  const { date } = nowET();
  const mode = resolvePremoveMode();
  const [modelArtifact, calibrationArtifact] = await Promise.all([
    readJSON(STAGE_A_MODEL_PATH, null).catch(() => null),
    readJSON(CALIBRATION_PATH, null).catch(() => null),
  ]);
  // The DISPLAY gate keys off the calibration artifact; the MODEL artifact only
  // decides whether a fitted score (vs the transparent baseline rank) exists.
  const gate = premoveGate({ mode, artifact: calibrationArtifact, kind: 'calibration' });

  const { candidates, counts } = await assembleCandidates();
  const { map, spy } = await buildCandleLookup(candidates.map(c => c.ticker));

  const entries = [];
  for (const c of candidates) {
    const candles = map.get(c.ticker) || null;
    const fs = candles ? computePremoveFeatures({ candles, benchCandles: spy, asOf: date, plan: c.entry && c.stop ? { entry: c.entry, stop: c.stop, target: c.target } : null }) : null;
    entries.push({ ...c, features: fs ? fs.values : null, missing: fs ? fs.missing : ['no-candles'], residualBasis: fs ? fs.residualBasis : null, candles });
  }

  const model = modelArtifact && modelArtifact.status === 'fitted' ? modelArtifact : null;
  const cross = SA.stageACrossSection(entries.map(e => ({ ticker: e.ticker, features: e.features })), model, gate);
  const crossBy = new Map(cross.map(r => [r.ticker, r]));

  const boardEntries = entries.map(e => {
    const last = e.candles && e.candles.length ? e.candles[e.candles.length - 1] : null;
    const nearTrigger = !!(last && e.entry > 0 && last.close < e.entry && (e.entry - last.close) / e.entry <= ARMED_PROXIMITY);
    // Stage B activates only on an objective trigger read from the latest bar.
    let stageB = null;
    if (last && e.entry > 0 && e.stop > 0 && e.target > e.entry) {
      const seg = e.candles.slice(-21, -1);
      const base = seg.length ? {
        meanRange20: seg.reduce((s, b) => s + (b.high - b.low), 0) / seg.length,
        meanVol20: seg.reduce((s, b) => s + (Number.isFinite(b.volume) ? b.volume : 0), 0) / seg.length,
      } : {};
      const trig = SB.evaluateTrigger({ bar: last, level: e.entry, base });
      const dailyVol = e.dailyVol || (fsVol(e.candles));
      if (trig.triggered && dailyVol > 0) {
        stageB = SB.assessStageB({ trigger: trig, current: last.close, entry: e.entry, stop: e.stop, target: e.target, dailyVol, tier: 'small' });
      } else if (trig.triggered) {
        stageB = { version: SB.STAGE_B_VERSION, state: 'NO_VOL', action: 'wait', reason: 'no decision-time volatility', probabilities: null, waterfall: null };
      }
    }
    const state = INV.premoveState({ assessment: e.episode ? e.episode.assessment : null, nearTrigger }, stageB);
    return {
      ticker: e.ticker, company: e.company || null, sector: e.sector || null,
      state,
      stageA: crossBy.get(e.ticker) || {},
      stageB,
      invalidation: e.stop ?? null,
      timeframeSessions: 21,
      features: e.features,
      missing: e.missing,
      residualBasis: e.residualBasis,
      displacement: e.episode && e.episode.assessment ? e.episode.assessment.displacement || null : null,
      featureVersion: PREMOVE_FEATURE_VERSION,
      sources: e.sources,
      selected: e.selected !== false,
    };
  });

  const board = INV.buildInventoryBoard(boardEntries, gate);
  return {
    date, mode, gate, board, counts,
    candidates: boardEntries,
    versions: { ...LIVE_VERSIONS, stageA: SA.STAGE_A_VERSION, stageB: SB.STAGE_B_VERSION, inventory: INV.PREMOVE_INVENTORY_VERSION },
    modelArtifact: model ? { status: model.status, n: model.n, version: model.version } : { status: 'none', note: 'no trained Stage-A artifact — transparent baseline rank only' },
  };
}

async function runPremove(req, res) {
  const inv = await buildInventory();
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, generatedAt: new Date().toISOString(),
    ...inv,
    candidates: undefined,                       // full rows live in the log capture, not the read payload
    note: 'Pre-move transition inventory (SHADOW, weight-zero). States derive from the Swing Episode Supervisor lifecycle; probabilities appear only behind a valid calibration artifact.',
  });
}

// op=premovelog — the immutable daily full cross-section (Phase 10). Write-once
// per date: an existing snapshot is never overwritten (append-only history).
async function runPremoveLog(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.', written: false });
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'market-closed', date, written: false });
  }
  const path = `${CROSS_SECTION_PREFIX}${date}.json`;
  const existing = await readJSON(path, null).catch(() => null);
  if (existing) return res.status(200).json({ ok: true, skipped: 'already-recorded (immutable)', date, written: false });

  const inv = await buildInventory();
  const axis = LB.forwardSessionAxis(date, { isHoliday: isMarketHoliday });
  const snapshot = {
    schema: 'PremoveCrossSection', date,
    eligibleEntryDate: LB.nextSessionAfter(date, axis),
    versions: inv.versions,
    mode: inv.mode,
    regime: null,                                 // stamped by the reader against the day's regime doc; never invented here
    // Full cross-section: selected AND rejected/control rows with the complete
    // feature snapshot + missingness mask (the anti-selection-bias capture).
    rows: inv.candidates.map(c => ({
      ticker: c.ticker, sector: c.sector, state: c.state, sources: c.sources,
      selected: c.selected,
      invalidation: c.invalidation,
      preMoveRank: c.stageA ? c.stageA.preMoveRank : null,
      evidenceBand: c.stageA ? c.stageA.evidenceBand : null,
      features: c.features || null,
      missing: c.missing || [],
      residualBasis: c.residualBasis || null,
    })),
    counts: inv.board.counts,
  };
  let url = null, err = null;
  try { const r = await writeJSON(path, { ...snapshot, savedAt: new Date().toISOString() }, 0); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, written: !err, url, error: err, counts: inv.board.counts });
}

function fsVol(candles) {
  if (!Array.isArray(candles) || candles.length < 22) return null;
  const rets = [];
  for (let i = candles.length - 20; i < candles.length; i++) {
    if (candles[i - 1] && candles[i - 1].close > 0) rets.push(candles[i].close / candles[i - 1].close - 1);
  }
  if (rets.length < 10) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
}

module.exports = { runPremove, runPremoveLog, buildInventory, assembleCandidates, STAGE_A_MODEL_PATH, CALIBRATION_PATH, PROMOTION_PATH, CROSS_SECTION_PREFIX };
