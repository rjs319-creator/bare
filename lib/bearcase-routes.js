'use strict';
// STRUCTURED BEAR CASE — route handlers (weight 0; display-only side-map).
//
//   op=bearcase       public read  — today's bear-case doc (empty state never CDN-cached)
//   op=bearcasetick   PRIVILEGED   — self-fetch op=today, one bounded Haiku call over the
//                                    top actionable/lead tickers, persist bearcase/<date>.json
//
// The cases never touch ranking, sizing, selection or governance: op=today merely
// attaches the day's doc as payload.bearCases (a side-map — no row is mutated, the
// board hash is computed before and without it).

const BC = require('./bearcase');
const STORE = require('./store');
const { internalHeaders } = require('./auth');
const { sessionInfoAt } = require('./market-session');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const dayKey = (date) => `bearcase/${date}.json`;
const today = () => sessionInfoAt(new Date()).etDate;

const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

const DISCLOSURE = 'Model-generated adversarial read of the board’s own served evidence. It does NOT affect any rank, size or selection, carries no measured track record, and is not advice.';

// ── op=bearcase : public read ───────────────────────────────────────────────
async function runBearcase(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const date = today();
  const doc = await STORE.readJSON(dayKey(date), null);
  // Never CDN-cache the empty state (the pre-first-tick trap).
  if (doc) cached(res); else noStore(res);
  return res.status(200).json({
    ok: true, date, available: !!doc,
    ...(doc || { reason: 'no bear cases yet today — op=bearcasetick has not run' }),
    disclosure: DISCLOSURE,
  });
}

// ── op=bearcasetick : generate + persist today's cases ──────────────────────
async function runBearcaseTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not set.' });
  const date = today();

  // Idempotent per day (the warm chain re-dispatches on retries) unless forced.
  const existing = await STORE.readJSON(dayKey(date), null);
  if (existing && req.query.force !== '1') {
    return res.status(200).json({ ok: true, date, alreadyGenerated: true, tickers: Object.keys(existing.cases || {}).length });
  }

  let payload = null;
  try {
    const r = await fetch(`https://${HOST}/api/tracker?op=today`, { headers: internalHeaders(), signal: AbortSignal.timeout(45000) });
    if (r.ok) payload = await r.json();
  } catch { payload = null; }
  if (!payload) return res.status(502).json({ ok: false, error: 'op=today unavailable — nothing generated' });

  const signals = BC.selectSignals(payload);
  if (!signals.length) {
    // Honest empty: an abstained/empty board yields an explicit empty doc (idempotence
    // marker), never a fabricated case.
    await STORE.writeJSON(dayKey(date), { date, cases: {}, note: 'board served no actionable/lead rows', generatedAt: new Date().toISOString(), model: BC.MODEL }, 0);
    return res.status(200).json({ ok: true, date, tickers: 0, note: 'no rows to argue against' });
  }
  const regimeLabel = payload.regime && payload.regime.label;
  const out = await BC.generateBearCases(signals, regimeLabel);
  if (!out) return res.status(200).json({ ok: false, error: 'bear-case call failed — nothing persisted (retried next dispatch)' });

  await STORE.writeJSON(dayKey(date), { date, cases: out.cases, generatedAt: new Date().toISOString(), model: out.model, disclosure: DISCLOSURE }, 0);
  return res.status(200).json({ ok: true, date, tickers: Object.keys(out.cases).length, of: signals.length });
}

module.exports = { runBearcase, runBearcaseTick, dayKey, DISCLOSURE };
