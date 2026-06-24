// PREDICTION-MARKET SCANNER — reads real-money prediction markets (Kalshi +
// Polymarket) for UNUSUAL activity on stock-market / macro contracts: volume
// bursts, sharp probability swings, fresh concentration. Pure data + scoring;
// the daily baseline snapshots live in Blob (see store.js) and are passed in.
//
// Honest framing: this is a crowd-sentiment / news-aggregation radar, NOT a proven
// stock edge. A volume spike usually means the crowd is repricing a known catalyst.

const { logWarn } = require('./log');

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

const UNUSUAL_HEAT = 65;        // heat ≥ this flags a market as "unusual"
const MIN_SHARP_NOTIONAL = 1500; // a sharp/informed bet must have real money behind it ($)

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
    } catch (e) { logWarn('predmarkets.fetchKalshi', e, { series }); }
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
    } catch (e) { logWarn('predmarkets.fetchPolymarket', e, { tag }); }
  }));
  return out;
}

// Resolve a settled Kalshi market by ticker → { result: 'yes'|'no' } or null if not
// yet settled. Powers Sharp Money validation (did the flagged bet's side win?).
async function fetchKalshiResult(ticker) {
  try {
    const d = await getJSON(`${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`);
    const m = d.market || {};
    if (m.result === 'yes' || m.result === 'no') return { result: m.result, status: m.status };
    return null;
  } catch (e) { logWarn('predmarkets.fetchKalshiResult', e, { ticker }); return null; }
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

// Snapshot rows may be a bare number (legacy: 24h volume) or { v, oi } (current).
const snapVol = v => (typeof v === 'number' ? v : (v && v.v) || 0);
const snapOI = v => (typeof v === 'object' && v ? +v.oi || 0 : 0);

// Build a per-market 24h-volume baseline {mean,std,n} from trailing daily snapshots
// (excludes today so we compare today's burst against the market's own normal).
function buildBaseline(snapshots, todayDate) {
  const byId = {};
  for (const day of snapshots) {
    if (day.date === todayDate) continue;
    for (const [id, v] of Object.entries(day.snap || {})) (byId[id] = byId[id] || []).push(snapVol(v));
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

// Open interest from the most recent snapshot before today → detect OI build (new money).
function buildPrevOI(snapshots, todayDate) {
  const prior = snapshots.filter(d => d.date < todayDate).sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const day of prior) {
    const out = {}; let any = false;
    for (const [id, v] of Object.entries(day.snap || {})) { const oi = snapOI(v); if (oi > 0) { out[id] = oi; any = true; } }
    if (any) return out;
  }
  return {};
}

const daysToClose = t => { if (!t) return null; const ms = Date.parse(t) - Date.now(); return Number.isFinite(ms) ? ms / 86400000 : null; };
const clamp01 = x => Math.max(0, Math.min(1, x));

// ── SHARP-MONEY DETECTOR ───────────────────────────────────────────────────────
// Flags the statistical HALLMARKS of potentially-informed betting (the prediction-
// market analog of unusual options activity). This does NOT detect actual insider
// trading — it surfaces patterns a sharp/informed bettor tends to leave: loading a
// cheap longshot that's rising, size exceeding open positions, fresh open-interest
// build, and late surges before resolution. Speculative and educational.
function scoreSharp(markets, baseline = {}, prevOI = {}) {
  const byVenue = {};
  for (const m of markets) (byVenue[m.venue] = byVenue[m.venue] || []).push(m.vol24);
  Object.values(byVenue).forEach(a => a.sort((x, y) => x - y));
  const pctl = (venue, v) => { const a = byVenue[venue]; if (!a || !a.length) return 0.5; let i = 0; while (i < a.length && a[i] < v) i++; return i / a.length; };

  return markets.map(m => {
    const pv = pctl(m.venue, m.vol24);                              // size vs today's board
    // A prior price of 0 means "no prior trade recorded", not a real move from 0% —
    // don't manufacture a conviction/odds signal from missing data.
    const validPrev = m.probPrev > 0;
    const dp = validPrev ? (m.prob || 0) - m.probPrev : 0, adp = Math.abs(dp);
    const side = dp >= 0 ? 'YES' : 'NO';
    const prior = dp >= 0 ? m.probPrev || 0 : (1 - (m.probPrev || 0));     // entry price of the side bought
    const lc = validPrev ? clamp01(adp * (1 - prior) * 6) : 0;     // longshot conviction
    const turnover = m.oi > 0 ? m.vol24 / m.oi : 0;                // size vs open positions
    const sz = clamp01(pv);
    const prevoi = prevOI[m.id] || 0, oiDelta = prevoi > 0 ? (m.oi - prevoi) / prevoi : 0;
    const oib = clamp01(oiDelta);                                  // new money / OI build
    const cm = clamp01(adp / 0.20);                                // conviction move
    const days = daysToClose(m.closeTime);
    const tt = (days != null ? clamp01((10 - days) / 10) : 0) * pv; // late surge before resolution
    const notional = Math.round(m.venue === 'Polymarket' ? m.vol24 : m.vol24 * (m.prob || 0.5)); // rough $ traded 24h
    const bigMoney = clamp01(Math.log10(Math.max(notional, 1) / 500) / 2);  // $500→0, $5k→0.5, $50k→1

    // Real smart money = SIZE *and* a conviction pattern. Money is a weighted term in
    // the score (not just a gate) so thin longshots can't outrank big-money flow.
    let sharp = Math.round(100 * (0.34 * bigMoney + 0.28 * lc + 0.16 * oib + 0.12 * cm + 0.10 * tt) + (turnover >= 1.2 ? 5 : 0));
    sharp = Math.max(5, Math.min(99, sharp));

    const tells = [];
    const isLongshot = lc >= 0.35 && prior <= 0.30;   // genuinely cheap entry, not a 50/50
    if (isLongshot) tells.push(`🎯 longshot conviction — bought ${side} from ${Math.round(prior * 100)}%`);
    else if (cm >= 0.5) tells.push(`⚡ sharp odds move ${Math.round(adp * 100)}pts ${dp > 0 ? 'up' : 'down'}`);
    if (oib >= 0.3) tells.push(`📈 new money — open interest +${Math.round(oiDelta * 100)}%`);
    if (turnover >= 1.2) tells.push('💰 size exceeds open positions (aggressive)');
    else if (sz >= 0.8) tells.push('💧 large volume vs the board');
    if (days != null && days <= 5 && pv >= 0.6) tells.push(`⏰ late surge — ${days < 1 ? '<1' : Math.round(days)}d to resolve`);

    // Flag genuine "informed bet" fingerprints: REAL money ($ floor) co-occurring with
    // a conviction pattern. Driven by the meaningful gates, not the 0–100 score itself.
    const sharpFlag = notional >= MIN_SHARP_NOTIONAL && (
      lc >= 0.35 ||                          // sized bet loading a cheap longshot that's rising
      oib >= 0.4 ||                          // strong fresh open-interest build (new money)
      (turnover >= 1.5 && bigMoney >= 0.4) ||// volume far exceeding open positions, with size
      (bigMoney >= 0.6 && cm >= 0.5)         // big money behind a sharp odds move
    );
    return {
      ...m, sharp, lc: +lc.toFixed(2), sz: +sz.toFixed(2), oib: +oib.toFixed(2), cm: +cm.toFixed(2),
      turnover: +turnover.toFixed(2), oiDeltaPct: Math.round(oiDelta * 100), side, priorPct: Math.round(prior * 100),
      daysToClose: days != null ? +days.toFixed(1) : null, notional, tells, sharpFlag,
    };
  }).sort((a, b) => b.sharp - a.sharp);
}

// Tell-type matchers for the by-tell validation breakdown.
const SHARP_TELLS = { longshot: /longshot/, oibuild: /new money|open interest/, size: /size exceeds/, volume: /large volume/, latesurge: /late surge/, move: /odds move/ };

// Honest "does sharp money predict?" summary over resolved flagged bets.
function summarizeSharpValidation(events) {
  const { wilson } = require('./stats');
  const res = (events || []).filter(e => e.outcome === 'yes' || e.outcome === 'no');
  const hits = res.filter(e => e.hit).length;
  const ci = wilson(hits, res.length);
  const byTell = {};
  for (const [k, rx] of Object.entries(SHARP_TELLS)) {
    const sub = res.filter(e => (e.tells || []).some(t => rx.test(t)));
    byTell[k] = { n: sub.length, hits: sub.filter(e => e.hit).length };
  }
  return {
    n: res.length, hits, rate: res.length ? Math.round(hits / res.length * 100) : null,
    wilsonLo: res.length ? Math.round(ci.lo * 100) : null, byTell,
    pending: (events || []).filter(e => !e.outcome).length,
  };
}

module.exports = { fetchKalshi, fetchPolymarket, fetchKalshiResult, scoreMarkets, scoreSharp, buildBaseline, buildPrevOI, daysToClose, summarizeSharpValidation, SHARP_TELLS, KALSHI_SERIES, UNUSUAL_HEAT };
