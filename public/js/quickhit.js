// ⚡ QUICK HIT — the single fastest answer to "what are today's best plays?"
// Unlike ⭐ Opportunities (one cap size at a time), Quick Hit ranks the whole app's
// best setups ACROSS large + small + micro caps at once, guarantees each cap tier is
// represented, cross-confirms with the 5 AI screeners, and hands back a Top 5 — each
// card labeled with its cap size and a 📍 reference to where it lives in the app.
import { esc } from './format.js';
import { fetchPrices } from './live-price.js';
import { rankThemes, leadingThemeSet } from './themes.js';
import {
  rankOpportunities, modelHealth, buildReliability, conviction,
  oppCardInner, collectAiSignals, AI_SRC,
} from './opportunities.js';

const TOP_N = 5;

// Cap-tier metadata — the /api/screener scope, a human label, a chip, and an accent.
const CAP_META = {
  large: { scope: 'large', label: 'S&P 500',    chip: '🏢 Large cap', col: '#38bdf8' },
  small: { scope: 'small', label: 'Small caps', chip: '🏬 Small cap', col: '#a78bfa' },
  micro: { scope: 'micro', label: 'Micro caps', chip: '🔬 Micro cap', col: '#f472b6' },
};
const CAP_ORDER = ['large', 'small', 'micro'];

// Rank one scope's screener results into opportunities, tagged with their cap tier.
function rankScope(d, scope, reliability, healthFactor) {
  if (!d || !Array.isArray(d.results)) return [];
  const themesRanked = rankThemes(d.results);
  const { set: leadSet } = leadingThemeSet(themesRanked, 4);
  const themeMom = Object.fromEntries(themesRanked.map(t => [t.theme, t.mom63]));
  return rankOpportunities(d.results, reliability, healthFactor, leadSet, themeMom)
    .map(c => ({ ...c, capTier: scope, capMeta: CAP_META[scope] }));
}

// Only reserve a scarce Top-5 slot for a cap tier if that cap's best pick is
// genuinely "Solid setup" quality — we never force a weak name in just to fill a
// quota (small/micro are exactly where this app's own research is least reliable).
const RESERVE_FLOOR = 68;   // matches the "Solid setup" conviction threshold

// Group the pool by cap and sort each tier by conviction (best first).
function byCap(pool) {
  const g = { large: [], small: [], micro: [] };
  pool.forEach(p => { if (g[p.capTier]) g[p.capTier].push(p); });
  CAP_ORDER.forEach(c => g[c].sort((a, b) => b.opp - a.opp));
  return g;
}

// The single best name in each cap tier (for the always-on "Best by cap size" row).
export function bestPerCap(pool) {
  const g = byCap(pool);
  return Object.fromEntries(CAP_ORDER.map(c => [c, g[c][0] || null]));
}

// Pick the Top 5 by pure conviction, with a QUALITY-GATED nudge toward cap diversity:
// reserve one slot per cap only when that cap has a Solid-or-better pick, then fill the
// rest by global score. Honest ranking first; forced diversity never.
export function pickTop5(pool) {
  const g = byCap(pool);
  const chosen = [], seen = new Set();
  CAP_ORDER.forEach(cap => {
    const best = g[cap].find(p => !seen.has(p.ticker));
    if (best && best.opp >= RESERVE_FLOOR) { chosen.push(best); seen.add(best.ticker); }
  });
  pool.filter(p => !seen.has(p.ticker)).sort((a, b) => b.opp - a.opp)
    .forEach(p => { if (chosen.length < TOP_N) { chosen.push(p); seen.add(p.ticker); } });
  return chosen.sort((a, b) => b.opp - a.opp).slice(0, TOP_N);
}

// ── Mover leaderboards ───────────────────────────────────────────────────────
// A second lens on Quick Hit: instead of ranking SETUP quality, these two lists
// rank actual price PERFORMANCE across every name the app is surfacing right now
// (screeners, options flow, forecasts, AI screeners) — best day movers, plus the
// biggest gainers over the past week and month. Each row cites where it was found.

// Where a name can be mentioned → chip emoji, label, and the tab to open.
const SRC_META = {
  screener: ['🔎', 'Screener',     'screener'],
  options:  ['🛠️', 'Options flow', 'options'],
  forecast: ['🔮', 'Forecast',     'forecast'],
};
const srcMeta = key => SRC_META[key] || AI_SRC[key];   // AI_SRC = [emoji, label, tab]

