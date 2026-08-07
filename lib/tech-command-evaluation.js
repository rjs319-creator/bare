'use strict';
// PROSPECTIVE EVALUATION LEDGER — tech-command-evaluation-v1.
//
// Separate, immutable, per-horizon evaluation records. Written once per session
// day by the authenticated tick and never rewritten, so the record of what the
// page said cannot drift after the fact.
//
// DAY TRADE reuses the frozen engine's OWN decision and execution contract. This
// module records only a POINTER (ticker, setupId, action, timestamp) so the
// technology projection can be joined to the engine's ledger later. It does not
// duplicate or reimplement Day Trade label logic — doing so would create a second,
// competing definition of the same outcome.
//
// SWING is graded on the NEXT SESSION's executable entry: the fill is simulated at
// the first bar after the decision was visible, no-fill and gap-skip are recorded
// as outcomes in their own right, costs are charged at base / doubled / stressed,
// and 5-, 10- and 21-session results are SEPARATE labels (never pooled).
//
// LONG TERM is separately versioned at 63 / 126 / 252 sessions against QQQ and the
// name's subsector benchmark, with turnover and implementation cost charged.
//
// A name whose price history cannot be retrieved at resolution time resolves to
// UNRESOLVABLE_NO_DATA — never to zero, and never silently dropped.

const { readJSON, writeJSON, hasStore } = require('./store');

const EVAL_VERSION = 'tech-command-evaluation-v1';
const SWING_MODEL_VERSION = 'tech-command-swing-v1';
const LONGTERM_MODEL_VERSION = 'tech-command-longterm-v1';

const SWING_HORIZONS = Object.freeze([5, 10, 21]);
const LONGTERM_HORIZONS = Object.freeze([63, 126, 252]);

// Documented, conservative round-trip cost in basis points, charged at three
// severities so a result that only survives the base case is visibly fragile.
const COST_BPS = Object.freeze({ base: 20, doubled: 40, stressed: 80 });
const MAX_GAP_SKIP_PCT = 3.0;   // a gap beyond this above the trigger = no fill, not a fill at the gap

const KEYS = Object.freeze({
  day: d => `techcommand/eval/${d}.json`,
  index: 'techcommand/eval/index.json',
  resolved: 'techcommand/eval-resolved.json',
});

const iso = d => new Date(d).toISOString();
const num = v => (Number.isFinite(v) ? v : null);

/**
 * Write the immutable decision record for this session day. Write-once: if a
 * record already exists for the date it is NOT overwritten (the first decision of
 * the day is the point-in-time one).
 */
