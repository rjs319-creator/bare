// 🎚️ TONE SHIFT route — tick/serve split.
//   op=toneshifttick : recent reporters (reused from the tone ledger) → AI tone-delta vs the
//                      prior quarter → forward-log → cache.
//   op=toneshift     : fast serve.
// Reuses the existing earnings-tone feature's detection (its ledger already holds the day's
// recent reporters), then adds the NOVEL delta. Forward-logged to toneshift/<date>.json.
const { readJSON, writeJSON, hasStore, readAllTone } = require('./store');
const { parseResult, rankItems, investigate, MAX_INVESTIGATE } = require('./toneshift');
const { benchFor } = require('./readthrough');

const CACHE_KEY = 'toneshift/latest.json';
const REFRESH_MS = 12 * 60 * 60 * 1000;      // earnings cadence is slow — refresh less often
const DISCLAIMER = 'The DELTA in an earnings call\'s tone vs the prior quarter — management shifting from hedged to confident (or the reverse) before the numbers catch up. BRIGHTENING = more upbeat/specific; DARKENING = more cautious. A slower SWING-horizon LEAD, forward-tracked — not a buy signal.';

// Recent reporters = the most recent tone-ledger day's names (deduped, strongest |tone|
// first as a proxy for salience). Reuses the tone feature's detection entirely.
async function detect(limit) {
  const days = await readAllTone().catch(() => []);
  if (!days.length) return { cands: [], asOf: null };
  const latest = days.reduce((a, b) => (a.date > b.date ? a : b), days[0]);
  const seen = new Map();
  for (const s of (latest.signals || latest.picks || [])) {
    if (s && s.ticker && !seen.has(s.ticker)) seen.set(s.ticker, { ticker: s.ticker, callDate: s.callDate || null, tone: s.tone });
  }
  const cands = [...seen.values()].sort((a, b) => Math.abs(b.tone || 0) - Math.abs(a.tone || 0)).slice(0, limit);
  return { cands, asOf: latest.date };
}

function tierFor(c) {
  return c.shift === 'BRIGHTENING' ? 'Brightening' : c.shift === 'DARKENING' ? 'Darkening' : 'Stable';
}

async function logSurfaced(asOf, items) {
  if (!hasStore() || !asOf || !items.length) return 0;
  const { SECTOR_OF } = require('./universe');
  const { writeToneShiftDay } = require('./store');
  const picks = items.map(c => ({
    ticker: c.ticker, tier: tierFor(c), date: asOf, entry: null, short: false,
    bench: benchFor(SECTOR_OF[c.ticker]), shift: c.shift, confidence: c.confidence,
  }));
  await writeToneShiftDay(asOf, { picks }).catch(() => {});
  return picks.length;
}

async function runToneShiftTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  try {
    let cands, asOf;
    if (req.query.seed) {   // manual/testing override when the tone ledger is thin (e.g. holidays)
      const { fetchDailyHistory } = require('./screener');
      const spy = await fetchDailyHistory('SPY').catch(() => null);
      asOf = spy && spy.candles.length ? spy.candles[spy.candles.length - 1].date : new Date().toISOString().slice(0, 10);
      cands = req.query.seed.split(',').map(s => ({ ticker: s.toUpperCase().trim(), callDate: null })).filter(c => c.ticker).slice(0, MAX_INVESTIGATE);
    } else {
      ({ cands, asOf } = await detect(MAX_INVESTIGATE));
    }
    if (!cands.length) {
      const empty = { asOf, items: [], notes: 'no recent reporters in the tone ledger', generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(CACHE_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, elapsedMs: Date.now() - t0 });
    }
    const raw = await investigate(cands);
    const { items, notes } = parseResult(raw, cands);
    const ranked = rankItems(items);
    const logged = await logSurfaced(asOf, ranked);
    const payload = { asOf, items: ranked, notes, candidates: cands, logged, generatedAt: new Date().toISOString() };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, asOf, itemCount: ranked.length, logged, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

async function runToneShift(req, res) {
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  if (cached) {
    const ageMins = cached.generatedAt ? Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) : null;
    const stale = cached.generatedAt ? (Date.now() - new Date(cached.generatedAt).getTime() >= REFRESH_MS) : true;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, stale, disclaimer: DISCLAIMER, ...cached, ageMins });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the tone-shift scan (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

module.exports = { runToneShift, runToneShiftTick, detect, tierFor, logSurfaced, CACHE_KEY };
