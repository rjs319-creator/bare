'use strict';
// op=feed — PUBLIC, READ-ONLY, MACHINE-READABLE day-trade feed.
//
// Purpose: a stable URL an external AI assistant (ChatGPT, Claude, Gemini, …) can fetch and
// read without auth, JavaScript or a browser. It projects the app's two day-trade systems —
// the Day Trade board (lib/screener-routes computeDaytradeBoard) and the Low-Float Ignition
// Radar (lib/lowfloat-routes computeRadar) — into plain markdown (default) or compact JSON
// (?format=json).
//
// AUTHORITY: read-only projection, same contract as op=daytrade / op=lowfloat. Both sources
// are computed with mutate:false — this op can never advance lifecycle state, emit an alert
// or write a research record. Anything else would let an anonymous crawler mint entries.
//
// HONESTY CONTRACT: the disclaimer ships on EVERY response (a reader that only ever sees one
// fetch still sees it), empty lists are stated as empty (never backfilled), and a failed
// source is reported as unavailable rather than silently dropped. Errors are never CDN-cached.

const DISCLAIMER = Object.freeze([
  'READ-ONLY research feed from an automated scanner. Every candidate is PAPER-traded — no entry template has passed the promotion gate and no profitability is claimed.',
  'Scores are interpretable rankings, not probabilities. The app\'s own multi-year validation found no durable standalone edge; treat this as a structured watchlist, not a recommendation.',
  'Bar resolution is 5 minutes with no bid/ask or halt feed. Low-priced and low-float names require a manual spread check before any real order.',
  'Not financial advice. Do your own research.',
]);

const MAX_BEST = 12;
const MAX_IGNITION = 10;
const MAX_LANE_TICKERS = 15;
const CACHE_SECONDS = 60;

