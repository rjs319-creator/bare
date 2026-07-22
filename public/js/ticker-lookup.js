// Ticker lookup modal — the "search any stock" surface. Type a ticker in the
// command palette and this opens a single card that answers:
//   1. What's it doing now?  → live price + change (+ pre/after-hours)
//   2. Is it a good time to buy?  → plain-English verdict from the app's own
//      technical signal engine (lib/signal.js, via /api/chart)
//   3. Is smart money positioning?  → unusual bullish/bearish options flow for
//      the name (from the same feed as the Options tab, /api/tracker?op=optionsflow)
//   4. Is the crowd talking about it?  → mentions in the Trade Alerts social
//      screener (/api/tracker?op=alerts)
//   5. Where else does the app mention it?  → jump-to chips for any tab already
//      showing the ticker.
// The grade + chart itself is delegated to the app's shared renderChart so the
// verdict here always matches what every card in the app shows.
import { esc } from './format.js';

// Maps the signal engine's action → a plain-language "good time to buy?" answer.
const VERDICT = {
  STRONG_BUY:  { cls: 'strong_buy', icon: '✅', head: 'Yes — a strong entry',  sub: 'Multiple signals line up on the buy side right now.' },
  BUY:         { cls: 'buy',        icon: '🟢', head: 'Leaning yes',           sub: 'Momentum is positive — confirm the setup before sizing up.' },
  HOLD:        { cls: 'hold',       icon: '⏸️', head: 'Not a clear entry',     sub: 'Signals are mixed. Waiting for a cleaner setup is reasonable.' },
  SELL:        { cls: 'sell',       icon: '🔴', head: 'Not right now',         sub: 'Momentum is negative — buying here fights the trend.' },
  STRONG_SELL: { cls: 'strong_sell',icon: '⛔', head: 'No',                    sub: 'Sellers are firmly in control.' },
};

const OF_KIND = { sweep: '⚡ Sweep', block: '🧱 Block', large: '💰 Large' };

// Compact USD for option premiums (matches the Options tab's ofUsd style).
function fmtPrem(n) {
  if (n == null || isNaN(n)) return '';
  return n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'k' : '$' + n;
}

let cfg = null;           // { renderChart, findMentions, onReveal }
let overlay = null, body = null, refreshTimer = null, curTicker = null;

// Options-flow + social mentions for the open ticker, fetched once per open (the
// 60s chart refresh does NOT re-fetch these). undefined = loading, null = fetch
// failed, array = loaded (possibly empty). Kept in state so it survives the
// chart refresh's body re-render via paintExtras().
let extras = { ticker: null, options: undefined, social: undefined };

// WHY NOW composition (op=whynow) — the app's own signals reasoned into a FOR/AGAINST
// case + honest track record. Fetched once per open, survives the chart refresh via
// paintWhyNow(). undefined = loading, null = failed, object = loaded.
let whynow = { ticker: null, data: undefined };

// Verdict level → presentation. Mirrors the signal-banner colour language.
const WN_VERDICT = {
  constructive: { cls: 'constructive', icon: '✅' },
  watch:        { cls: 'watch',        icon: '👀' },
  caution:      { cls: 'caution',      icon: '⚠️' },
  quiet:        { cls: 'quiet',        icon: '·' },
};
const WN_REGIME = { 'risk-on': '🌤 Risk-on tape', 'risk-off': '⛈ Risk-off tape', neutral: '⛅ Neutral tape' };

