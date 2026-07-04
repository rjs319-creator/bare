'use strict';
// Earnings-call TONE routes (roadmap Step 3) — folded into api/tracker.js so no new
// Serverless Function is added (Hobby plan caps at 12).
//
//   op=tonetick : score recent earnings calls for screener-filtered stocks (cost-gated,
//                 cached, warm-cron-triggered), and log them to the tone ledger.
//   op=tone     : read the latest tone per ticker for the 🎙 pick-card chips.

const { nowET } = require('./stats');
const {
  hasStore, writeToneDay, readAllTone, readToneCache, writeToneCache,
} = require('./store');
const tone = require('./earnings-tone');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
async function getJSON(path) {
  const r = await fetch('https://' + HOST + path, { headers: { 'x-warm': '1' } });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

// Gather the day's screener candidates (the cost gate: we only ever score names the
// screener already surfaced). Returns [{ ticker, price }] deduped, first price wins.
async function screenerCandidates() {
  const seen = new Map();
  for (const scope of ['large', 'small', 'micro']) {
    try {
      const d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : ''));
      (d.results || []).forEach(r => {
        if (r && r.ticker && r.price != null && !seen.has(r.ticker)) seen.set(r.ticker, { ticker: r.ticker, price: r.price });
      });
    } catch { /* scope failed — skip */ }
  }
  return [...seen.values()];
}

// op=tonetick — score recent earnings calls for filtered stocks, cache each result
// permanently, and write today's tone ledger for the Scoreboard.
async function runToneTick(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured.' });
  const { date, isWeekend } = nowET();
  if (isWeekend && req.query.force !== '1') return res.status(200).json({ ok: true, skipped: 'weekend', date });

  const nowMs = Date.now();
  const maxNew = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 12)); // cap NEW Claude scores/tick
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const cands = await screenerCandidates();
  const signals = [];
  let recent = 0, scored = 0, cached = 0, newScores = 0;

  for (const c of cands) {
    if (newScores >= maxNew) break; // cost ceiling for this tick
    // Recency gate: only score names that reported within the window (cheap FMP call).
    let callDate;
    try { callDate = await tone.fetchLastEarningsDate(c.ticker, nowMs); } catch { callDate = null; }
    if (!tone.recentEnough(callDate, nowMs)) continue;
    recent++;
    const key = `${c.ticker}-${callDate}`;

    let result = await readToneCache(key).catch(() => null); // never re-score a call
    if (result && result.tone != null) {
      cached++;
    } else {
      result = await tone.scoreToneViaSearch(client, c.ticker); // web-search coverage → tone
      if (!result) continue;
      newScores++;
      const record = { ...result, symbol: c.ticker, key, callDate, source: 'web-search', scoredAt: new Date().toISOString() };
      try { await writeToneCache(key, record); } catch { /* best-effort cache */ }
    }
    scored++;
    signals.push({
      date, ticker: c.ticker, entry: c.price, tier: tone.bucketOf(result.tone),
      tone: result.tone, reason: result.reason, period: key, callDate, short: false,
    });
  }

  let url = null, err = null;
  try { const r = await writeToneDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({
    ok: !err, date, candidates: cands.length, recentReporters: recent, scored, cached, newScores,
    signalsLogged: signals.length, url, error: err, at: new Date().toISOString(),
  });
}

// op=tone — latest tone per ticker (for pick-card 🎙 chips).
async function runTone(req, res) {
  const all = await readAllTone().catch(() => []);
  const byTicker = {};
  for (const s of all) {
    if (!s || !s.ticker || s.tone == null) continue;
    const prev = byTicker[s.ticker];
    if (!prev || (s.date || '') > (prev.date || '')) {
      byTicker[s.ticker] = { tone: s.tone, reason: s.reason, tier: s.tier, date: s.date, callDate: s.callDate || null, period: s.period || null };
    }
  }
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({ ok: true, configured: hasStore(), count: Object.keys(byTicker).length, byTicker, generatedAt: new Date().toISOString() });
}

module.exports = { runToneTick, runTone };
