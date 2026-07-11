'use strict';
// Fast-vs-sticky ATTENTION routes (roadmap Step 4) — folded into api/tracker.js (no new
// Serverless Function). Both are cheap + deterministic (no LLM, no external API): they
// classify the already-archived StockTwits mention series.
//
//   op=attention     : latest Sticky/Fast/Building classification per ticker (pick-card chips)
//   op=attentiontick : log today's Sticky/Fast names to the ledger for the Scoreboard

const { nowET } = require('./stats');
const { hasStore, readAllArchive, writeAttentionDay } = require('./store');
const { classifyAttention } = require('./attention');

// op=attention — per-ticker classification for the 📈/⚡ chips.
async function runAttention(req, res) {
  const days = await readAllArchive().catch(() => []);
  const opts = {};
  if (req.query.window) opts.window = Math.max(3, Math.min(60, parseInt(req.query.window, 10) || 14));
  const out = classifyAttention(days, opts);
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({ ok: true, configured: hasStore(), ...out, generatedAt: new Date().toISOString() });
}

// op=attentiontick — log Sticky/Fast names to the ledger (warm-cron). Building/other are
// not tracked (only the two directional buckets are the signal). entry:null → the
// Scoreboard resolves forward returns off the close on the classification date.
async function runAttentionTick(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') return res.status(200).json({ ok: true, skipped: 'market-closed', date });

  const days = await readAllArchive().catch(() => []);
  const { byTicker, trustworthy, summary } = classifyAttention(days);
  const signals = Object.entries(byTicker)
    .filter(([, v]) => v.class === 'Sticky' || v.class === 'Fast')
    .map(([ticker, v]) => ({ date, ticker, tier: v.class, entry: null, presence: v.presence, latestMentions: v.latestMentions, short: false }));

  let url = null, err = null;
  try { const r = await writeAttentionDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, trustworthy, summary, signalsLogged: signals.length, url, error: err, at: new Date().toISOString() });
}

module.exports = { runAttention, runAttentionTick };
