'use strict';
// VRP LIVE PAPER PUT-WRITE (vrp-put-write-live) — op=vrptick (cron) + op=vrpbook (public).
//
// Upgrades the vrp-overlay-synthetic lead (ungated put-write Sharpe 1.03 vs SPY
// 0.80 on one synthetic window) into a PROSPECTIVE ledger at REAL quoted prices:
// every 5th SPY session the tick "sells" one 30-day-nearest ATM SPY put at the
// REAL end-of-day BID (conservative side of a delayed quote), cash-secured, and
// resolves it at expiry to intrinsic. 100% PAPER — no capital, no advice, no
// edge claimed; the preregistered evaluation is years away by design.
//
// FROZEN DESIGN (registry `vrp-put-write-live` is the authority):
//   entry grid   — first tick with no entry in the prior 5 SPY sessions (UNGATED
//                  by registration: the synthetic pass REFUTED the gates)
//   tenor        — listed SPY expiry with DTE in [21, 45] nearest 30 calendar days
//   strike       — listed strike nearest spot, put BID > 0 required (else the
//                  skip is RECORDED, never silently absorbed)
//   settlement   — intrinsic vs the SPY close on the first session ≥ expiry
//   cost         — $1/contract at entry (sell-at-bid already pays the spread)
//   collateral   — strike × 100 per contract (period return = P&L / collateral)
const { nowET } = require('./stats');
const { hasStore, writeVrpDay, readAllVrpDays } = require('./store');
const { fetchDailyHistory } = require('./screener');

const ENTRY_EVERY_SESSIONS = 5;
const TENOR_TARGET_DAYS = 30;
const TENOR_MIN_DTE = 21, TENOR_MAX_DTE = 45;
const COST_PER_CONTRACT = 1;                    // dollars, entry side
const CONTRACT_MULT = 100;

const r2 = (x) => (x == null ? null : +x.toFixed(2));
const r4 = (x) => (x == null ? null : +x.toFixed(4));

// Sessions elapsed between two dates on the SPY bar axis (trading sessions).
function sessionsBetween(bars, fromDate, toDate) {
  let a = -1, b = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date <= fromDate) a = i;
    if (bars[i].date <= toDate) b = i;
  }
  return (a < 0 || b < 0) ? null : b - a;
}

// Pick the frozen-design expiry + ATM put from a Yahoo optionChain result.
// Exported pure for tests: chains = result.options[], spot, nowMs.
function pickPutEntry(result, nowMs) {
  const spot = result?.quote?.regularMarketPrice;
  if (!(spot > 0)) return { skip: 'no-spot' };
  const chains = Array.isArray(result.options) ? result.options : [];
  let best = null;
  for (const ch of chains) {
    const expSec = ch && ch.expirationDate;
    if (!expSec) continue;
    const dte = (expSec * 1000 - nowMs) / 86_400_000;
    if (dte < TENOR_MIN_DTE || dte > TENOR_MAX_DTE) continue;
    if (!best || Math.abs(dte - TENOR_TARGET_DAYS) < Math.abs(best.dte - TENOR_TARGET_DAYS)) {
      best = { ch, dte, expiry: new Date(expSec * 1000).toISOString().slice(0, 10) };
    }
  }
  if (!best) return { skip: 'no-expiry-in-21-45d-window', spot: r2(spot) };
  let put = null;
  for (const p of best.ch.puts || []) {
    if (!(p && p.strike > 0 && p.bid > 0)) continue;   // frozen: a real, non-zero bid or no entry
    if (!put || Math.abs(p.strike - spot) < Math.abs(put.strike - spot)) put = p;
  }
  if (!put) return { skip: 'no-atm-put-with-bid', spot: r2(spot), expiry: best.expiry };
  return {
    spot: r2(spot), expiry: best.expiry, dte: Math.round(best.dte),
    strike: put.strike, bid: put.bid, ask: put.ask ?? null,
    iv: Number.isFinite(put.impliedVolatility) ? r4(put.impliedVolatility) : null,
    oi: put.openInterest ?? null,
  };
}

// Resolve one entry against the SPY bar axis. Returns null while unexpired.
// Exported pure for tests.
function resolveEntry(entry, spyBars) {
  let settleBar = null;
  for (const b of spyBars) { if (b.date >= entry.expiry) { settleBar = b; break; } }
  if (!settleBar) return null;
  const intrinsic = Math.max(0, entry.strike - settleBar.close);
  const pnl = (entry.bid - intrinsic) * CONTRACT_MULT - COST_PER_CONTRACT;
  const collateral = entry.strike * CONTRACT_MULT;
  return {
    settleDate: settleBar.date,
    settleClose: r2(settleBar.close),
    intrinsic: r2(intrinsic),
    pnl: r2(pnl),
    periodReturnPct: r4((pnl / collateral) * 100),
    win: pnl > 0,
  };
}

