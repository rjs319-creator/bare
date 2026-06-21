// PREDICTION-MARKET SCANNER — reads real-money prediction markets (Kalshi +
// Polymarket) for UNUSUAL activity on stock-market / macro contracts: volume
// bursts, sharp probability swings, fresh concentration. Pure data + scoring;
// the daily baseline snapshots live in Blob (see store.js) and are passed in.
//
// Honest framing: this is a crowd-sentiment / news-aggregation radar, NOT a proven
// stock edge. A volume spike usually means the crowd is repricing a known catalyst.

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY_BASE = 'https://gamma-api.polymarket.com';

// Curated, confirmed-live Kalshi series tied to equities / macro (skip empties).
const KALSHI_SERIES = [
  ['KXINX', 'S&P 500 level'], ['KXNASDAQ100', 'Nasdaq-100 level'],
  ['KXFED', 'Fed rate decision'], ['KXFEDDECISION', 'Fed decision'],
  ['KXCPI', 'CPI'], ['KXCPIYOY', 'Inflation (YoY)'], ['KXPAYROLLS', 'Jobs / payrolls'],
];
const POLY_TAGS = [102000, 101250]; // macro-indicators, macro-single
const POLY_RX = /inflation|cpi|fed|rate|recession|s&p|sp ?500|nasdaq|stock|gdp|jobs|unemploy|payroll|powell|treasury|interest/i;

const UNUSUAL_HEAT = 65;   // heat ≥ this flags a market as "unusual"

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

async function fetchKalshi() {
  const out = [];
  await Promise.all(KALSHI_SERIES.map(async ([series, label]) => {
    try {
      const d = await getJSON(`${KALSHI_BASE}/markets?limit=400&status=open&series_ticker=${series}`);
      for (const m of (d.markets || [])) {
        const v24 = num(m.volume_24h_fp), vol = num(m.volume_fp), oi = num(m.open_interest_fp);
        if (vol <= 0 && v24 <= 0) continue;   // never-traded strike — skip noise
        out.push({
          venue: 'Kalshi', id: m.ticker, group: label, title: m.title || m.ticker,
          prob: num(m.last_price_dollars), probPrev: num(m.previous_price_dollars),
          vol24: v24, volTotal: vol, oi, liq: num(m.liquidity_dollars),
          closeTime: m.close_time, url: `https://kalshi.com/markets/${(m.event_ticker || '').toLowerCase()}`,
        });
      }
    } catch { /* skip this series */ }
  }));
  return out;
}

async function fetchPolymarket() {
  const seen = new Set(), out = [];
  await Promise.all(POLY_TAGS.map(async tag => {
    try {
      const d = await getJSON(`${POLY_BASE}/markets?closed=false&limit=200&tag_id=${tag}&order=volume24hr&ascending=false`);
      const arr = Array.isArray(d) ? d : (d.data || []);
      for (const m of arr) {
        if (seen.has(m.id)) continue; seen.add(m.id);
        const q = m.question || '';
        if (!POLY_RX.test(q)) continue;          // keep stock-market / macro relevant
        const v24 = num(m.volume24hr);
        if (v24 <= 0) continue;
        const chg = m.oneDayPriceChange != null ? num(m.oneDayPriceChange) : 0;
        out.push({
          venue: 'Polymarket', id: 'poly-' + m.id, group: 'Macro', title: q,
          prob: num(m.lastTradePrice), probPrev: num(m.lastTradePrice) - chg,
          vol24: v24, volTotal: num(m.volume), oi: null, liq: num(m.liquidity),
          closeTime: m.endDate, url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
        });
      }
    } catch { /* skip this tag */ }
  }));
  return out;
}

// Score "unusualness". baseline: { [id]: { mean, std, n } } of trailing 24h-volume.
// Volume isn't comparable across venues (contracts vs USD), so it's normalized
// WITHIN each venue: a per-market baseline z-score once we have ≥3 daily snapshots,
// otherwise a within-venue percentile that works on day one.
function scoreMarkets(markets, baseline = {}) {
  const byVenue = {};
  for (const m of markets) (byVenue[m.venue] = byVenue[m.venue] || []).push(m.vol24);
  Object.values(byVenue).forEach(a => a.sort((x, y) => x - y));
  const pctl = (venue, v) => { const a = byVenue[venue]; if (!a || !a.length) return 0.5; let i = 0; while (i < a.length && a[i] < v) i++; return i / a.length; };

  return markets.map(m => {
    const b = baseline[m.id];
    let volZ, volBasis;
    if (b && b.n >= 3 && b.std > 0) { volZ = (m.vol24 - b.mean) / b.std; volBasis = 'baseline'; }
    else { volZ = (pctl(m.venue, m.vol24) - 0.5) * 4; volBasis = 'today'; }   // percentile → pseudo-z in [-2,2]
    const movePts = Math.abs(m.prob - m.probPrev) * 100;                      // probability swing, points
    const freshRatio = m.volTotal > 0 ? m.vol24 / m.volTotal : 0;
    const heat = Math.round(Math.max(5, Math.min(99, 45 + 16 * volZ + 0.9 * movePts + (freshRatio >= 0.5 ? 6 : 0))));
    // "Unusual" must be a genuine signal — a real volume surge (only once a per-market
    // baseline exists) or a meaningful odds swing (baseline-free, honest on day one).
    const volSurge = volBasis === 'baseline' && volZ >= 1.5;
    const bigMove = movePts >= 8;
    const reasons = [];
    if (volSurge) reasons.push('🔥 volume surge');
    else if (volBasis === 'today' && volZ >= 1.6) reasons.push('📈 heavy volume today');
    if (movePts >= 5) reasons.push(`⚡ odds ${m.prob > m.probPrev ? 'rising' : 'falling'} ${movePts.toFixed(0)}pts`);
    if (freshRatio >= 0.5) reasons.push('🆕 fresh activity');
    return { ...m, heat, volZ: +volZ.toFixed(2), volBasis, movePts: +movePts.toFixed(1), reasons, unusual: volSurge || bigMove };
  }).sort((a, b) => b.heat - a.heat);
}

// Build a per-market baseline {mean,std,n} from trailing daily snapshots (excludes
// today so we compare today's burst against the market's own normal).
function buildBaseline(snapshots, todayDate) {
  const byId = {};
  for (const day of snapshots) {
    if (day.date === todayDate) continue;
    for (const [id, v] of Object.entries(day.snap || {})) (byId[id] = byId[id] || []).push(v);
  }
  const out = {};
  for (const [id, arr] of Object.entries(byId)) {
    const n = arr.length; if (!n) continue;
    const mean = arr.reduce((s, x) => s + x, 0) / n;
    const std = Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
    out[id] = { mean, std, n };
  }
  return out;
}

module.exports = { fetchKalshi, fetchPolymarket, scoreMarkets, buildBaseline, KALSHI_SERIES, UNUSUAL_HEAT };