function build() {
  overlay = document.createElement('div');
  overlay.className = 'cx-help-backdrop';
  overlay.id = 'tkl-modal';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="cx-help-card" role="dialog" aria-modal="true" aria-label="Stock lookup">
    <button class="cx-help-x" id="tkl-x" aria-label="Close">✕</button>
    <div id="tkl-body"></div>
  </div>`;
  document.body.appendChild(overlay);
  body = overlay.querySelector('#tkl-body');
  overlay.querySelector('#tkl-x').addEventListener('click', close);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });
}

function priceLine(price) {
  const chg = price.regChangePct;
  const up = chg == null ? true : chg >= 0;
  const chgTxt = chg == null ? '' :
    `<span class="tkl-chg" style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '+' : ''}${price.regChange} (${up ? '+' : ''}${chg}%)</span>`;
  const ah = price.afterHours
    ? `<span class="tkl-ah">${price.afterHours.session === 'pre' ? 'Pre' : 'After'}-hrs <b style="color:${price.afterHours.change >= 0 ? 'var(--green)' : 'var(--red)'}">$${price.afterHours.price} (${price.afterHours.change >= 0 ? '+' : ''}${price.afterHours.changePct}%)</b></span>`
    : '';
  return `<div class="tkl-price"><span class="tkl-px">$${price.live}</span>${chgTxt}</div>${ah ? `<div class="tkl-ah-row">${ah}</div>` : ''}`;
}

function verdictBanner(live) {
  const v = VERDICT[live.action] || VERDICT.HOLD;
  return `<div class="tkl-verdict sig-banner ${v.cls}">
    <div class="tkl-vic">${v.icon}</div>
    <div class="tkl-vtext">
      <div class="tkl-vhead">Good time to buy? <b>${esc(v.head)}</b></div>
      <div class="tkl-vsub">${esc(v.sub)} <span class="tkl-vconf">Signal confidence ${live.confidence}/10.</span></div>
    </div>
  </div>`;
}

function mentionsBlock(ticker) {
  const mentions = (cfg.findMentions ? cfg.findMentions(ticker) : []) || [];
  if (!mentions.length) {
    return `<div class="tkl-mentions"><div class="tkl-mtitle">Elsewhere in the app</div>
      <div class="tkl-mnone">Not currently shown on any other tab. Open a screener or the Momentum tab and it'll appear here if it's on the list.</div></div>`;
  }
  const chips = mentions.map(m =>
    `<button class="tkl-chip" data-reveal="${esc(m.id)}">${esc(m.label)}</button>`
  ).join('');
  return `<div class="tkl-mentions"><div class="tkl-mtitle">Also on these tabs — tap to jump</div>
    <div class="tkl-chips">${chips}</div></div>`;
}

// ── Unusual options flow (bullish/bearish) — same feed as the Options tab ──
function optionsSection(signals) {
  const title = '⚡ Unusual options flow';
  if (signals === undefined) return sectionLoading(title);
  if (signals === null) return sectionNote(title, 'Options-flow data is unavailable right now.');
  if (!signals.length) return sectionNote(title, 'No unusual options flow flagged for this name in the latest scan.');

  const bull = signals.filter(s => s.sentiment === 'bullish').length;
  const bear = signals.filter(s => s.sentiment === 'bearish').length;
  const lean = `<div class="tkl-lean">
    <span class="tkl-pill bull">▲ Bullish ${bull}</span>
    <span class="tkl-pill bear">▼ Bearish ${bear}</span></div>`;

  const rows = [...signals]
    .sort((a, b) => (b.premium || 0) - (a.premium || 0))
    .slice(0, 3)
    .map(s => {
      const bullS = s.sentiment === 'bullish';
      const bits = [
        `${(s.type || '').toUpperCase()}${s.strike != null ? ' $' + s.strike : ''}`,
        s.expiry || null,
        fmtPrem(s.premium) || null,
        OF_KIND[s.kind] || (s.kind ? esc(s.kind) : null),
      ].filter(Boolean).map(esc).join(' · ');
      return `<div class="tkl-flow-row"><span class="tkl-dir ${bullS ? 'bull' : 'bear'}">${bullS ? '▲' : '▼'}</span><span>${bits}</span></div>`;
    }).join('');

  return `<div class="tkl-sec"><div class="tkl-mtitle">${title}</div>${lean}${rows}
    <div class="tkl-fine">Directional lean inferred from call/put side on delayed chains — not live tape.</div></div>`;
}

// ── Social screener mentions — the Trade Alerts feed (tracked trader accounts) ──
function socialSection(alerts) {
  const title = '💬 Social buzz (Trade Alerts)';
  if (alerts === undefined) return sectionLoading(title);
  if (alerts === null) return sectionNote(title, 'Social screener data is unavailable right now.');
  if (!alerts.length) return sectionNote(title, 'Not currently trending in the Trade Alerts social screener.');

  const r = alerts[0];
  // v2 decisions use `side` (long/short) + an absolute score + action; legacy items use
  // `direction` (bullish/bearish) + a 1-5 star score. Normalize for display.
  const isV2 = r.side !== undefined || r.action !== undefined;
  const bull = isV2 ? r.side === 'long' : r.direction === 'bullish';
  const bear = isV2 ? r.side === 'short' : r.direction === 'bearish';
  const dirCls = bull ? 'bull' : bear ? 'bear' : 'neutral';
  const leanLabel = isV2 ? (r.side || 'mentioned') : (r.direction || 'mentioned');

  if (isV2) {
    const clusters = r.independentClusters || 0;
    const srcLine = [
      `${clusters} independent cluster${clusters === 1 ? '' : 's'}`,
      r.accountState ? `source: ${r.accountState}` : null,
      r.catalystStatus ? r.catalystStatus.replace(/_/g, ' ').toLowerCase() : null,
    ].filter(Boolean).join(' · ');
    return `<div class="tkl-sec"><div class="tkl-mtitle">${title} <span style="font-size:.7em;color:#8a6dff">SHADOW</span></div>
      <div class="tkl-lean">
        <span class="tkl-pill ${dirCls}">${bull ? '▲' : bear ? '▼' : '◆'} ${esc(leanLabel)}</span>
        ${r.action ? `<span class="tkl-pill neutral">${esc(r.action)}</span>` : ''}
        ${r.score != null ? `<span class="tkl-stars">${r.score}/100</span>` : ''}
        ${r.coordinated ? '<span class="tkl-pill warn">⚠ coordinated</span>' : ''}
      </div>
      <div class="tkl-fine">${esc(srcLine)}</div>
      ${(r.reasons && r.reasons[0]) ? `<div class="tkl-quote">${esc(String(r.reasons[0]).slice(0, 180))}</div>` : ''}</div>`;
  }

  // Legacy fallback.
  const stars = r.score ? '★'.repeat(r.score) + '☆'.repeat(Math.max(0, 5 - r.score)) : '';
  const accounts = Array.isArray(r.accounts) ? r.accounts.join(', ') : '';
  const srcLine = [
    r.distinctAccounts ? `${r.distinctAccounts} account${r.distinctAccounts > 1 ? 's' : ''}` : null,
    r.independentSources ? `${r.independentSources} distinct text cluster${r.independentSources > 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' · ');
  return `<div class="tkl-sec"><div class="tkl-mtitle">${title}</div>
    <div class="tkl-lean">
      <span class="tkl-pill ${dirCls}">${bull ? '▲' : bear ? '▼' : '◆'} ${esc(leanLabel)}</span>
      ${stars ? `<span class="tkl-stars">${stars}</span>` : ''}
      ${r.coordinated ? '<span class="tkl-pill warn">⚠ coordinated</span>' : ''}
    </div>
    ${srcLine ? `<div class="tkl-fine">${esc(srcLine)}${accounts ? ' · ' + esc(accounts) : ''}</div>` : ''}
    ${r.sampleText ? `<div class="tkl-quote">“${esc(String(r.sampleText).slice(0, 160))}”</div>` : ''}</div>`;
}

