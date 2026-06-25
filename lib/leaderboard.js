// Server-side Algo Leaderboard cache. The heavy strategy backtests (esp. the
// 5-strategy Confluence opt) can't run on every page view, so a cron snapshots
// their realized performance into a small doc the client reads cheaply.
const { readJSON, writeJSON, hasStore } = require('./store');

const STRATS_PATH = 'leaderboard/strats.json';
const readStrats = () => readJSON(STRATS_PATH, { algos: {}, updatedAt: null });

// op=leaderboard — cheap read of the cached strategy backtests.
async function runLeaderboard(req, res) {
  const doc = await readStrats().catch(() => ({ algos: {} }));
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({ ok: true, algos: doc.algos || {}, updatedAt: doc.updatedAt || null, generatedAt: new Date().toISOString() });
}

// op=leaderboardtick — cron: snapshot the heavier strategy backtests into the cache.
// Runs ONE source per call (src=confluence default) so it stays within the timeout.
async function runLeaderboardTick(req, res) {
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const get = u => fetch('https://' + host + u, { headers: { 'x-warm': '1' } }).then(r => r.json()).catch(() => null);
  const src = req.query.src || 'confluence';
  const doc = await readStrats().catch(() => ({ algos: {} }));
  doc.algos = doc.algos || {};
  const now = new Date().toISOString();
  let added = 0;
  try {
    if (src === 'confluence') {
      const c = await get('/api/tracker?op=confluenceopt');
      if (c && c.perStrategy) {
        for (const [k, v] of Object.entries(c.perStrategy)) {
          const o = v.overall || {};
          doc.algos['confluence|' + k] = { name: 'Confluence · ' + k, category: 'Confluence', excess: o.avgExc, beatRate: o.beatRate, wilsonLo: o.wilsonLo, n: o.n, src: 'confluence-backtest', updatedAt: now };
          added++;
        }
      }
    }
  } catch (e) { /* leave the cache as-is on failure */ }
  doc.updatedAt = now;
  await writeStrats(doc);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, src, added, total: Object.keys(doc.algos).length });
}
const writeStrats = doc => writeJSON(STRATS_PATH, doc, 0);

module.exports = { runLeaderboard, runLeaderboardTick, readStrats, STRATS_PATH };
