// Shadow probe: does ANALYST-REVISION MOMENTUM predict forward market-excess
// drift? The post-revision-drift anomaly is one of the more durable ones in the
// literature: when the analyst consensus is upgraded, prices tend to keep
// drifting in that direction for weeks. FMP Premium exposes a monthly panel of
// rating counts (grades-historical), so we build a consensus score per month and
// score each month's REVISION (the trailing change in consensus). PIT: month t's
// counts are published ~start of month; we enter the next trading day and take
// SPY-excess forward drift. Score sign = revision direction.
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { evalDrift } = require('./drift-eval');
const FMP = process.env.FMP_API_KEY;

// Bullishness in [-2, 2] from the monthly rating counts (needs a real panel).
function consensus(g) {
  const sb = +g.analystRatingsStrongBuy || 0, b = +g.analystRatingsBuy || 0, h = +g.analystRatingsHold || 0, s = +g.analystRatingsSell || 0, ss = +g.analystRatingsStrongSell || 0;
  const n = sb + b + h + s + ss;
  if (n < 3) return null;                       // too thin to be a consensus
  return (2 * sb + b - s - 2 * ss) / n;
}

async function fetchGrades(sym) {
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/grades-historical?symbol=${sym}&apikey=${FMP}&limit=60`);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

async function runRevisions({ scope = 'large', months = 54, limit = 150, lookback = 2, holds = [21, 63], deadlineMs = 55000 } = {}) {
  if (!FMP) return { error: 'FMP_API_KEY required' };
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let universe = [...new Set(list)]; if (limit > 0) universe = universe.slice(0, limit);
  const cutoff = new Date(Date.now() - months * 30 * 864e5).toISOString().slice(0, 10);

  // Monthly consensus series per symbol (throttled for the plan).
  const bySym = new Map(); let withData = 0, fetched = 0, i = 0;
  const worker = async () => {
    while (i < universe.length) {
      const sym = universe[i++];
      if (Date.now() - t0 > deadlineMs * 0.5) return;   // reserve time for prices + compute
      const g = await fetchGrades(sym);
      const series = g.map(x => ({ date: String(x.date).slice(0, 10), c: consensus(x) }))
        .filter(x => x.c != null)
        .sort((a, b) => (a.date < b.date ? -1 : 1));     // chronological → trailing revision
      if (series.length > lookback) { bySym.set(sym, series); withData++; }
      fetched++;
      await new Promise(r => setTimeout(r, 50));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // Event = a month whose consensus changed vs `lookback` months earlier.
  const events = [];
  for (const [sym, series] of bySym) {
    for (let j = lookback; j < series.length; j++) {
      const rev = series[j].c - series[j - lookback].c;
      if (Math.abs(rev) < 1e-6) continue;               // only real revisions
      if (series[j].date < cutoff) continue;
      events.push({ symbol: sym, date: series[j].date, score: rev });
    }
  }

  const out = await evalDrift(events, { holds, minResolved: 200, label: 'Analyst-revision momentum', deadlineMs: Math.max(8000, deadlineMs - (Date.now() - t0)) });
  return { scope, months, lookback, symbolsFetched: fetched, symbolsWithGrades: withData, ...out };
}

module.exports = { runRevisions };
