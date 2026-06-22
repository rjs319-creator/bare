// PREDICTION BRIEF — deterministic synthesis of the three Predict signals
// (Forecast + Crowd + Sharp) plus the regime/tape into one consensus read, with
// an equity-translation layer. Shared by the UI (op=brief) and the validation
// cron (op=brieftick) so the logged stance always matches what's displayed.

const SECTOR_NAME = { XLK: 'Tech', XLF: 'Financials', XLE: 'Energy', XLV: 'Health Care', XLY: 'Cons Disc', XLP: 'Staples', XLI: 'Industrials', XLU: 'Utilities', XLRE: 'Real Estate', XLB: 'Materials', XLC: 'Comm Svcs', IWM: 'Small Caps', SPY: 'S&P 500' };
const THEME_LABEL = { ratecut: 'rate cuts', ratehike: 'rate hikes', inflation: 'inflation', recession: 'recession', volatility: 'volatility', labor: 'jobs data', fed: 'Fed policy', equitylevel: 'index levels' };
const THEME_RISK = { recession: -1, volatility: -1, ratecut: 1, ratehike: -1, inflation: -1 };
const THEME_SECTORS = {
  ratecut:    { fav: ['XLRE', 'XLU', 'IWM'], why: 'rate-cut odds active (rate-sensitive)' },
  ratehike:   { fav: ['XLF'], pre: ['XLRE', 'XLU', 'XLK'], why: 'higher-for-longer odds' },
  inflation:  { fav: ['XLE'], pre: ['XLK', 'XLY'], why: 'inflation in play' },
  recession:  { fav: ['XLP', 'XLU', 'XLV'], pre: ['XLY', 'XLF', 'XLI'], why: 'recession odds active' },
  volatility: { pre: ['SPY'], why: 'volatility bid (broad risk-off)' },
};

const sign = x => (x > 0.05 ? 1 : x < -0.05 ? -1 : 0);

function classifyMkt(title) {
  const t = (title || '').toLowerCase();
  if (/recession/.test(t)) return 'recession';
  if (/\bvix\b|volatility/.test(t)) return 'volatility';
  if (/cut/.test(t) && /rate|fed|fund/.test(t)) return 'ratecut';
  if (/(hike|raise|increase)/.test(t) && /rate|fed|fund/.test(t)) return 'ratehike';
  if (/cpi|inflation|pce/.test(t)) return 'inflation';
  if (/jobs|payroll|unemployment|labor/.test(t)) return 'labor';
  if (/s&p|nasdaq|dow jones/.test(t)) return 'equitylevel';
  if (/\bfed\b|fomc|federal funds/.test(t)) return 'fed';
  return null;
}
// Risk lean of a prediction-market move: theme risk × which side the crowd is bidding.
function mktLean(m) {
  const theme = classifyMkt(m.title), base = THEME_RISK[theme];
  if (!base) return { theme, lean: 0 };
  const prev = m.probPrev != null ? m.probPrev : m.prob;
  const oddsUp = (m.prob || 0) >= prev;
  const mag = Math.min(Math.abs((m.prob || 0) - prev) * 4, 1) || 0.1;
  return { theme, lean: base * (oddsUp ? 1 : -1) * mag };
}
function aggLean(markets) {
  let lean = 0; const themes = {};
  (markets || []).forEach(m => { const r = mktLean(m); lean += r.lean; if (r.theme) themes[r.theme] = (themes[r.theme] || 0) + 1; });
  return { lean, themes };
}
// Bullishness of a forecast call (weighted by confidence).
function fcBull(c) {
  const s = (c.subject || '').toUpperCase(), d = c.direction, w = (c.confidence || 5) / 5;
  let b = 0;
  if (/^(SPY|QQQ|IWM|DIA)$/.test(s)) b = d === 'up' ? 1 : d === 'down' ? -1 : 0;
  else if (s === '^VIX' || s === 'VIX') b = d === 'up' ? -1 : d === 'down' ? 1 : 0;
  else if (/^XL/.test(s)) {
    const cyc = /XLK|XLY|XLF|XLI|XLB|XLC/.test(s), def = /XLP|XLU|XLV|XLRE/.test(s);
    if (d === 'outperform') b = cyc ? 0.6 : def ? -0.3 : 0.3;
    else if (d === 'underperform') b = cyc ? -0.6 : def ? 0.3 : -0.3;
    else b = d === 'up' ? 0.4 : d === 'down' ? -0.4 : 0;
  } else b = d === 'up' ? 0.3 : d === 'down' ? -0.3 : 0;
  return b * w;
}