async function record({ snapshot, now = new Date() } = {}) {
  if (!hasStore()) return { written: 0, note: 'no store configured' };
  const date = (snapshot && snapshot.sessionDate) || iso(now).slice(0, 10);
  const existing = await readJSON(KEYS.day(date), null).catch(() => null);
  if (existing) return { written: 0, note: `evaluation record for ${date} already exists — write-once, not overwritten` };

  const doc = {
    schema: EVAL_VERSION,
    date,
    recordedAt: iso(now),
    marketSession: snapshot.marketSession,
    versions: {
      snapshot: snapshot.schema,
      swingModel: SWING_MODEL_VERSION,
      longtermModel: LONGTERM_MODEL_VERSION,
      universe: snapshot.universe ? snapshot.universe.schema : null,
      taxonomy: snapshot.universe ? snapshot.universe.taxonomyVersion : null,
      regime: snapshot.regime ? snapshot.regime.schema : null,
    },
    regime: snapshot.regime ? { classification: snapshot.regime.classification, states: snapshot.regime.states } : null,
    // ── Day trade: pointer only ─────────────────────────────────────────────
    daytrade: {
      gradedBy: 'the frozen Day Trade engine\'s own decision/execution contract (lib/intraday-dataset + op=daytradebook). Not re-graded here.',
      pointers: ((snapshot.daytrade && snapshot.daytrade.rows) || []).map(r => ({
        ticker: r.ticker, setupId: r.setupId, action: r.action, lifecycleState: r.lifecycleState,
        at: r.lastEvaluatedAt || null, subsector: r.subsector,
      })),
    },
    // ── Swing: full candidate set INCLUDING rejections ──────────────────────
    swing: {
      modelVersion: SWING_MODEL_VERSION,
      horizonsSessions: SWING_HORIZONS,
      benchmark: 'QQQ + subsector benchmark',
      candidates: ((snapshot.swing && snapshot.swing.rows) || []).map(r => ({
        ticker: r.ticker, subsector: r.subsector, benchmark: benchmarkOf(snapshot, r.ticker),
        action: r.action, side: r.side, selected: r.action === 'ENTER',
        rejectedBecause: r.action === 'ENTER' ? null : (r.gatesFailed || []),
        signalClass: r.signalClass, sizingEligible: r.sizingEligible,
        trigger: num(r.trigger), invalidation: num(r.invalidation), target: num(r.target),
        priceAtDecision: num(r.price), governedScore: num(r.governedScore),
        evidenceQuality: r.evidence ? r.evidence.evidenceQuality : null,
        decidedAt: r.lastEvaluatedAt || iso(now),
      })),
    },
    // ── Long term: full candidate set INCLUDING rejections ──────────────────
    longterm: {
      modelVersion: LONGTERM_MODEL_VERSION,
      horizonsSessions: LONGTERM_HORIZONS,
      benchmark: 'QQQ + subsector benchmark',
      candidates: ((snapshot.longterm && snapshot.longterm.rows) || []).map(r => ({
        ticker: r.ticker, subsector: r.subsector, benchmark: benchmarkOf(snapshot, r.ticker),
        action: r.action, selected: r.action === 'ACCUMULATE',
        rejectedBecause: r.action === 'ACCUMULATE' ? null : [r.action],
        score: num(r.score), evidenceQuality: r.evidenceQuality,
        dataCompletenessPct: num(r.dataCompletenessPct),
        decidedAt: r.lastEvaluatedAt || iso(now),
      })),
    },
    governance: {
      championChallenger: 'This page runs no champion/challenger promotion of its own. The swing board inherits the app\'s central eligibility gate; the day-trade board is a read-only view of a frozen engine.',
      promotion: 'No automatic promotion exists. A model here can only ever be promoted by the app\'s existing human-approved governance ops (op=modelpromote / op=modelpromotelive).',
      safetyDemotion: 'Any horizon can be demoted by its source gate at any time without approval.',
      inference: 'When enough resolved records accrue, inference must use purged walk-forward folds with HAC standard errors and a moving-block bootstrap, an effective-sample-size calculation, and a multiple-testing correction across horizons and subsectors. Until then no result may be reported as evidence of edge.',
      costs: COST_BPS,
    },
    alphaClaim: false,
    alphaClaimNote: 'Recording decisions is not evidence of edge. No claim of predictive power is made by the existence of this ledger.',
  };

  await writeJSON(KEYS.day(date), doc, 0);
  try {
    const idx = await readJSON(KEYS.index, { dates: [] }).catch(() => ({ dates: [] }));
    const dates = [...new Set([...(idx.dates || []), date])].sort().slice(-400);
    await writeJSON(KEYS.index, { dates, updatedAt: iso(now) }, 0);
  } catch { /* index is a convenience; the day files are the truth */ }

  return { written: 1, note: `wrote immutable evaluation record for ${date}` };
}

function benchmarkOf(snapshot, ticker) {
  const u = snapshot.universe && snapshot.universe.byTicker && snapshot.universe.byTicker[ticker];
  return u ? u.benchmark : null;
}

// ── Resolution ──────────────────────────────────────────────────────────────
/**
 * Resolve every decision day whose horizons have matured and that has not been
 * resolved yet. Bounded per run.
 */