// Market/sector ETFs & indices — excluded (we want individual stocks).
const INDEX_ETF = new Set([
  'SPY','QQQ','DIA','IWM','MDY','VTI','VOO','^VIX','VIX',
  'XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLU','XLRE','XLB','XLC',
  'SMH','SOXX','XBI','IBB','ARKK','KRE','XRT','ITB','XHB',
  'TLT','HYG','LQD','GLD','SLV','USO','UNG','BITO',
]);
const TICKER_OK = t => /^[A-Z][A-Z.\-]{0,5}$/.test(t) && !INDEX_ETF.has(t);

// Collect every surfaced ticker + the set of sources that mention it, plus a best
// display name. Returns { mentions: Map<T,Set>, company: Map<T,name> }.
function collectMentions({ large, small, micro, of, pr, aiMap }) {
  const mentions = new Map(), company = new Map();
  const add = (raw, key, co) => {
    const tk = String(raw || '').toUpperCase();
    if (!TICKER_OK(tk)) return;
    let set = mentions.get(tk); if (!set) mentions.set(tk, set = new Set());
    set.add(key);
    if (co && !company.has(tk)) company.set(tk, co);
  };
  [large, small, micro].forEach(d => (d && d.results || []).forEach(r => add(r.ticker, 'screener', r.company)));
  (of && of.byTicker || []).forEach(r => { if (!r.isIndex) add(r.ticker, 'options'); });
  (pr && pr.open || []).forEach(p => add(p.subject, 'forecast'));
  if (aiMap) aiMap.forEach((srcs, tk) => srcs.forEach(s => add(tk, s)));
  return { mentions, company };
}

// Clickable provenance chips for one mover row.
function srcChips(keys) {
  return [...keys].map(k => {
    const m = srcMeta(k); if (!m) return '';
    const [e, lbl, tab] = m;
    return `<span class="qh-mv-src" data-go="${tab}" title="Also surfaced in ${esc(lbl)} — open">${e} ${esc(lbl)}</span>`;
  }).join('');
}

// One leaderboard row: rank · ticker · company · return · provenance chips.
function moverRow(r, val, company, rank) {
  const up = val >= 0, sign = val > 0 ? '+' : '';
  return `<div class="qh-mv-row">`
    + `<span class="qh-mv-rank">${rank}</span>`
    + `<span class="qh-mv-tk">${esc(r.tk)}</span>`
    + `<span class="qh-mv-co">${esc(company.get(r.tk) || '')}</span>`
    + `<span class="qh-mv-ret ${up ? 'up' : 'down'}">${sign}${val.toFixed(1)}%</span>`
    + `<span class="qh-mv-srcs">${srcChips(r.keys)}</span>`
    + `</div>`;
}

// The two mover lists: Top-10 by day, then momentum leaders over 5 sessions + 1 month.
function moversSection(perf, mentions, company) {
  const rows = Object.entries(perf || {})
    .map(([tk, p]) => ({ tk, ...p, keys: mentions.get(tk) || new Set() }))
    .filter(r => r.keys.size);
  if (!rows.length) {
    return `<div class="qh-mv-wrap"><div class="rot-head" style="margin-top:18px">🔥 Movers</div>`
      + `<div class="dt-note">Live performance data isn't available right now — try Refresh in a moment.</div></div>`;
  }
  const top = (key, n) => rows.filter(r => r[key] != null).sort((a, b) => b[key] - a[key]).slice(0, n);
  const byDay = top('day', 10);
  const col = (title, arr, key) => `<div class="qh-mv-col"><div class="qh-mv-colh">${title}</div>`
    + (arr.length ? arr.map((r, i) => moverRow(r, r[key], company, i + 1)).join('') : `<div class="dt-note">No data.</div>`)
    + `</div>`;

  return `<div class="qh-mv-wrap">`
    + `<div class="rot-head" style="margin-top:18px">🔥 Today's Top Movers <span class="dt-dim">· best <b>live</b> intraday performers across every name the app is surfacing — screeners, options flow &amp; forecasts</span></div>`
    + `<div class="qh-mv-list">`
    + (byDay.length ? byDay.map((r, i) => moverRow(r, r.day, company, i + 1)).join('') : `<div class="dt-note">No day-change data yet.</div>`)
    + `</div>`
    + `<div class="rot-head" style="margin-top:18px">📈 Momentum Leaders <span class="dt-dim">· biggest gainers over the past week &amp; month</span></div>`
    + `<div class="qh-mv-cols">${col('Past 5 sessions', top('d5', 5), 'd5')}${col('Past month', top('m1', 5), 'm1')}</div>`
    + `</div>`;
}

