'use strict';
// STRUCTURED BEAR CASE — route handlers (weight 0; display-only side-map).
//
//   op=bearcase       public read  — the most recent bear-case doc (keyed to the last
//                                    COMPLETED session, so it stays visible through the
//                                    following premarket/RTH; empty never CDN-cached)
//   op=bearcasetick   PRIVILEGED   — self-fetch op=today, one bounded Haiku call over the
//                                    top actionable/lead tickers, persist bearcase/<date>.json.
//                                    TRADING DAYS ONLY (a weekend tick would argue against
//                                    a carried-over non-trading snapshot and burn the call).
//
// The cases never touch ranking, sizing, selection or governance: op=today merely
// attaches the day's doc as payload.bearCases (a side-map — no row is mutated, the
// board hash is computed before and without it).

const BC = require('./bearcase');
const STORE = require('./store');
const { internalHeaders } = require('./auth');
const { logWarn } = require('./log');
const { sessionInfoAt, lastCompletedRegularSession } = require('./market-session');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const dayKey = (date) => `bearcase/${date}.json`;
// The serving key: the last COMPLETED regular session. The tick writes under the trading
// day it ran on (post-close, so that day IS the last completed session); readers during
// the following overnight/premarket/RTH resolve to the same key, so the cases stay
// visible until the next session completes and its own tick replaces them.
const servingDate = () => lastCompletedRegularSession(new Date());

const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

const DISCLOSURE = 'Model-generated adversarial read of the board’s own served evidence. It does NOT affect any rank, size or selection, carries no measured track record, and is not advice.';

// ── op=bearcase : public read ───────────────────────────────────────────────
async function runBearcase(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const date = servingDate();
  const doc = date ? await STORE.readJSON(dayKey(date), null) : null;
  // Never CDN-cache the empty state (the pre-first-tick trap).
  if (doc) cached(res); else noStore(res);
  // Explicit fields only — spreading the stored doc would auto-leak any future
  // writer-side field (debug data, prompts) onto this public endpoint.
  return res.status(200).json({
    ok: true,
    arguedAgainst: date,
    available: !!doc,
    ...(doc
      ? { cases: doc.cases || {}, generatedAt: doc.generatedAt || null, model: doc.model || null, note: doc.note || null, boardHash: doc.boardHash || null }
      : { reason: 'no bear cases for the last completed session — op=bearcasetick has not run' }),
    disclosure: DISCLOSURE,
  });
}

// ── op=bearcasetick : generate + persist the day's cases ────────────────────
async function runBearcaseTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not set.' });
  const si = sessionInfoAt(new Date());
  if (!si.isTradingDay) {
    return res.status(200).json({ ok: true, skipped: 'non-trading day — the board is a carried-over snapshot; nothing to argue against' });
  }
  const date = si.etDate;

  // Idempotent per day (the warm chain re-dispatches on retries) unless forced.
  const existing = await STORE.readJSON(dayKey(date), null);
  if (existing && req.query.force !== '1') {
    return res.status(200).json({ ok: true, date, alreadyGenerated: true, tickers: Object.keys(existing.cases || {}).length });
  }

  // Authenticated ORIGIN read on purpose (the atlasx rule: a path that PERSISTS a
  // derived artifact must not build it from a possibly-stale CDN copy). The served
  // board's hash is stamped into the doc so the exact argued-against board is auditable.
  let payload = null;
  try {
    const r = await fetch(`https://${HOST}/api/tracker?op=today`, { headers: internalHeaders(), signal: AbortSignal.timeout(45000) });
    if (r.ok) payload = await r.json();
  } catch (e) { logWarn('bearcase.tick', 'op=today fetch failed', { error: String(e && e.message || e) }); }
  if (!payload) return res.status(502).json({ ok: false, error: 'op=today unavailable — nothing generated' });

  const signals = BC.selectSignals(payload);
  if (!signals.length) {
    // Distinguish a GENUINE abstention (whole board empty) from a degraded read (rows
    // exist but the gated lanes are empty/null). Persisting the empty doc on a degraded
    // read would stick a false "no rows" marker for the rest of the day.
    const boardHadRows = Object.values(payload.topByHorizon || {}).some((a) => Array.isArray(a) && a.length);
    if (boardHadRows) {
      logWarn('bearcase.tick', 'gated lanes empty but board has rows — degraded read, not persisting', {});
      return res.status(502).json({ ok: false, error: 'gated lanes empty while the board has rows — degraded op=today read, nothing persisted' });
    }
    await STORE.writeJSON(dayKey(date), { date, cases: {}, note: 'board abstained — no rows served', generatedAt: new Date().toISOString(), model: BC.MODEL, boardHash: payload.boardHash && payload.boardHash.hash || null }, 0);
    return res.status(200).json({ ok: true, date, tickers: 0, note: 'board abstained — honest empty persisted' });
  }
  const regimeLabel = payload.regime && payload.regime.label;
  const out = await BC.generateBearCases(signals, regimeLabel);
  if (!out) {
    // 502 so the warm chain records a real failure (an HTTP 200 here would render the
    // chain permanently "healthy" while the feature is dead). There is no same-day
    // retry mechanism — the next chance is tomorrow's dispatch.
    logWarn('bearcase.tick', 'bear-case LLM call failed — nothing persisted', { signals: signals.length });
    return res.status(502).json({ ok: false, error: 'bear-case LLM call failed — nothing persisted' });
  }

  // Stamp the argued side per ticker so the UI can refuse to render a LONG argument on
  // a SHORT card of the same ticker (side is part of a row's identity on this board).
  const sideByTicker = Object.fromEntries(signals.map((s) => [String(s.ticker).toUpperCase(), s.side === 'short' ? 'short' : 'long']));
  const cases = Object.fromEntries(Object.entries(out.cases).map(([t, c]) => [t, { ...c, side: sideByTicker[t] || 'long' }]));

  await STORE.writeJSON(dayKey(date), {
    date, cases, generatedAt: new Date().toISOString(), model: out.model,
    boardHash: payload.boardHash && payload.boardHash.hash || null, disclosure: DISCLOSURE,
  }, 0);
  return res.status(200).json({ ok: true, date, tickers: Object.keys(cases).length, of: signals.length });
}

module.exports = { runBearcase, runBearcaseTick, dayKey, servingDate, DISCLOSURE };