async function resolve({ now = new Date(), limitDays = 10 } = {}) {
  if (!hasStore()) return { resolved: 0, note: 'no store configured' };
  const idx = await readJSON(KEYS.index, { dates: [] }).catch(() => ({ dates: [] }));
  const resolvedDoc = await readJSON(KEYS.resolved, { days: {}, updatedAt: null }).catch(() => ({ days: {} }));
  const done = resolvedDoc.days || {};
  const todo = (idx.dates || [])
    .filter(d => !done[d] || !done[d].complete)
    .sort()
    .slice(0, limitDays);
  if (!todo.length) return { resolved: 0, pendingDays: 0, note: 'nothing matured to resolve' };

  const { fetchDailyHistory } = require('./screener');
  const candleCache = new Map();
  const candlesFor = async (t) => {
    if (candleCache.has(t)) return candleCache.get(t);
    let c = null;
    try { const h = await fetchDailyHistory(t, '2y'); c = (h && h.candles) || null; } catch { c = null; }
    candleCache.set(t, c);
    return c;
  };

  let resolvedCount = 0;
  for (const date of todo) {
    const day = await readJSON(KEYS.day(date), null).catch(() => null);
    if (!day) { done[date] = { complete: true, note: 'decision record unreadable' }; continue; }
    const swing = [];
    for (const c of (day.swing && day.swing.candidates) || []) {
      swing.push(await resolveSwing(c, date, candlesFor));
    }
    const longterm = [];
    for (const c of (day.longterm && day.longterm.candidates) || []) {
      longterm.push(await resolveLongTerm(c, date, candlesFor));
    }
    const allMature = [...swing, ...longterm].every(r => r.complete);
    done[date] = {
      complete: allMature,
      resolvedAt: iso(now),
      swing, longterm,
      counts: {
        swing: swing.length, longterm: longterm.length,
        unresolvable: [...swing, ...longterm].filter(r => r.status === 'UNRESOLVABLE_NO_DATA').length,
      },
    };
    resolvedCount++;
  }

  await writeJSON(KEYS.resolved, { schema: EVAL_VERSION, days: done, updatedAt: iso(now) }, 0);
  return {
    resolved: resolvedCount,
    pendingDays: (idx.dates || []).filter(d => !done[d] || !done[d].complete).length,
    note: 'Resolved outcomes are recorded. They are NOT a claim of edge until the full inference protocol runs over them.',
  };
}

/** Next-session executable entry, with no-fill / gap-skip as first-class outcomes. */
async function resolveSwing(c, date, candlesFor) {
  const base = { ticker: c.ticker, horizon: 'swing', action: c.action, selected: c.selected, decisionDate: date };
  if (!c.selected) return { ...base, status: 'NOT_SELECTED', rejectedBecause: c.rejectedBecause || [], complete: true };
  const candles = await candlesFor(c.ticker);
  if (!candles || !candles.length) return { ...base, status: 'UNRESOLVABLE_NO_DATA', complete: true, note: 'No price history could be retrieved — the security may be delisted or renamed. Recorded as unresolvable, not as a zero return.' };

  const i0 = candles.findIndex(x => x.date > date);
  if (i0 < 0) return { ...base, status: 'PENDING', complete: false, note: 'The next session has not printed yet.' };

  const long = c.side !== 'short';
  const trig = num(c.trigger);
  const nextBar = candles[i0];
  // Gap-skip: an open beyond the trigger by more than the tolerance is NOT a fill
  // at the gap — it is a missed entry, and it is recorded as one.
  let fill = null, status = null;
  if (trig == null) { fill = nextBar.open; status = 'FILLED_AT_OPEN_NO_TRIGGER'; }
  else {
    const gapPct = ((nextBar.open - trig) / trig) * 100 * (long ? 1 : -1);
    if (gapPct > MAX_GAP_SKIP_PCT) status = 'NO_FILL_GAP_SKIP';
    else if (long ? nextBar.high >= trig : nextBar.low <= trig) {
      // Fill at the trigger, or at the open when the session already opened through
      // it (inside the gap tolerance) — never at a price better than the open.
      fill = long ? Math.max(trig, nextBar.open) : Math.min(trig, nextBar.open);
      status = 'FILLED';
    } else status = 'NO_FILL_TRIGGER_NOT_TAKEN';
  }
  if (status !== 'FILLED' && status !== 'FILLED_AT_OPEN_NO_TRIGGER') {
    return { ...base, status, complete: true, fillPrice: null, note: 'No executable fill — recorded as a non-trade, not as a flat return.' };
  }

  const bench = await candlesFor('QQQ');
  const sub = c.benchmark && c.benchmark !== 'QQQ' ? await candlesFor(c.benchmark) : null;
  const horizons = {};
  let complete = true;
  for (const h of SWING_HORIZONS) {
    const end = i0 + h;
    if (end >= candles.length) { horizons[`h${h}`] = { status: 'PENDING' }; complete = false; continue; }
    const path = candles.slice(i0, end + 1);
    horizons[`h${h}`] = pathOutcome({ path, fill, long, invalidation: num(c.invalidation), target: num(c.target), bench, sub, i0, h, date });
  }
  return { ...base, status: 'FILLED', fillPrice: +fill.toFixed(4), fillDate: nextBar.date, horizons, complete };
}

