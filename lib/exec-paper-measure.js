'use strict';
// PAPER-EXECUTION MEASUREMENT — the paper ledger (lib/exec-paper-ledger rows) read against
// the Scoreboard's own resolution rules. Pure: rows + bars in, numbers out.
//
//   fillRates           fill rate per grade and per time frame (placed vs filled)
//   slippageByTier      `fill − frozenLevel` in bps per lib/costs.js tier, next to the tier's
//                       PRIOR (halfSpread + slippage) so TIERS can be recalibrated by a human —
//                       this module never changes TIERS
//   dailyBarResolution  what the Scoreboard's daily-bar rule (lib/outcome resolveTrade: stop
//                       first on an ambiguous bar, gap-through fills at the open) would have
//                       said for the same row on the same day
//   compareDailyBar     paper exit vs daily-bar exit per row; `sameDayAmbiguous` counts the bars
//                       where BOTH barriers were inside the day's range — the question only a
//                       timestamped fill can answer
//   reconciliationCheck every snapshot row id is in the plan or carries a notPlaced reason
//   summarize           compact read for the Session Board tab + the full block for op=paperexec
//
// HONESTY. Alpaca paper fills on NBBO touch with no queue or impact: every slippage number
// here is a LOWER BOUND on friction. A missing bar yields no comparison, never a guess.

const { TIERS } = require('./costs');
const { resolveTrade } = require('./outcome');

const EXIT_KINDS = Object.freeze(['stop', 'target', 'horizon', 'none']);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r3 = (v) => +v.toFixed(3);
const r1 = (v) => +v.toFixed(1);

// ── Fill rates ───────────────────────────────────────────────────────────────
function rateOf(rows) {
  const placed = rows.length;
  const filled = rows.filter((r) => r && r.filled).length;
  return { placed, filled, rate: placed ? r3(filled / placed) : null };
}
function groupRates(rows, keyOf) {
  const groups = {};
  for (const r of rows) {
    const k = keyOf(r) || 'unknown';
    groups[k] = [...(groups[k] || []), r];
  }
  return Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, rateOf(rs)]));
}
function fillRates(rows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  return { total: rateOf(list), byGrade: groupRates(list, (r) => r.grade), byTimeframe: groupRates(list, (r) => r.timeframe) };
}

// ── Slippage per cost tier ───────────────────────────────────────────────────
// Linear-interpolated quantile on a sorted array (type-7, what most stats packages default to).
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const priorBps = (tier) => { const t = TIERS[tier]; return t ? t.halfSpreadBps + t.slippageBps : null; };

function slippageByTier(rows = []) {
  const byTier = {};
  for (const r of rows) {
    const bps = r && r.filled && r.slippageVsFrozen ? num(r.slippageVsFrozen.bps) : null;
    if (bps == null) continue;
    const tier = r.costTier || 'unknown';
    byTier[tier] = [...(byTier[tier] || []), bps];
  }
  return Object.fromEntries(Object.entries(byTier).map(([tier, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return [tier, {
      n: sorted.length, medianBps: r1(quantile(sorted, 0.5)), p25Bps: r1(quantile(sorted, 0.25)), p75Bps: r1(quantile(sorted, 0.75)),
      meanBps: r1(sorted.reduce((a, b) => a + b, 0) / sorted.length), priorBps: priorBps(tier),
    }];
  }));
}

// ── Daily-bar resolution (the Scoreboard's rule) ─────────────────────────────
const validBar = (b) => b && ['open', 'high', 'low', 'close'].every((k) => num(b[k]) != null && b[k] > 0);

// dailyBarResolution(row, bar) → { exitKind, exitPx, dailyR, dailyRetPct, sameDayAmbiguous } | null
function dailyBarResolution(row, bar) {
  if (!row || !validBar(bar) || num(row.entry) == null || !(num(row.risk) > 0)) return null;
  const short = row.side === 'short';
  const dir = short ? -1 : 1;
  // Two synthetic candles: the signal bar (entry known), then the session under test.
  // resolveTrade enters at `entry` and resolves from h = 1; maxHold 1 makes the close the horizon.
  const res = resolveTrade([{ date: 'signal', open: row.entry, high: row.entry, low: row.entry, close: row.entry }, { date: 'day', ...bar }], 'signal', row.entry, row.stop, row.target, 1, short);
  const exitKind = res.outcome === 'LOSS' ? 'stop' : res.outcome === 'WIN' ? 'target' : 'horizon';
  const stopTouched = short ? bar.high >= row.stop : bar.low <= row.stop;
  const targetTouched = short ? bar.low <= row.target : bar.high >= row.target;
  const exitPx = exitKind === 'horizon' ? bar.close : row.entry * (1 + res.r * dir);
  return {
    exitKind, exitPx: +exitPx.toFixed(4), dailyR: r3((row.entry * res.r) / row.risk), dailyRetPct: r3(res.r * 100),
    sameDayAmbiguous: stopTouched && targetTouched,
  };
}

// compareDailyBar(rows, barByTicker) → { rows, counts }
function compareDailyBar(rows = [], barByTicker = {}) {
  const counts = { placed: 0, compared: 0, agree: 0, disagree: 0, sameDayAmbiguous: 0, paperOpen: 0, notFilled: 0, noBar: 0 };
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    counts.placed++;
    const daily = dailyBarResolution(r, barByTicker && barByTicker[r.symbol]);
    if (!daily) { counts.noBar++; out.push({ rowId: r.rowId, symbol: r.symbol, paperExit: r.exitKind, dailyExit: null, agree: null, sameDayAmbiguous: null, paperR: r.realizedR, dailyR: null }); continue; }
    if (daily.sameDayAmbiguous) counts.sameDayAmbiguous++;
    const comparable = r.filled && r.exitKind !== 'none';
    if (!r.filled) counts.notFilled++;
    else if (r.exitKind === 'none') counts.paperOpen++;
    const agree = comparable ? r.exitKind === daily.exitKind : null;
    if (comparable) { counts.compared++; if (agree) counts.agree++; else counts.disagree++; }
    out.push({ rowId: r.rowId, symbol: r.symbol, paperExit: r.exitKind, dailyExit: daily.exitKind, agree, sameDayAmbiguous: daily.sameDayAmbiguous, paperR: r.realizedR, dailyR: daily.dailyR });
  }
  return { rows: out, counts };
}