function sectionLoading(title) {
  return `<div class="tkl-sec"><div class="tkl-mtitle">${title}</div><div class="tkl-mnone">Checking…</div></div>`;
}
function sectionNote(title, note) {
  return `<div class="tkl-sec"><div class="tkl-mtitle">${title}</div><div class="tkl-mnone">${esc(note)}</div></div>`;
}

// ── WHY NOW — the composed FOR/AGAINST case + honest track record ──

// A signal's track record → a chip. Never a fabricated probability: it's the app's
// real logged win rate + excess-vs-benchmark, or an explicit "not enough resolved".
function wnTrackChip(track, note) {
  if (!track) return note ? `<span class="wn-track wn-track-note">${esc(note)}</span>` : '';
  if (track.pending) {
    return `<span class="wn-track wn-track-pending" title="Logged, forward-tracked — not enough have resolved to trust a rate yet">📊 tracking · ${track.resolved} resolved</span>`;
  }
  const exc = track.avgExcess != null ? `${track.avgExcess >= 0 ? '+' : ''}${track.avgExcess}% vs bench` : '';
  const wr = track.winRate != null ? `${track.winRate}% win` : '';
  const bits = [wr, exc].filter(Boolean).join(' · ');
  // A losing record must not look green — colour the chip by realised excess so the
  // honest track record reads honestly at a glance.
  const neg = track.avgExcess != null && track.avgExcess < 0;
  return `<span class="wn-track${neg ? ' wn-track-neg' : ''}" title="${track.horizon || ''} forward record over ${track.resolved} resolved picks in this signal class">📊 ${esc(bits)} · n=${track.resolved}</span>`;
}