async function resolveLongTerm(c, date, candlesFor) {
  const base = { ticker: c.ticker, horizon: 'longterm', action: c.action, selected: c.selected, decisionDate: date };
  if (!c.selected) return { ...base, status: 'NOT_SELECTED', rejectedBecause: c.rejectedBecause || [], complete: true };
  const candles = await candlesFor(c.ticker);
  if (!candles || !candles.length) return { ...base, status: 'UNRESOLVABLE_NO_DATA', complete: true, note: 'No price history could be retrieved — the security may be delisted or renamed.' };
  const i0 = candles.findIndex(x => x.date > date);
  if (i0 < 0) return { ...base, status: 'PENDING', complete: false };
  const entry = candles[i0].open;
  const bench = await candlesFor('QQQ');
  const sub = c.benchmark && c.benchmark !== 'QQQ' ? await candlesFor(c.benchmark) : null;
  const horizons = {};
  let complete = true;
  for (const h of LONGTERM_HORIZONS) {
    const end = i0 + h;
    if (end >= candles.length) { horizons[`h${h}`] = { status: 'PENDING' }; complete = false; continue; }
    const grossPct = ((candles[end].close - entry) / entry) * 100;
    horizons[`h${h}`] = {
      status: 'RESOLVED',
      grossPct: +grossPct.toFixed(2),
      netPct: costScenarios(grossPct),
      // One entry and one exit over the whole horizon — turnover is 1 round trip.
      turnoverRoundTrips: 1,
      vsQqqPct: relativeTo(bench, candles[i0].date, candles[end].date, grossPct),
      vsSubsectorPct: relativeTo(sub, candles[i0].date, candles[end].date, grossPct),
    };
  }
  return { ...base, status: 'HELD', entryPrice: +entry.toFixed(4), entryDate: candles[i0].date, horizons, complete };
}