// One Quick Hit card: rank + cap badge on top of the shared opportunity body, then a
// "Found in" row of clickable references to every place this name surfaces.
function qhCard(c, rank) {
  const cv = conviction(c.opp), cap = c.capMeta;
  const refs = [
    `<span class="qh-ref" data-go="opportunities" data-scope="${cap.scope}" title="Open ⭐ Opportunities, filtered to ${cap.label}">⭐ Opportunities · ${cap.label}</span>`,
    `<span class="qh-ref" data-go="screener" title="See it in the 🔎 Breakout screener">🔎 Breakout screener</span>`,
    ...(c.aiSrcs || []).map(s => { const [e, lbl, tab] = AI_SRC[s]; return `<span class="qh-ref qh-ref-ai" data-go="${tab}" title="Also independently flagged by the ${lbl} AI screener">${e} ${lbl}</span>`; }),
  ].join('');
  return `<div class="opp-card qh-card">`
    + `<div class="qh-top"><span class="qh-rank">#${rank}</span>`
    + `<span class="qh-cap" style="border-color:${cap.col};color:${cap.col}">${cap.chip}</span>`
    + `<div class="opp-id"><span class="opp-tk" data-live="${esc(c.ticker)}">${esc(c.ticker)}</span> <span class="opp-co">${esc(c.company || '')}</span></div>`
    + `<div class="opp-conv" style="color:${cv.col}" title="${cv.label}">${cv.stars}</div></div>`
    + (c.aiSrcs && c.aiSrcs.length ? `<div class="qh-crossconf">🤝 <b>Cross-confirmed</b> — also surfaced by ${c.aiSrcs.length} independent AI screener${c.aiSrcs.length > 1 ? 's' : ''}.</div>` : '')
    + oppCardInner(c)
    + `<div class="qh-refs"><span class="qh-refs-h">📍 Found in:</span>${refs}</div>`
    + `</div>`;
}