// Per-section decile verdict → a chip. Distinct from the track record: this says whether
// the signal class's OWN conviction score actually RANKS its winners (higher scores → better
// returns), from the Scoreboard's score-decile check. A weak/negative model is flagged.
const WN_RQ = {
  predictive: ['🎯', 'wn-rq-good', 'Predictive — higher scores in this model really do win'],
  'weak-positive': ['🎯', 'wn-rq-ok', 'Weakly positive — the score has a mild edge'],
  noise: ['🌫️', 'wn-rq-noise', 'Noise — this model’s score does NOT separate winners from losers'],
  inverted: ['🔻', 'wn-rq-neg', 'Inverted — higher scores did WORSE (a red flag)'],
};
function wnRankChip(rq) {
  if (!rq || !rq.verdict || rq.ic == null) return '';
  const [icn, cls, tip] = WN_RQ[rq.verdict] || WN_RQ.noise;
  return `<span class="wn-rq ${cls}" title="${esc(tip)} — score-decile rank-IC ${rq.ic} (t=${rq.t ?? '—'}${rq.significant ? ', significant' : ''}) over ${rq.n} resolved ${rq.horizon || ''} picks in this class.">${icn} model ${rq.ic >= 0 ? '+' : ''}${rq.ic}</span>`;
}

// Section-level track record → a chip. Shown ONLY for signals that lack a per-tier
// Scoreboard track (Apex, conviction sleeve) so they still show a win rate + avg return —
// the SECTION's realized record at the score-decile horizon. Gross (not vs benchmark).
function wnSectionRecordChip(rq, hasTrack) {
  if (hasTrack || !rq || rq.winRate == null) return '';
  const pending = rq.n != null && rq.n < 15;
  if (pending) return `<span class="wn-track wn-track-pending" title="This class is tracked at the section level; not enough resolved yet for a win rate.">📊 tracking · ${rq.n} resolved</span>`;
  const avg = rq.avgReturn != null ? ` · ${rq.avgReturn >= 0 ? '+' : ''}${rq.avgReturn}% avg ${rq.horizon || ''}` : '';
  const neg = rq.avgReturn != null && rq.avgReturn < 0;
  return `<span class="wn-track${neg ? ' wn-track-neg' : ''}" title="This signal class isn't tracked per-tier on the Scoreboard, so this is the SECTION's realized record over ${rq.n} resolved ${rq.horizon || ''} picks — win rate + GROSS avg return (not benchmark-relative).">📊 ${rq.winRate}% win${avg} · n=${rq.n}</span>`;
}

function wnSignalRow(s) {
  const hasSectionRec = !s.track && s.rankQuality && s.rankQuality.winRate != null;
  return `<div class="wn-sig wn-${s.side}">
    <div class="wn-sig-h"><span class="wn-sig-mark">${s.side === 'for' ? '▲' : s.side === 'against' ? '▼' : '◆'}</span><span class="wn-sig-label">${esc(s.label)}</span>${wnTrackChip(s.track, hasSectionRec ? null : s.note)}${wnSectionRecordChip(s.rankQuality, !!s.track)}${wnRankChip(s.rankQuality)}</div>
    <div class="wn-sig-detail">${esc(s.detail)}</div>
  </div>`;
}

function whyNowBlock(data) {
  if (data === undefined) return `<div class="wn-card wn-loading"><span class="wn-badge">WHY NOW?</span><span class="wn-loadtxt">Composing the case…</span></div>`;
  if (data === null || !data.ok) return '';   // silent when unavailable — the rest of the modal still stands
  const v = WN_VERDICT[data.verdict.level] || WN_VERDICT.quiet;
  const regime = data.regime ? `<span class="wn-regime">${esc(WN_REGIME[data.regime] || data.regime)}</span>` : '';
  const forRows = data.forCase.map(wnSignalRow).join('');
  const againstRows = data.againstCase.map(wnSignalRow).join('');
  const cases = (forRows || againstRows)
    ? `<div class="wn-cases">${forRows}${againstRows}</div>`
    : '';
  return `<div class="wn-card wn-${v.cls}">
    <div class="wn-top"><span class="wn-badge">WHY NOW?</span>${regime}</div>
    <div class="wn-verdict"><span class="wn-vic">${v.icon}</span>
      <div class="wn-vtext"><div class="wn-vhead">${esc(data.verdict.headline)}</div>
      <div class="wn-vsum">${esc(data.verdict.summary)}</div></div></div>
    ${cases}
    ${coverageBlock(data.coverage)}
    ${data.trackAsOf ? `<div class="wn-asof" title="When the track-record snapshot backing these signals was last computed">📅 Track record as of ${esc(String(data.trackAsOf).slice(0, 10))}${data.scoringVersion ? ` · model ${esc(data.scoringVersion)}` : ''}</div>` : ''}
    <div class="wn-fine">${esc(data.disclaimer)}</div>
  </div>`;
}

