// CROWD-LEADS STUDY — does a themed crowd swing precede the implicated sector's
// move? Pure logic (event building + summary); the store-backed resolution loop
// lives in the tracker. Each clean directional theme maps to a canonical sector
// ETF + expected direction (for the YES side being bid; flipped when odds fall).
const { classifyMkt } = require('./brief');

const THEME_PRIMARY = {
  ratecut:    { etf: 'XLRE', dir: 1, label: 'Real Estate' },
  ratehike:   { etf: 'XLF',  dir: 1, label: 'Financials' },
  inflation:  { etf: 'XLE',  dir: 1, label: 'Energy' },
  recession:  { etf: 'XLP',  dir: 1, label: 'Staples' },
  volatility: { etf: 'SPY',  dir: -1, label: 'S&P 500' },
};
const CSTUDY_HORIZONS = [5, 10, 21];

// From the scored crowd markets, build study events for qualifying themed swings:
// a real (≥12pt) move, real money (≥$1k notional), on a near-dated catalyst.
function buildStudyEvents(scored, today) {
  const out = [];
  for (const m of scored) {
    if (m.movePts < 12) continue;
    const theme = classifyMkt(m.title); const prim = THEME_PRIMARY[theme]; if (!prim) continue;
    const notion = m.venue === 'Polymarket' ? m.vol24 : m.vol24 * (m.prob || 0.5);
    if (notion < 1000) continue;
    const dtc = m.closeTime ? (Date.parse(m.closeTime) - Date.now()) / 86400000 : 999;
    if (dtc > 120) continue;
    const oddsUp = (m.prob || 0) >= (m.probPrev != null ? m.probPrev : m.prob);
    out.push({ id: m.id + '|' + today, date: today, title: m.title, theme,
      oddsUp, movePts: Math.round(m.movePts), etf: prim.etf, sectorLabel: prim.label, dir: prim.dir * (oddsUp ? 1 : -1), grades: {} });
  }
  return out;
}

// Honest summary: does the crowd lead the implicated sector?
function summarizeCrowdStudy(days) {
  const { wilson } = require('./stats');
  const events = days.flatMap(d => d.events || []);
  const byHorizon = {}, byTheme = {};
  CSTUDY_HORIZONS.forEach(h => byHorizon[h] = { n: 0, hits: 0 });
  let n = 0, hits = 0, pending = 0;
  for (const e of events) {
    const g = e.grades || {}; const hs = CSTUDY_HORIZONS.filter(h => g[h]);
    if (!hs.length) { pending++; continue; }
    for (const h of hs) {
      byHorizon[h].n++; if (g[h].hit) byHorizon[h].hits++;
      n++; if (g[h].hit) hits++;
      const t = byTheme[e.theme] = byTheme[e.theme] || { n: 0, hits: 0 };
      t.n++; if (g[h].hit) t.hits++;
    }
  }
  const ci = wilson(hits, n);
  return { n, hits, rate: n ? Math.round(hits / n * 100) : null, wilsonLo: n ? Math.round(ci.lo * 100) : null, byHorizon, byTheme, pending, events: events.length };
}

module.exports = { THEME_PRIMARY, CSTUDY_HORIZONS, buildStudyEvents, summarizeCrowdStudy };