export async function loadQuickHit(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scanning large, small &amp; micro caps for today's best plays…</p></div>`;
  const j = op => fetch('/api/tracker?op=' + op).then(r => r.json()).catch(() => null);
  const scr = scope => fetch('/api/screener?scope=' + scope).then(r => r.json()).catch(() => null);
  let large, small, micro, sb, drift, rt, an, sw, ca, ts, of, pr;
  try {
    [large, small, micro, sb, drift, rt, an, sw, ca, ts, of, pr] = await Promise.all([
      scr('large'), scr('small'), scr('micro'),
      j('scoreboard'), j('drift'),
      j('readthrough'), j('anomaly'), j('secondwave'), j('crossasset'), j('toneshift'),
      j('optionsflow'), j('predict'),
    ]);
  } catch { /* handled below */ }
  if (!large && !small && !micro) { container.innerHTML = `<div class="dt-note">Couldn't load Quick Hit right now — try Refresh in a moment.</div>`; return; }

  const reliability = buildReliability(sb && sb.groups);
  const health = modelHealth(drift);
  const pool = [
    ...rankScope(large, 'large', reliability, health.factor),
    ...rankScope(small, 'small', reliability, health.factor),
    ...rankScope(micro, 'micro', reliability, health.factor),
  ];

  // Cross-confirm with the 5 AI screeners: a name independently flagged by an AI angle
  // gets a badge + a small conviction bump (two unrelated methods agreeing = stronger).
  const aiMap = new Map();
  collectAiSignals({ rt, an, sw, ca, ts }).forEach(s => {
    const set = aiMap.get(s.ticker) || new Set(); set.add(s.src); aiMap.set(s.ticker, set);
  });
  pool.forEach(p => {
    const srcs = aiMap.get(p.ticker.toUpperCase());
    if (srcs && srcs.size) { p.aiSrcs = [...srcs]; p.opp += 3; }
  });

  // Mover leaderboards: union of every surfaced name → real day/5-session/month
  // performance (candle-based, via op=perf) ranked into two lists below the shortlist.
  const { mentions, company: moverCo } = collectMentions({ large, small, micro, of, pr, aiMap });
  let perf = {};
  const union = [...mentions.keys()];
  if (union.length) {
    // Week/month returns come from daily candles (op=perf); the DAY move comes from
    // /api/price (5-min bars + pre/post, ~30s cache). Fetch both together, then let
    // the live regular-session change overwrite the candle day-change so "Today's Top
    // Movers" ranks and shows the live intraday tape, not yesterday's close-to-close.
    const [pj, live] = await Promise.all([
      fetch('/api/tracker?op=perf&tickers=' + encodeURIComponent(union.join(','))).then(r => r.json()).catch(() => null),
      fetchPrices(union).catch(() => ({})),
    ]);
    if (pj && pj.perf) perf = pj.perf;
    Object.keys(perf).forEach(tk => {
      const lp = live && live[tk] ? parseFloat(live[tk].changePct) : NaN;
      if (Number.isFinite(lp)) perf[tk].day = lp;
    });
  }

  const top = pickTop5(pool);
  const best = bestPerCap(pool);
  const regime = (large && large.regime) || (small && small.regime) || (micro && micro.regime) || {};
  const riskOff = regime.bearish === true || regime.riskOn === false;

  let html = `<div class="rot-head" style="margin-top:4px">⚡ Quick Hit <span class="dt-dim">· the Top ${TOP_N} across large, small &amp; micro caps — one ranked shortlist</span></div>`;
  if (riskOff) {
    html += `<div class="dt-note" style="border-left-color:var(--red)"><b>🛑 Risk-off backdrop.</b> New long setups fail far more often here (the one lever this app has truly validated). Treat the list below as a watchlist for when it turns — size down or wait.</div>`;
  } else {
    html += `<div class="dt-note" style="border-left-color:var(--green)"><b>✅ Constructive backdrop.</b> Market is ${regime.riskOn ? 'risk-on' : 'neutral'}${regime.breadthPct != null ? ` · breadth ${regime.breadthPct}%` : ''} — a reasonable environment to look for early longs.</div>`;
  }
  // 🏆 Best-by-cap strip — the top name in each cap size, always visible and clickable,
  // so every tier is one tap away even when the ranked Top 5 skews to one cap.
  html += `<div class="qh-caps"><span class="qh-caps-h">🏆 Best by cap size:</span>` + CAP_ORDER.map(cap => {
    const m = CAP_META[cap], b = best[cap];
    if (!b) return `<span class="qh-capchip off">${m.chip} · none today</span>`;
    return `<span class="qh-capchip on" data-go="opportunities" data-scope="${cap}" style="border-color:${m.col};color:${m.col}" title="Open ⭐ Opportunities · ${m.label}">${m.chip}: <b>${esc(b.ticker)}</b> ${conviction(b.opp).stars}</span>`;
  }).join('') + `</div>`;

  html += top.length
    ? top.map((c, i) => qhCard(c, i + 1)).join('')
    : `<div class="dt-note">No clean setups cleared the screen across any cap size today — that happens on quiet days. Check the individual screeners, or come back after the next refresh.</div>`;

  // Two performance leaderboards (day movers + week/month momentum) under the shortlist.
  html += moversSection(perf, mentions, moverCo);

  html += `<div class="dt-dim opp-foot">Ranked purely by conviction — accumulation, setup stage, momentum &amp; the model's results-trained score — then tilted by how its own recent picks are resolving and boosted when an AI screener independently agrees. A cap tier only takes a Top-${TOP_N} slot when its best name is genuinely solid (no forced quotas); the 🏆 row above always shows each tier's best regardless. Research, not advice — confirm on a chart and use a stop.</div>`;

  container.innerHTML = html;
  // Scope-aware references: remember which cap to show before ⭐ Opportunities opens.
  // (app.js wires the generic [data-go] → showTab handler after this resolves.)
  container.querySelectorAll('[data-scope]').forEach(el =>
    el.addEventListener('click', () => { try { localStorage.setItem('oppScope', el.dataset.scope); } catch {} }));
}