// Full model coverage (#5) — every lens the app ran, INCLUDING the quiet and no-data
// ones. Collapsed so it informs without shouting; the honest "we checked, nothing here".
const WN_COV = { active: ['🟢', 'wn-cov-active'], clear: ['○', 'wn-cov-clear'], unavailable: ['—', 'wn-cov-na'] };
function coverageBlock(coverage) {
  if (!Array.isArray(coverage) || !coverage.length) return '';
  const active = coverage.filter(c => c.status === 'active').length;
  const rows = coverage.map(c => {
    const [mark, cls] = WN_COV[c.status] || WN_COV.unavailable;
    return `<div class="wn-cov-row ${cls}"><span class="wn-cov-mark">${mark}</span><span class="wn-cov-label">${esc(c.label)}</span><span class="wn-cov-detail">${esc(c.detail || '')}</span></div>`;
  }).join('');
  return `<details class="wn-coverage"><summary>Model coverage — every lens checked <span class="wn-cov-count">${active}/${coverage.length} active</span></summary><div class="wn-cov-body">${rows}</div></details>`;
}

// Collapsible pillar-level breakdown — raw scores, no verdict spin.
function pillarBars(pillars, labels) {
  if (!pillars) return '';
  return Object.keys(pillars).map(k => {
    const val = Math.max(0, Math.min(100, Math.round(pillars[k] || 0)));
    const lbl = (labels && labels[k]) || k;
    return `<div class="wn-pillar"><span class="wn-plabel">${esc(lbl)}</span><span class="wn-pbar"><span class="wn-pfill" style="width:${val}%"></span></span><span class="wn-pval">${val}</span></div>`;
  }).join('');
}

function breakdownBlock(data) {
  if (!data || data === undefined || data === null || !data.ok) return '';
  const b = data.breakdown || {};
  if (!b.apex && !b.ghost && !(data.signals && data.signals.length)) return '';
  const apexB = b.apex ? `<div class="wn-bd-grp"><div class="wn-bd-h">Apex breakout — composite ${b.apex.score}/100${b.apex.tier ? ` · ${esc(b.apex.tier)}` : ''}</div>${pillarBars(b.apex.pillars, b.apex.labels)}</div>` : '';
  const ghostB = b.ghost ? `<div class="wn-bd-grp"><div class="wn-bd-h">Ghost accumulation — ${b.ghost.score}/100 · ${esc(b.ghost.tier)}</div>${pillarBars(b.ghost.pillars, b.ghost.labels)}</div>` : '';
  // Any context signals (insider, neutral tape) not already in the FOR/AGAINST case.
  const ctx = (data.context || []).map(wnSignalRow).join('');
  const ctxB = ctx ? `<div class="wn-bd-grp"><div class="wn-bd-h">Also noted</div>${ctx}</div>` : '';
  if (!apexB && !ghostB && !ctxB) return '';
  return `<details class="wn-breakdown"><summary>Signal breakdown</summary><div class="wn-bd-body">${apexB}${ghostB}${ctxB}</div></details>`;
}

function paintWhyNow() {
  const el = body && body.querySelector('#tkl-whynow');
  if (el) el.innerHTML = whyNowBlock(whynow.data);
  const bd = body && body.querySelector('#tkl-breakdown');
  if (bd) bd.innerHTML = breakdownBlock(whynow.data);
}

// Fetch the composed WHY NOW once per open, then repaint. Degrades to silent on error.
async function loadWhyNow(ticker) {
  const T = ticker.toUpperCase();
  whynow = { ticker: T, data: undefined };
  try {
    const r = await fetch('/api/tracker?op=whynow&ticker=' + encodeURIComponent(T));
    const j = r.ok ? await r.json() : null;
    if (curTicker !== T) return;   // user moved on
    whynow.data = j && j.ok ? j : null;
  } catch { if (curTicker === T) whynow.data = null; }
  paintWhyNow();
}