// ── op=vrptick : resolve matured entries, then enter on the 5-session grid ──
async function runVrpTick(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'vrptick' });
  const t0 = Date.now();
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, op: 'vrptick', skipped: 'market-closed', date });
  }
  const spyD = await fetchDailyHistory('SPY');
  const spy = spyD ? spyD.candles : null;
  if (!spy || !spy.length) return res.status(503).json({ ok: false, op: 'vrptick', error: 'no SPY bars' });
  const lastBarDate = spy[spy.length - 1].date;

  const days = await readAllVrpDays();
  let resolved = 0;
  for (const d of days) {
    const e = d.entry;
    if (!e || d.resolution) continue;
    const r = resolveEntry(e, spy);
    if (r) { await writeVrpDay(d.date, { ...d, resolution: r }); resolved++; }
  }

  // Entry decision on the SPY session axis (frozen 5-session grid).
  const lastEntry = [...days].reverse().find((d) => d.entry);
  const gap = lastEntry ? sessionsBetween(spy, lastEntry.date, lastBarDate) : null;
  let entered = null, entrySkip = null;
  if (!lastEntry || (gap != null && gap >= ENTRY_EVERY_SESSIONS)) {
    try {
      const { fetchChainMultiExpiry } = require('./options-baseline');
      const result = await fetchChainMultiExpiry('SPY', { targets: [TENOR_TARGET_DAYS], maxExtra: 2 });
      const pick = result ? pickPutEntry(result, Date.now()) : { skip: 'no-chain' };
      if (pick.skip) {
        entrySkip = pick.skip;
        await writeVrpDay(date, { entrySkipped: pick, sessionsSinceLast: gap });
      } else {
        entered = pick;
        await writeVrpDay(date, { entry: { ...pick, entryDate: date }, sessionsSinceLast: gap });
      }
    } catch (e2) {
      entrySkip = `chain-error:${String((e2 && e2.message) || e2).slice(0, 80)}`;
      await writeVrpDay(date, { entrySkipped: { skip: entrySkip }, sessionsSinceLast: gap });
    }
  }
  return res.status(200).json({
    ok: true, op: 'vrptick', date, resolved,
    entered: entered ? { expiry: entered.expiry, strike: entered.strike, bid: entered.bid } : null,
    entrySkip, sessionsSinceLast: gap, elapsedMs: Date.now() - t0,
  });
}

// ── op=vrpbook : PUBLIC paper track-record read ─────────────────────────────
async function runVrpBook(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'vrpbook' });
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  const days = await readAllVrpDays();
  const entries = days.filter((d) => d.entry);
  const open = entries.filter((d) => !d.resolution).map((d) => ({
    entryDate: d.date, expiry: d.entry.expiry, strike: d.entry.strike,
    premium: r2(d.entry.bid * CONTRACT_MULT), spotAtEntry: d.entry.spot, iv: d.entry.iv, dte: d.entry.dte,
  }));
  const done = entries.filter((d) => d.resolution);
  const rets = done.map((d) => d.resolution.periodReturnPct);
  const wins = done.filter((d) => d.resolution.win).length;
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const skips = days.filter((d) => d.entrySkipped).map((d) => ({ date: d.date, reason: d.entrySkipped.skip }));
  return res.status(200).json({
    ok: true, op: 'vrpbook', bookId: 'vrp-put-write-live',
    paper: true,
    design: { entryEverySessions: ENTRY_EVERY_SESSIONS, tenorTargetDays: TENOR_TARGET_DAYS, side: 'sell-at-bid', costPerContract: COST_PER_CONTRACT },
    open,
    resolved: {
      n: done.length, wins,
      winRate: done.length ? +(wins / done.length).toFixed(3) : null,
      avgPeriodReturnPct: r4(mean(rets)),
      totalPnl: r2(done.reduce((s, d) => s + d.resolution.pnl, 0)),
      history: done.slice(-24).map((d) => ({
        entryDate: d.date, expiry: d.entry.expiry, strike: d.entry.strike,
        premium: r2(d.entry.bid * CONTRACT_MULT), settleClose: d.resolution.settleClose,
        pnl: d.resolution.pnl, periodReturnPct: d.resolution.periodReturnPct,
      })),
    },
    entrySkips: skips.slice(-10),
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runVrpTick, runVrpBook, pickPutEntry, resolveEntry, ENTRY_EVERY_SESSIONS, TENOR_MIN_DTE, TENOR_MAX_DTE, COST_PER_CONTRACT };
