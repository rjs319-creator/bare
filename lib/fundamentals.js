// Finnhub fundamentals — the "C" and "A" of CAN SLIM (earnings/sales growth)
// plus earnings-date proximity (don't enter a breakout right before earnings).
const KEY = process.env.FINNHUB_API_KEY;
const num = v => (v == null || isNaN(v)) ? null : +(+v).toFixed(1);

// YoY-of-YoY acceleration (percentage points) from a quarterly {period,v} series:
// is the year-over-year growth rate itself rising (accelerating) or falling?
// Needs ≥6 quarters. This is the genuine 2nd derivative — the "A" in CAN SLIM.
function yoyAccel(arr) {
  if (!Array.isArray(arr)) return null;
  const s = arr.filter(x => x && x.period && x.v != null && x.v !== 0).sort((a, b) => (a.period < b.period ? -1 : 1));
  const n = s.length;
  if (n < 6) return null;
  const latestYoY = s[n - 1].v / s[n - 5].v - 1;
  const priorYoY = s[n - 2].v / s[n - 6].v - 1;
  if (!isFinite(latestYoY) || !isFinite(priorYoY)) return null;
  return +((latestYoY - priorYoY) * 100).toFixed(1);
}
function computeAccel(q) {
  if (!q || typeof q !== 'object') return { revAccel: null, epsAccel: null };
  return {
    revAccel: yoyAccel(q.salesPerShare),                                       // per-share sales (buyback-aware proxy for revenue)
    epsAccel: yoyAccel(q.eps || q.epsBasicExclExtraItems || q.epsInclExtraItems),
  };
}

async function fetchFundamentals(ticker) {
  if (!KEY) return null;
  const sym = ticker.toUpperCase();
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${KEY}`);
    if (!r.ok) return null;
    const data = await r.json();
    const m = data.metric || {};
    const { revAccel, epsAccel } = computeAccel(data.series && data.series.quarterly);
    const epsGrowth = num(m.epsGrowthTTMYoy);
    const revGrowth = num(m.revenueGrowthTTMYoy);
    const netMargin = num(m.netProfitMarginTTM);

    // Operating margin now vs its multi-year baseline → "expanding" check.
    const opMarginTTM = num(m.operatingMarginTTM ?? m.operatingMarginAnnual);
    const opMarginBase = num(m.operatingMargin5Y ?? m.operatingMarginAnnual);
    // Expanding if current op margin is above its 5-yr/annual baseline; if no
    // baseline is available, fall back to EPS growth as a profitability-trend proxy.
    const marginExpanding = (opMarginTTM != null && opMarginBase != null)
      ? opMarginTTM > opMarginBase
      : (opMarginTTM != null && epsGrowth != null) ? epsGrowth > 0 : null;

    // Valuation (P/E) — try the common metric field names.
    const pe = num(m.peTTM ?? m.peBasicExclExtraTTM ?? m.peNormalizedAnnual ?? m.peExclExtraTTM);

    let earningsDate = null, earningsInDays = null;
    try {
      const today = new Date();
      const f = today.toISOString().slice(0, 10);
      const t = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
      const er = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${f}&to=${t}&symbol=${sym}&token=${KEY}`);
      if (er.ok) {
        const ec = (await er.json()).earningsCalendar || [];
        if (ec.length) { earningsDate = ec[0].date; earningsInDays = Math.round((new Date(earningsDate + 'T00:00:00') - today) / 864e5); }
      }
    } catch {}

    if (epsGrowth == null && revGrowth == null && earningsInDays == null) return null;
    return { epsGrowth, revGrowth, revAccel, epsAccel, netMargin, opMarginTTM, opMarginBase, marginExpanding, pe, earningsDate, earningsInDays };
  } catch { return null; }
}

// Open-market insider transactions over the trailing ~90 days, aggregated into a
// normalized buy/sell/net object for the Ghost IN pillar. Finnhub's
// /stock/insider-transactions returns rows with a `transactionCode` ('P' = open
// market purchase, 'S' = open market sale) and a signed `change` in shares. We
// count ONLY open-market P/S (option exercises, gifts, 10b5-1 grants etc. are not
// conviction signals) and weight by dollar value (|change| × transactionPrice).
async function fetchInsiders(ticker) {
  if (!KEY) return null;
  const sym = ticker.toUpperCase();
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const r = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${sym}&from=${from}&to=${to}&token=${KEY}`);
    if (!r.ok) return null;
    const rows = ((await r.json()) || {}).data || [];
    const buys = { value: 0, shares: 0, tx: 0, names: new Set() };
    const sells = { value: 0, shares: 0, tx: 0, names: new Set() };
    for (const row of rows) {
      const code = (row.transactionCode || '').toUpperCase();
      if (code !== 'P' && code !== 'S') continue;        // open-market only
      const shares = Math.abs(+row.change || 0);
      if (!shares) continue;
      const price = +row.transactionPrice || 0;
      const value = shares * price;
      const bucket = code === 'P' ? buys : sells;
      bucket.value += value; bucket.shares += shares; bucket.tx += 1;
      if (row.name) bucket.names.add(row.name);
    }
    if (buys.tx === 0 && sells.tx === 0) return { buys: { value: 0, shares: 0, tx: 0, insiders: 0 }, sells: { value: 0, shares: 0, tx: 0, insiders: 0 }, net: { value: 0, shares: 0 }, window: '90d', empty: true };
    const shape = b => ({ value: Math.round(b.value), shares: b.shares, tx: b.tx, insiders: b.names.size });
    return {
      buys: shape(buys), sells: shape(sells),
      net: { value: Math.round(buys.value - sells.value), shares: buys.shares - sells.shares },
      window: '90d',
    };
  } catch { return null; }
}

module.exports = { fetchFundamentals, fetchInsiders };