// Synthesize the brief from the three signal payloads + tape. Pure; returns the
// full display object (UI renders it) including the signed leans the validator logs.
function computeBrief(predict, crowd, tape) {
  const reg = (tape && tape.ok) ? tape.regime : 'neutral';
  const cond = (tape && tape.ok) ? tape.condition : 'mixed';
  const regScore = reg === 'risk-on' ? 1 : reg === 'risk-off' ? -1 : 0;

  const open = (predict && predict.ok && predict.open) || [];
  const fcLeanRaw = open.reduce((s, c) => s + fcBull(c), 0);
  const topFc = open.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;

  const unusual = (crowd && crowd.ok && crowd.unusual) || [];
  const sharp = (crowd && crowd.ok && crowd.sharp) || [];
  const cAgg = aggLean(unusual), sAgg = aggLean(sharp);
  const topMover = unusual.slice().sort((a, b) => (b.movePts || 0) - (a.movePts || 0))[0] || null;
  const themes = {}; [cAgg.themes, sAgg.themes].forEach(tm => Object.entries(tm).forEach(([k, v]) => themes[k] = (themes[k] || 0) + v));

  const fcLean = sign(fcLeanRaw), crowdLean = sign(cAgg.lean), sharpLean = sign(sAgg.lean);
  const consensusRaw = 0.45 * regScore + 0.30 * fcLean + 0.15 * crowdLean + 0.10 * sharpLean;
  const cSign = sign(consensusRaw);
  let stance, tone;
  if (cSign > 0) { stance = 'Constructive / risk-on'; tone = 'bull'; }
  else if (cSign < 0) { stance = 'Defensive / risk-off'; tone = 'bear'; }
  else { stance = 'Mixed — no clear edge'; tone = 'neutral'; }
  if (cSign > 0 && cond === 'choppy') stance = 'Cautious risk-on';

  const sigs = [
    { name: 'Forecast', go: 'forecast', sign: fcLean },
    { name: 'Crowd', go: 'crowd', sign: crowdLean },
    { name: 'Sharp', go: 'sharp', sign: sharpLean },
  ];
  const active = sigs.filter(s => s.sign !== 0);
  const agree = active.filter(s => s.sign === cSign).length;

  const favM = new Map(), preM = new Map();
  const addFav = (e, why) => { if (!favM.has(e)) favM.set(e, why); };
  const addPre = (e, why) => { if (!preM.has(e)) preM.set(e, why); };
  if (regScore > 0) ['XLK', 'XLY', 'XLF', 'XLI'].forEach(e => addFav(e, 'risk-on regime'));
  else if (regScore < 0) { ['XLP', 'XLU', 'XLV'].forEach(e => addFav(e, 'risk-off — defensives lead')); ['XLK', 'XLY', 'XLF'].forEach(e => addPre(e, 'cyclicals lag risk-off')); }
  open.forEach(c => { const s = (c.subject || '').toUpperCase(); if (/^XL/.test(s)) { if (c.direction === 'outperform') addFav(s, 'forecast: outperform'); else if (c.direction === 'underperform') addPre(s, 'forecast: underperform'); } });
  Object.keys(themes).forEach(th => { const ts = THEME_SECTORS[th]; if (!ts) return; (ts.fav || []).forEach(e => addFav(e, ts.why)); (ts.pre || []).forEach(e => addPre(e, ts.why)); });
  favM.forEach((_, e) => preM.delete(e));
  const favored = [...favM].slice(0, 5).map(([etf, why]) => ({ etf, name: SECTOR_NAME[etf] || etf, why }));
  const pressured = [...preM].slice(0, 5).map(([etf, why]) => ({ etf, name: SECTOR_NAME[etf] || etf, why }));

  return {
    stance, tone, regime: reg, cond, efficiency: (tape && tape.ok) ? tape.efficiency : null,
    consensus: cSign, fcLean, crowdLean, sharpLean, regimeScore: regScore,
    topFc, topMover, sharpCount: sharp.length, themes: Object.keys(themes).sort((a, b) => themes[b] - themes[a]),
    themeLabels: THEME_LABEL, sigs, agree, activeCount: active.length, favored, pressured,
    forecastAcc: (predict && predict.ok) ? predict.accuracy : null,
  };
}

// ── Forward validation — does the brief's stance precede SPY moves? ─────────────
const BRIEF_HORIZONS = [5, 10, 21];

function spyOnOrAfter(candles, date) { for (let i = 0; i < candles.length; i++) if (candles[i].date >= date) return i; return -1; }

// Forward hit of a stance/component sign vs SPY return over a horizon.
function gradeForward(spy, fromDate, signed, h) {
  if (!signed) return null;                       // neutral → not a directional call
  const ai = spyOnOrAfter(spy, fromDate); if (ai < 0) return null;
  const bi = ai + h; if (bi >= spy.length) return null;   // not matured
  const ret = (spy[bi].close / spy[ai].close - 1) * 100;
  return { hit: (signed > 0 ? ret > 0 : ret < 0), ret: +ret.toFixed(2), exitDate: spy[bi].date };
}

function summarizeValidation(days, spy) {
  const { wilson } = require('./stats');
  const comps = ['consensus', 'fcLean', 'crowdLean', 'sharpLean', 'regimeScore'];
  const out = { n: 0, byHorizon: {}, byComponent: {} };
  comps.forEach(c => out.byComponent[c] = { hits: 0, n: 0 });
  BRIEF_HORIZONS.forEach(h => out.byHorizon[h] = { hits: 0, n: 0 });
  let resolvedAny = 0;
  for (const d of days) {
    let dayResolved = false;
    for (const h of BRIEF_HORIZONS) {
      const g = spy && spy.length ? gradeForward(spy, d.date, d.consensus, h) : null;
      if (!g) continue;
      out.byHorizon[h].n++; if (g.hit) out.byHorizon[h].hits++; dayResolved = true;
      for (const c of comps) { const r = gradeForward(spy, d.date, d[c], h); if (r) { out.byComponent[c].n++; if (r.hit) out.byComponent[c].hits++; } }
    }
    if (dayResolved) resolvedAny++;
  }
  out.n = resolvedAny;
  const allH = BRIEF_HORIZONS.reduce((a, h) => ({ hits: a.hits + out.byHorizon[h].hits, n: a.n + out.byHorizon[h].n }), { hits: 0, n: 0 });
  const ci = wilson(allH.hits, allH.n);
  out.overall = { hits: allH.hits, n: allH.n, rate: allH.n ? Math.round(allH.hits / allH.n * 100) : null, wilsonLo: allH.n ? Math.round(ci.lo * 100) : null };
  return out;
}

module.exports = { computeBrief, classifyMkt, mktLean, fcBull, sign, SECTOR_NAME, THEME_LABEL, BRIEF_HORIZONS, spyOnOrAfter, gradeForward, summarizeValidation };