// ── helpers ──────────────────────────────────────────────────────────────────
const cell = v => String(v ?? '—').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const num = (v, d = 2) => (Number.isFinite(v) ? +v.toFixed(d) : null);
const numCell = (v, d = 2) => (Number.isFinite(v) ? String(+v.toFixed(d)) : '—');
const pctCell = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(+v).toFixed(1)}%` : '—');
const laneTickers = arr => (Array.isArray(arr) ? arr.map(c => c && c.ticker).filter(Boolean).slice(0, MAX_LANE_TICKERS) : []);

function sessionLabel(now = new Date()) {
  try {
    const { sessionInfoAt } = require('./market-session');
    const s = sessionInfoAt(now);
    return { marketSession: s.marketSession, etDate: s.etDate, isTradingDay: s.isTradingDay };
  } catch {
    return { marketSession: 'unknown', etDate: null, isTradingDay: null };
  }
}

// ── model ────────────────────────────────────────────────────────────────────
// Pure: normalize the two source payloads (either may be null on failure) into the one
// compact model both renderers consume.
function buildFeedModel({ board = null, radar = null, boardError = null, radarError = null, now = new Date() } = {}) {
  const session = sessionLabel(now);

  const best = (board && Array.isArray(board.bestOpportunities) ? board.bestOpportunities : [])
    .slice(0, MAX_BEST)
    .map(p => ({
      rank: p.rank ?? null, ticker: p.ticker, sector: p.sector ?? null, source: p.source ?? null,
      price: num(p.last), dayChangePct: num(p.pctChange, 1), relVol: num(p.relVol, 1),
      relScore: num(p.relScore, 0), carryOddsPct: num(p.carry, 0), overextended: !!p.overextended,
      catalyst: p.catalyst ?? null, lifecycleState: p.lifecycleState ?? null,
      entry: num(p.entry), stop: num(p.stop), target: num(p.target), riskReward: num(p.rr, 1),
      planBasis: p.planBasis ?? null,
    }));

  const lanes = (board && board.lanes) || {};
  const cards = (radar && Array.isArray(radar.records) ? radar.records : [])
    .filter(r => r && r.analyzed !== false && r.stale !== true);
  const ignition = cards
    .slice()
    .sort((a, b) => (b.explosionPotentialScore ?? 0) - (a.explosionPotentialScore ?? 0))
    .slice(0, MAX_IGNITION)
    .map(r => ({
      ticker: r.ticker, company: r.company ?? null, price: num(r.price),
      dayChangePct: num(r.dayChangePct, 1), relativeVolume: num(r.relativeVolume, 1),
      floatTier: r.floatTier ?? null, floatConfidence: r.floatConfidence ?? null,
      explosionPotentialScore: num(r.explosionPotentialScore, 0),
      tradeQualityScore: num(r.tradeQualityScore, 0),
      ignitionState: r.ignitionState ?? null, actionState: r.actionState ?? null,
      headline: r.headline ?? null, catalyst: r.catalyst ?? null, dilutionRisk: r.dilutionRisk ?? null,
      trigger: num(r.trigger), entryZoneLow: num(r.entryZoneLow), entryZoneHigh: num(r.entryZoneHigh),
      invalidation: num(r.invalidation), target1: num(r.target1), target2: num(r.target2),
      riskReward: num(r.riskReward, 1),
    }));

  return {
    generatedAt: new Date(now).toISOString(),
    session,
    regime: (board && board.regime) || (radar && radar.regime) || null,
    sessionDate: (board && board.dataFreshness && board.dataFreshness.sessionDate) || null,
    pacingNote: (board && board.pacingNote) || null,
    disclaimer: DISCLAIMER,
    sources: {
      board: board ? 'ok' : `unavailable${boardError ? ` (${boardError})` : ''}`,
      ignition: radar ? 'ok' : `unavailable${radarError ? ` (${radarError})` : ''}`,
    },
    bestOpportunities: best,
    ignition: { candidates: ignition },
    watchLanes: {
      armed: laneTickers(lanes.armed),
      buildingWatch: laneTickers(lanes.buildingWatch),
      tooExtended: laneTickers(lanes.tooExtended),
    },
  };
}

// ── markdown renderer ────────────────────────────────────────────────────────
function renderFeedMarkdown(m) {
  const L = [];
  L.push('# Day Trade Feed');
  L.push('');
  L.push(`Generated: ${m.generatedAt} · ET session: **${String(m.session.marketSession).toUpperCase()}**`
    + (m.sessionDate ? ` · Data session date: ${m.sessionDate}` : '')
    + (m.regime ? ` · Market regime: ${m.regime}` : ''));
  L.push('');
  for (const d of m.disclaimer) L.push(`> ${d}`);
  L.push('');
  if (m.session.marketSession === 'closed') {
    L.push('_The market is CLOSED. Candidates below (if any) reflect the last computed state and cannot be actionable right now; live candidates appear during regular hours (9:30–16:00 ET, Mon–Fri)._');
    L.push('');
  }
  if (m.pacingNote) { L.push(`_${m.pacingNote}_`); L.push(''); }

  L.push('## Best opportunities (intraday-validated, ranked)');
  L.push('');
  if (m.sources.board !== 'ok') {
    L.push(`_Day Trade board source ${m.sources.board} — this section cannot be shown right now._`);
  } else if (!m.bestOpportunities.length) {
    L.push('_No intraday-validated actionable candidate right now. This is an honest empty state — the scanner is permitted to say there is nothing worth acting on._');
  } else {
    L.push('| # | Ticker | Price | Day | RelVol | Carry odds | Entry | Stop | Target | R:R | Catalyst | State |');
    L.push('|---|--------|-------|-----|--------|-----------|-------|------|--------|-----|----------|-------|');
    for (const p of m.bestOpportunities) {
      L.push(`| ${cell(p.rank)} | ${cell(p.ticker)} | ${numCell(p.price)} | ${pctCell(p.dayChangePct)} | ${numCell(p.relVol, 1)}× | ${p.carryOddsPct != null ? p.carryOddsPct + '%' : '—'} | ${numCell(p.entry)} | ${numCell(p.stop)} | ${numCell(p.target)} | ${numCell(p.riskReward, 1)} | ${cell(p.catalyst)} | ${cell(p.lifecycleState)}${p.overextended ? ' ⚠ overextended' : ''} |`);
    }
    L.push('');
    L.push('_Carry odds = calibrated chance the move keeps carrying ~3 sessions; ~40–60% is normal and mainly flags fade risk. Entry/stop/target are the live recomputed paper plan._');
  }
  L.push('');

  L.push('## Low-float ignition radar (same-session explosion candidates)');
  L.push('');
  if (m.sources.ignition !== 'ok') {
    L.push(`_Ignition radar source ${m.sources.ignition} — this section cannot be shown right now._`);
  } else if (!m.ignition.candidates.length) {
    L.push('_No candidate has analyzable current-session ignition structure right now (an honest empty state — normal outside regular hours)._');
  } else {
    L.push('| Ticker | Price | Day | RelVol | Float | Explosion | Quality | Verdict | Trigger | Entry zone | Invalidation | Targets |');
    L.push('|--------|-------|-----|--------|-------|-----------|---------|---------|---------|-----------|--------------|---------|');
    for (const c of m.ignition.candidates) {
      const zone = (c.entryZoneLow != null && c.entryZoneHigh != null) ? `${numCell(c.entryZoneLow)}–${numCell(c.entryZoneHigh)}` : '—';
      const targets = [c.target1, c.target2].filter(v => v != null).map(v => numCell(v)).join(' / ') || '—';
      L.push(`| ${cell(c.ticker)} | ${numCell(c.price)} | ${pctCell(c.dayChangePct)} | ${numCell(c.relativeVolume, 1)}× | ${cell(c.floatTier)} | ${numCell(c.explosionPotentialScore, 0)} | ${numCell(c.tradeQualityScore, 0)} | ${cell(c.headline)} | ${numCell(c.trigger)} | ${zone} | ${numCell(c.invalidation)} | ${targets} |`);
    }
    L.push('');
    L.push('_Explosion Potential and Trade Quality are separate 0–100 rankings from pre-registered weights — neither is a probability. The Verdict sentence outranks both numbers._');
  }
  L.push('');

  const lanes = m.watchLanes;
  if (lanes.armed.length || lanes.buildingWatch.length || lanes.tooExtended.length) {
    L.push('## Watch lanes (context only — NOT buy signals)');
    L.push('');
    if (lanes.armed.length) L.push(`- **Armed** (setup formed, waiting on trigger): ${lanes.armed.join(', ')}`);
    if (lanes.buildingWatch.length) L.push(`- **Building watch**: ${lanes.buildingWatch.join(', ')}`);
    if (lanes.tooExtended.length) L.push(`- **Too extended — do not chase**: ${lanes.tooExtended.join(', ')}`);
    L.push('');
  }

  L.push('---');
  L.push('_Machine-readable version: append `&format=json` (or `?format=json` on the /feed path). Feed refreshes ~every minute during market hours._');
  L.push('');
  return L.join('\n');
}

// ── route handler ────────────────────────────────────────────────────────────
// deps are injectable for tests; production defaults resolve lazily so requiring this module
// stays cheap for every other tracker op.
async function runFeed(req, res, deps = {}) {
  const t0 = Date.now();
  const computeBoard = deps.computeBoard
    || (opts => require('./screener-routes').computeDaytradeBoard(opts));
  const computeRadar = deps.computeRadar
    || (opts => require('./lowfloat-routes').computeRadar(opts));

  // Per-source isolation: each source resolves to {value} or {error} — one provider outage
  // must degrade one section, never the whole feed.
  const [boardRes, radarRes] = await Promise.all([
    computeBoard({ t0, mutate: false, source: 'feed' })
      .then(out => (out && out.status === 200 && out.payload && out.payload.ok !== false)
        ? { value: out.payload }
        : { error: (out && out.payload && out.payload.error) || `status ${out && out.status}` })
      .catch(e => ({ error: String((e && e.message) || e) })),
    computeRadar({ now: new Date(), t0, mutate: false })
      .then(out => (out && out.ok !== false) ? { value: out } : { error: (out && out.error) || 'radar failed' })
      .catch(e => ({ error: String((e && e.message) || e) })),
  ]);

  const model = buildFeedModel({
    board: boardRes.value || null,
    radar: radarRes.value || null,
    boardError: boardRes.error || null,
    radarError: radarRes.error || null,
    now: new Date(),
  });

  const totalFailure = !boardRes.value && !radarRes.value;
  // Errors must never be pinned into the CDN; a healthy (even honestly-empty) feed
  // coalesces bot traffic at the edge for a minute.
  res.setHeader('Cache-Control', totalFailure
    ? 'no-store'
    : `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`);

  if (String(req.query && req.query.format).toLowerCase() === 'json') {
    return res.status(200).json({
      ok: !totalFailure, readOnly: true, authority: 'read-only-projection', ...model,
    });
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  const md = totalFailure
    ? `# Day Trade Feed\n\n_Feed temporarily unavailable (${cell(boardRes.error)} / ${cell(radarRes.error)}). Try again shortly._\n\n${DISCLAIMER.map(d => `> ${d}`).join('\n')}\n`
    : renderFeedMarkdown(model);
  return res.status(200).send(md);
}

module.exports = { runFeed, buildFeedModel, renderFeedMarkdown, DISCLAIMER };