/** Path-dependent outcome: MFE, MAE, stop/target/time exit, drawdown, benchmarks. */
function pathOutcome({ path, fill, long, invalidation, target, bench, sub, i0, h }) {
  let mfe = 0, mae = 0, exit = null, exitReason = 'time', maxDD = 0, peak = fill;
  for (const bar of path.slice(1)) {
    const fav = long ? (bar.high - fill) / fill : (fill - bar.low) / fill;
    const adv = long ? (bar.low - fill) / fill : (fill - bar.high) / fill;
    mfe = Math.max(mfe, fav * 100);
    mae = Math.min(mae, adv * 100);
    peak = long ? Math.max(peak, bar.high) : Math.min(peak, bar.low);
    const dd = long ? (bar.low - peak) / peak : (peak - bar.high) / peak;
    maxDD = Math.min(maxDD, dd * 100);
    if (invalidation != null && (long ? bar.low <= invalidation : bar.high >= invalidation)) { exit = invalidation; exitReason = 'stop'; break; }
    if (target != null && (long ? bar.high >= target : bar.low <= target)) { exit = target; exitReason = 'target'; break; }
  }
  if (exit == null) { exit = path[path.length - 1].close; exitReason = 'time'; }
  const grossPct = ((long ? (exit - fill) : (fill - exit)) / fill) * 100;
  return {
    status: 'RESOLVED',
    exitReason, exitPrice: +exit.toFixed(4),
    grossPct: +grossPct.toFixed(2),
    netPct: costScenarios(grossPct),
    mfePct: +mfe.toFixed(2), maePct: +mae.toFixed(2), maxDrawdownPct: +maxDD.toFixed(2),
    vsQqqPct: relativeTo(bench, path[0].date, path[path.length - 1].date, grossPct),
    vsSubsectorPct: relativeTo(sub, path[0].date, path[path.length - 1].date, grossPct),
  };
}

function costScenarios(grossPct) {
  return {
    base: +(grossPct - COST_BPS.base / 100).toFixed(2),
    doubled: +(grossPct - COST_BPS.doubled / 100).toFixed(2),
    stressed: +(grossPct - COST_BPS.stressed / 100).toFixed(2),
  };
}

function relativeTo(benchCandles, fromDate, toDate, grossPct) {
  if (!benchCandles || !benchCandles.length) return null;
  const a = benchCandles.find(x => x.date >= fromDate);
  let b = null;
  for (const x of benchCandles) { if (x.date <= toDate) b = x; else break; }
  if (!a || !b || !(a.close > 0) || b.date < a.date) return null;
  const benchPct = ((b.close - a.close) / a.close) * 100;
  return +(grossPct - benchPct).toFixed(2);
}

/** Ledger status for op=techcommandhealth. */
async function status() {
  // The no-edge disclosure travels with EVERY status, including the no-store one:
  // an unconfigured ledger is even less evidence of edge than an empty one.
  const disclosure = {
    swingHorizons: SWING_HORIZONS, longtermHorizons: LONGTERM_HORIZONS, costScenariosBps: COST_BPS,
    edgeClaim: false,
  };
  if (!hasStore()) {
    return {
      ...disclosure, storeConfigured: false, decisionDays: 0, resolvedDays: 0, fullyResolvedDays: 0,
      edgeNote: 'No durable store is configured, so no prospective record exists at all. Nothing here is evidence of edge. Software tests do not prove investment alpha.',
    };
  }
  const [idx, res] = await Promise.all([
    readJSON(KEYS.index, { dates: [] }).catch(() => ({ dates: [] })),
    readJSON(KEYS.resolved, { days: {} }).catch(() => ({ days: {} })),
  ]);
  const dates = idx.dates || [];
  const days = res.days || {};
  const complete = Object.values(days).filter(d => d && d.complete).length;
  return {
    ...disclosure,
    storeConfigured: true,
    decisionDays: dates.length,
    firstDecisionDate: dates[0] || null,
    latestDecisionDate: dates[dates.length - 1] || null,
    resolvedDays: Object.keys(days).length,
    fullyResolvedDays: complete,
    swingHorizons: SWING_HORIZONS,
    longtermHorizons: LONGTERM_HORIZONS,
    costScenariosBps: COST_BPS,
    edgeClaim: false,
    edgeNote: `Prospective records only. With ${dates.length} decision day(s) recorded, no inference has been run and no edge is claimed. Software tests do not prove investment alpha.`,
  };
}

module.exports = {
  EVAL_VERSION, SWING_MODEL_VERSION, LONGTERM_MODEL_VERSION,
  SWING_HORIZONS, LONGTERM_HORIZONS, COST_BPS, MAX_GAP_SKIP_PCT, KEYS,
  record, resolve, resolveSwing, resolveLongTerm, pathOutcome, costScenarios, relativeTo, status,
};