// ── Reconciliation ───────────────────────────────────────────────────────────
function reconciliationCheck(snapshotRowIds = [], plan = {}) {
  const ids = Array.isArray(snapshotRowIds) ? snapshotRowIds : [];
  const planned = [...((plan.orders || []).map((o) => o.rowId)), ...((plan.notPlaced || []).map((n) => n.rowId))];
  const seen = new Set();
  const duplicates = [];
  for (const id of planned) { if (seen.has(id)) duplicates.push(id); seen.add(id); }
  const missing = ids.filter((id) => !seen.has(id));
  const snapIds = new Set(ids);
  const extra = [...seen].filter((id) => !snapIds.has(id));
  return { ok: !missing.length && !extra.length && !duplicates.length, missing, extra, duplicates };
}

// ── Summary ──────────────────────────────────────────────────────────────────
function exitCounts(rows) {
  const out = Object.fromEntries(EXIT_KINDS.map((k) => [k, 0]));
  for (const r of rows) if (r && r.filled) out[EXIT_KINDS.includes(r.exitKind) ? r.exitKind : 'none']++;
  return out;
}

function summarize(doc, { barByTicker = null } = {}) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rows)) return { exists: false };
  const rows = doc.rows.filter(Boolean);
  const rates = fillRates(rows);
  const slip = slippageByTier(rows);
  const allBps = rows.filter((r) => r.filled && r.slippageVsFrozen && num(r.slippageVsFrozen.bps) != null).map((r) => r.slippageVsFrozen.bps).sort((a, b) => a - b);
  return {
    exists: true, version: doc.version || null, date: doc.date || null, snapshotId: doc.snapshotId || null,
    placedAt: doc.placedAt || null, lastPollAt: doc.lastPollAt || null, polls: Array.isArray(doc.polls) ? doc.polls.length : 0,
    placed: rates.total.placed, filled: rates.total.filled, fillRate: rates.total.rate,
    notPlaced: (doc.plan && Array.isArray(doc.plan.notPlaced)) ? doc.plan.notPlaced.length : 0,
    medianSlippageBps: allBps.length ? r1(quantile(allBps, 0.5)) : null,
    exits: exitCounts(rows), byGrade: rates.byGrade, byTimeframe: rates.byTimeframe, slippageByTier: slip,
    reconciliation: reconciliationCheck(doc.snapshotRowIds, doc.plan || {}),
    compare: barByTicker ? compareDailyBar(rows, barByTicker) : null,
    disclosure: 'Alpaca paper fills on NBBO touch with no queue or market impact — every friction figure is a lower bound. 1 share per row; sizing is irrelevant to fillability.',
  };
}

module.exports = { EXIT_KINDS, fillRates, slippageByTier, dailyBarResolution, compareDailyBar, reconciliationCheck, summarize, quantile };