// Paint the options + social sections from current `extras` state (called on
// first render and again whenever fetchExtras resolves).
function paintExtras() {
  const flowEl = body.querySelector('#tkl-flow');
  const socEl = body.querySelector('#tkl-social');
  if (flowEl) flowEl.innerHTML = optionsSection(extras.options);
  if (socEl) socEl.innerHTML = socialSection(extras.social);
}

// Fetch unusual options flow + social mentions once per open, filter to the
// ticker, then repaint. Each source degrades independently on failure.
async function loadExtras(ticker) {
  const T = ticker.toUpperCase();
  extras = { ticker: T, options: undefined, social: undefined };
  const [opt, soc] = await Promise.allSettled([
    fetch('/api/tracker?op=optionsflow').then(r => (r.ok ? r.json() : null)),
    fetch('/api/tracker?op=alerts').then(r => (r.ok ? r.json() : null)),
  ]);
  if (curTicker !== T) return;   // user moved on before both resolved
  extras.options = opt.status === 'fulfilled' && opt.value && Array.isArray(opt.value.signals)
    ? opt.value.signals.filter(s => (s.ticker || '').toUpperCase() === T) : null;
  // Prefer the v2 source-aware decisions; fall back to the legacy ranked list.
  const socList = soc.status === 'fulfilled' && soc.value
    ? (Array.isArray(soc.value.decisions) ? soc.value.decisions
      : (soc.value.legacy && Array.isArray(soc.value.legacy.ranked)) ? soc.value.legacy.ranked : null)
    : null;
  extras.social = socList ? socList.filter(x => (x.ticker || '').toUpperCase() === T) : null;
  paintExtras();
}

function renderBody(data) {
  const { ticker, live, price } = data;
  body.innerHTML = `
    <div class="tkl-head"><span class="tkl-tk">📈 ${esc(ticker)}</span></div>
    ${priceLine(price)}
    <div id="tkl-whynow"></div>
    ${verdictBanner(live)}
    <div id="tkl-chart"></div>
    <div id="tkl-breakdown"></div>
    <div id="tkl-flow"></div>
    <div id="tkl-social"></div>
    ${mentionsBlock(ticker)}`;

  // Delegate the grade banner + levels + live chart to the app's shared renderer.
  const chartPanel = body.querySelector('#tkl-chart');
  try { cfg.renderChart(chartPanel, data); }
  catch { chartPanel.innerHTML = `<div class="chart-err">Chart unavailable.</div>`; }

  paintWhyNow();  // fill the WHY NOW block + breakdown from state
  paintExtras();  // fill options/social from state (loading first time, data on refresh)

  body.querySelectorAll('.tkl-chip').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.reveal;
    close();                       // close() clears curTicker, so read it first
    if (cfg.onReveal) cfg.onReveal(id, ticker);
  }));
}

async function load(ticker, silent) {
  try {
    const res = await fetch('/api/chart?ticker=' + encodeURIComponent(ticker));
    if (!res.ok) throw new Error('no data');
    const data = await res.json();
    if (curTicker !== ticker) return;   // user moved on
    renderBody(data);
  } catch {
    if (!silent && curTicker === ticker) {
      body.innerHTML = `<div class="tkl-head"><span class="tkl-tk">📈 ${esc(ticker)}</span></div>
        <div class="chart-err">Couldn't load data for ${esc(ticker)}. Check the symbol and try again.</div>`;
    }
  }
}

export function openTickerLookup(ticker) {
  if (!overlay) return;
  const tk = (ticker || '').toUpperCase().trim();
  if (!tk) return;
  curTicker = tk;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  extras = { ticker: tk, options: undefined, social: undefined };
  whynow = { ticker: tk, data: undefined };
  body.innerHTML = `<div class="tkl-head"><span class="tkl-tk">📈 ${esc(tk)}</span></div>
    <div class="chart-loading"><div class="mom-spinner"></div>Loading live price, chart &amp; signal for ${esc(tk)}…</div>`;
  load(tk);
  loadExtras(tk);   // options flow + social mentions — once per open, not on refresh
  loadWhyNow(tk);   // composed WHY NOW case + track record — once per open
  // Keep it live while open — /api/chart is cached 60s server-side, so cheap.
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => load(tk, true), 60 * 1000);
}

function close() {
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = '';
  curTicker = null;
  extras = { ticker: null, options: undefined, social: undefined };
  whynow = { ticker: null, data: undefined };
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export function initTickerLookup(config) {
  cfg = config;
  build();
}
