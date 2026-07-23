// Shadow probe: does CONGRESSIONAL trading predict forward market-excess drift?
//
// The most-hyped "alt-data alpha". FMP Premium exposes senate + house trade
// disclosures per symbol. The honest catch is DISCLOSURE LAG: a trade made on
// transactionDate is only public on disclosureDate (often 30-45 days later), so
// we score every event AS-OF its disclosureDate — using transactionDate would
// leak the future and manufacture a fake edge. Score = same-day net signed $
// flow (purchase +, sale −), magnitude = dollar midpoint of the amount band.
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { evalDrift } = require('./drift-eval');
const FMP = process.env.FMP_API_KEY;

// "$15,001 - $50,000" → 32500.5 (band midpoint); single value → that value.
function amountMid(amt) {
  if (!amt) return 0;
  const nums = String(amt).match(/[\d,]+/g);
  if (!nums) return 0;
  const v = nums.map(n => +n.replace(/,/g, '')).filter(x => x > 0);
  if (!v.length) return 0;
  return v.length >= 2 ? (v[0] + v[1]) / 2 : v[0];
}
function direction(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('purchase') || t.includes('buy')) return 1;
  if (t.includes('sale') || t.includes('sold') || t.includes('sell')) return -1;
  return 0; // exchanges / receipts / unknown → ignore
}

async function fetchChamber(chamber, sym) {
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/${chamber}-trades?symbol=${sym}&apikey=${FMP}`);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

async function runCongress({ scope = 'large', months = 54, limit = 150, holds = [21, 63], deadlineMs = 55000 } = {}) {
  if (!FMP) return { error: 'FMP_API_KEY required' };
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let universe = [...new Set(list)]; if (limit > 0) universe = universe.slice(0, limit);
  const cutoff = new Date(Date.now() - months * 30 * 864e5).toISOString().slice(0, 10);

  // Pull senate + house disclosures per symbol (throttled for the plan).
  const bySym = new Map(); let withData = 0, fetched = 0, i = 0;
  const worker = async () => {
    while (i < universe.length) {
      const sym = universe[i++];
      if (Date.now() - t0 > deadlineMs * 0.5) return;   // reserve time for prices + compute
      const [s, h] = await Promise.all([fetchChamber('senate', sym), fetchChamber('house', sym)]);
      const rows = [...s, ...h]
        .map(x => ({ disc: String(x.disclosureDate || '').slice(0, 10), dir: direction(x.type), amt: amountMid(x.amount) }))
        .filter(x => x.disc && x.dir !== 0 && x.amt > 0);
      if (rows.length) { bySym.set(sym, rows); withData++; }
      fetched++;
      await new Promise(r => setTimeout(r, 60));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  // One event per (symbol, disclosureDate) = net signed $ flow disclosed that day.
  const events = [];
  for (const [sym, rows] of bySym) {
    const byDate = {};
    for (const r of rows) { if (r.disc < cutoff) continue; byDate[r.disc] = (byDate[r.disc] || 0) + r.dir * r.amt; }
    for (const [date, net] of Object.entries(byDate)) { if (net !== 0) events.push({ symbol: sym, date, score: net }); }
  }

  const out = await evalDrift(events, { holds, minResolved: 100, label: 'Congressional net-flow', deadlineMs: Math.max(8000, deadlineMs - (Date.now() - t0)) });
  return { scope, months, symbolsFetched: fetched, symbolsWithTrades: withData, ...out };
}

module.exports = { runCongress };
