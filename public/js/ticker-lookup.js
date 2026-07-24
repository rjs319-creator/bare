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
import { fetchJSON } from './fetch-json.js';

// ── Three-horizon read (intraday / swing / long-term) ───────────────────────
// Each horizon is INDEPENDENT (see lib/signal.js, lib/swingread.js, lib/longterm.js)
// and gets its own timeframe-aware card. We deliberately DO NOT show a single
// universal "Good time to buy? Yes/No" banner any more — the answer depends on the
// holding period, and the horizons frequently (honestly) disagree.
const HZ_SIGN = {
  STRONG_BUY:  { cls: 'buy',  icon: '✅', word: 'STRONG BUY' },
  BUY:         { cls: 'buy',  icon: '🟢', word: 'BUY' },
  HOLD:        { cls: 'wait', icon: '⏸️', word: 'WAIT' },
  WAIT:        { cls: 'wait', icon: '⏸️', word: 'WAIT' },
  NEUTRAL:     { cls: 'wait', icon: '⏸️', word: 'NEUTRAL' },
  SELL:        { cls: 'sell', icon: '🔴', word: 'SELL' },
  STRONG_SELL: { cls: 'sell', icon: '⛔', word: 'STRONG SELL' },
  UNAVAILABLE: { cls: 'na',   icon: '—',  word: 'UNAVAILABLE' },
};
const LT_SIGN = {
  bullish: { cls: 'buy',  icon: '🔼', word: 'BULLISH' },
  bearish: { cls: 'sell', icon: '🔻', word: 'BEARISH' },
  neutral: { cls: 'wait', icon: '⏸️', word: 'NEUTRAL' },
};
const FRESH = {
  live: ['🟢', 'Live'], stale: ['⚠', 'Stale data'], premarket: ['🌅', 'Pre-market'],
  afterhours: ['🌙', 'After-hours'], closed: ['●', 'Market closed'],
  'daily-fallback': ['⚠', 'Daily fallback'], 'daily-close': ['📅', 'Daily close'],
};
const OVERALL_LABEL = {
  'aligned-bullish': ['✅', 'Aligned bullish'], 'aligned-bearish': ['⛔', 'Aligned bearish'],
  'conflicting': ['⚖️', 'Horizons conflict'], 'leaning-bullish': ['🟢', 'Leaning bullish'],
  'leaning-bearish': ['🔴', 'Leaning bearish'], 'neutral': ['⏸️', 'Neutral'], 'unavailable': ['—', 'Limited data'],
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

// A small "evidence strength" meter — NEVER a percentage/probability (there is no
// calibrated model behind any of these numbers; it's signed-evidence magnitude).
function evidenceMeter(n) {
  if (n == null) return '';
  const v = Math.max(0, Math.min(10, Math.round(n)));
  return `<span class="hz-ev" title="Evidence strength ${v}/10 — a heuristic weight of the signals, NOT a probability of rising.">
    <span class="hz-ev-bar"><span class="hz-ev-fill" style="width:${v * 10}%"></span></span><span class="hz-ev-num">${v}/10</span></span>`;
}

function freshBadge(f) {
  const [ic, lbl] = FRESH[f] || ['·', f || ''];
  return f ? `<span class="hz-fresh f-${(f || '').replace(/[^a-z]/g, '')}" title="Data freshness">${ic} ${esc(lbl)}</span>` : '';
}

// One horizon card. `c` is a normalized view-model (see buildHorizonCards).
function horizonCard(c) {
  const s = c.sign;
  const reasons = (c.reasons || []).slice(0, 4).map(r =>
    `<li>${esc(r)}</li>`).join('');
  const counter = c.counter ? `<div class="hz-line hz-counter"><span class="hz-k">Counter</span><span>${esc(c.counter)}</span></div>` : '';
  const confirm = c.confirm ? `<div class="hz-line hz-confirm"><span class="hz-k">Confirm</span><span>${esc(c.confirm)}</span></div>` : '';
  const invalid = c.invalidate ? `<div class="hz-line hz-invalid"><span class="hz-k">Invalidates</span><span>${esc(c.invalidate)}</span></div>` : '';
  const objective = c.objective ? `<div class="hz-line hz-obj"><span class="hz-k">Objective</span><span>${esc(c.objective)}</span></div>` : '';
  const factors = c.factors ? `<details class="hz-more"><summary>Details</summary><div class="hz-more-body">${c.factors}</div></details>` : '';
  return `<div class="hz-card ${s.cls}">
    <div class="hz-head"><span class="hz-icon">${c.icon}</span><div class="hz-titles"><div class="hz-title">${esc(c.title)}</div><div class="hz-period">${esc(c.period)}</div></div>${freshBadge(c.fresh)}</div>
    <div class="hz-sign ${s.cls}">${s.icon} ${s.word}</div>
    ${c.available === false ? `<div class="hz-unavail">${esc(c.unavailReason || 'Data feed unavailable.')}</div>` : `
    <div class="hz-ev-row">${evidenceMeter(c.evidence)}</div>
    ${reasons ? `<ul class="hz-reasons">${reasons}</ul>` : ''}
    ${counter}${confirm}${invalid}${objective}`}
    <div class="hz-foot">${esc(c.version || '')}${c.calibrated === false ? ' · uncalibrated' : ''}</div>
    ${factors}
  </div>`;
}

// Normalize the /api/chart payload's three horizons into card view-models.
function buildHorizonCards(data) {
  const intraday = data.intraday || data.live || {};
  const swing = data.swing || null;
  const lt = data.longTerm || null;
  const cards = [];

  // Intraday
  {
    const sign = HZ_SIGN[intraday.action] || HZ_SIGN.HOLD;
    const lv = intraday.levels;
    cards.push({
      title: 'Intraday', period: 'Today · current session', icon: '⏱',
      sign, evidence: intraday.evidenceStrength ?? intraday.confidence,
      fresh: intraday.freshness || (data.source === 'yahoo' ? 'live' : 'daily-fallback'),
      available: intraday.available !== false && intraday.action !== 'UNAVAILABLE',
      unavailReason: (intraday.reasons || [])[0],
      reasons: intraday.reasons, counter: (intraday.counter || [])[0],
      confirm: lv ? `Entry ~$${lv.entry}` : null,
      invalidate: lv ? `Stop $${lv.stop}` : null,
      objective: lv ? `Target $${lv.target} (R/R ${lv.riskReward})` : null,
      calibrated: false, version: intraday.version || 'intraday-v1',
      factors: `RSI ${intraday.rsi ?? '—'} · VWAP ${intraday.vwap != null ? '$' + intraday.vwap : '—'} · levels sized on <b>intraday</b> ATR`,
    });
  }
  // Swing
  if (swing) {
    const sign = HZ_SIGN[swing.action] || HZ_SIGN.WAIT;
    const p = swing.plan;
    cards.push({
      title: 'Swing', period: swing.horizon || '2–12 weeks', icon: '📐',
      sign, evidence: swing.evidenceStrength,
      fresh: swing.freshness || 'daily-close',
      available: swing.available !== false && swing.action !== 'UNAVAILABLE',
      unavailReason: (swing.reasons || [])[0],
      reasons: swing.reasons, counter: (swing.risks || swing.counter || [])[0],
      confirm: p ? `Trigger $${p.trigger} (${p.setupType})` : null,
      invalidate: p ? `Invalidation $${p.invalidation}` : null,
      objective: p ? `Objective $${p.objective}` : null,
      calibrated: false, version: swing.version || 'swing-v1',
      factors: swingFactorsHtml(swing),
    });
  } else {
    cards.push({ title: 'Swing', period: '2–12 weeks', icon: '📐', sign: HZ_SIGN.UNAVAILABLE, available: false, unavailReason: 'Daily data unavailable for a swing read.', calibrated: false, version: 'swing-v1' });
  }
  // Long-term
  if (lt) {
    const sign = LT_SIGN[lt.trend] || LT_SIGN.neutral;
    cards.push({
      title: 'Long term', period: lt.horizon || '6–12 months', icon: '📈',
      sign, evidence: lt.score != null ? Math.min(10, Math.abs(lt.score)) : null,
      fresh: lt.freshness || 'daily-close',
      available: lt.available !== false,
      reasons: lt.reasons, counter: null,
      confirm: null, invalidate: lt.factors && lt.factors.sma200 != null ? `Below 200-day $${lt.factors.sma200}` : null,
      objective: null, calibrated: lt.calibrated === true, version: lt.version || 'lt-v1',
      factors: ltFactorsHtml(lt),
    });
  } else {
    cards.push({ title: 'Long term', period: '6–12 months', icon: '📈', sign: HZ_SIGN.UNAVAILABLE, available: false, unavailReason: 'Daily data unavailable for a long-term read.', calibrated: false, version: 'lt-v1' });
  }
  return cards;
}

function swingFactorsHtml(sw) {
  const f = sw.factors || {};
  const bits = [
    f.excess63Pct != null ? `RS vs mkt 3mo ${f.excess63Pct >= 0 ? '+' : ''}${f.excess63Pct}pts` : (sw.benchmarkAvailable === false ? 'RS: SPY unavailable' : null),
    f.sma50SlopePct != null ? `50-day slope ${f.sma50SlopePct >= 0 ? '+' : ''}${f.sma50SlopePct}%` : null,
    f.extensionATR != null ? `${f.extensionATR} ATR from 20-day` : null,
    f.rangePos63 != null ? `range pos ${Math.round(f.rangePos63 * 100)}%` : null,
    sw.families ? `families → trend ${sw.families.trend}, RS ${sw.families.relativeStrength ?? 'n/a'}, vol ${sw.families.participation}` : null,
    sw.sectorAvailable === false ? 'sector benchmark: n/a' : null,
  ].filter(Boolean).map(esc).join(' · ');
  return bits + '<div class="hz-fine">Swing levels sized on <b>daily</b> ATR. Objective is a risk reference, not a forecast.</div>';
}
function ltFactorsHtml(lt) {
  const f = lt.factors || {};
  return [
    f.pctFrom200 != null ? `${f.pctFrom200 >= 0 ? '+' : ''}${f.pctFrom200}% vs 200-day` : null,
    f.rs3mPct != null ? `RS 3mo ${f.rs3mPct >= 0 ? '+' : ''}${f.rs3mPct}pts` : null,
    f.pctFrom52wHigh != null ? `${f.pctFrom52wHigh}% from 52w high` : null,
  ].filter(Boolean).map(esc).join(' · ');
}

// The synthesis banner + three-column horizon grid — replaces the old single verdict.
function horizonSection(data) {
  const cards = buildHorizonCards(data);
  const grid = cards.map(horizonCard).join('');
  const sum = data.horizonSummary;
  let synth = '';
  if (sum) {
    const [ic, lbl] = OVERALL_LABEL[sum.overall] || ['·', sum.overall];
    const conflicts = (sum.conflicts || []).length
      ? `<div class="hz-conflicts">${sum.conflicts.map(c => `<span class="hz-conflict">⚠ ${esc(c)}</span>`).join('')}</div>`
      : '';
    synth = `<div class="hz-synth">
      <div class="hz-synth-top"><span class="hz-overall ov-${(sum.overall || '').replace(/[^a-z]/g, '')}">${ic} ${esc(lbl)}</span></div>
      <div class="hz-headline">${esc(sum.headline)}</div>
      ${conflicts}
      <div class="hz-note">${esc(sum.note || '')}</div>
    </div>`;
  }
  return `<div class="tkl-horizons-wrap">${synth}<div class="tkl-horizons">${grid}</div>
    <div class="hz-disclaimer">Three independent reads for three holding periods. A swing/long-term <b>SELL</b> or <b>BEARISH</b> means the multi-week/multi-month setup is damaged or an avoid — it does <b>not</b> tell a long-only trader to short. Educational, not financial advice.</div></div>`;
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
    const j = await fetchJSON('/api/tracker?op=whynow&ticker=' + encodeURIComponent(T));
    if (curTicker !== T) return;   // user moved on
    whynow.data = j && j.ok ? j : null;
  } catch { if (curTicker === T) whynow.data = null; }
  paintWhyNow();
}

// 🧾 Evidence & Thesis panel — fetch this ticker's slot in the latest evidence snapshot
// (op=evidencestock) and render what materially changed + the transparent consensus score.
// Silent/absent when the ticker isn't in today's snapshot (the honest empty state).
const EV_LEVEL = {
  strengthened: '🟢 Strengthened', improving: '🟩 Improving', deteriorating: '🟧 Deteriorating',
  weakened: '🔴 Weakened', conflicting: '🟨 Conflicting', stable: '⚪ Stable', none: '⚪ No events',
};
const EV_HORIZON = { swing: 'Swing (days–weeks)', long_term: 'Long-term (months)', both: 'Swing + Long-term', unclear: 'horizon unclear' };
async function loadEvidenceStock(ticker) {
  const T = ticker.toUpperCase();
  let j = null;
  try { j = await fetchJSON('/api/tracker?op=evidencestock&ticker=' + encodeURIComponent(T) + '&_cb=' + Date.now()); }
  catch { j = null; }
  if (curTicker !== T) return;
  const host = body && body.querySelector('#tkl-evidence');
  if (!host) return;
  if (!j || !j.ready || !j.evidence) { host.innerHTML = ''; return; }   // not in snapshot → show nothing
  host.innerHTML = evidencePanel(j.evidence, j.date);
}

function evidencePanel(ev, date) {
  const t = ev.thesis || {}, c = ev.consensus || {};
  const scored = c.state === 'scored';
  const score = scored ? Math.round(c.score) : '—';
  const subs = scored ? [['Evidence', c.subscores?.evidence], ['Revision', c.subscores?.revision], ['Mkt confirm', c.subscores?.marketConfirm], ['Catalyst', c.subscores?.catalyst], ['Source', c.subscores?.source]]
    .filter(x => x[1] != null).map(x => `<span class="tkl-ev-sub">${x[0]} <b>${x[1] > 0 ? '+' : ''}${Math.round(x[1])}</b></span>`).join('') : '';
  const pens = scored ? Object.entries(c.penalties || {}).filter(([, v]) => v < 0).map(([k, v]) => `<span class="tkl-ev-pen">${esc(k)} ${Math.round(v)}</span>`).join('') : '';
  const drivers = (t.drivers || []).slice(0, 3).map(d => `<li><span class="tkl-ev-etype">${esc(d.eventType)}</span> ${esc(d.claim)}</li>`).join('');
  const clusters = (ev.clusters || []).map(cl => {
    const pr = cl.primary || {};
    const dup = cl.derivativeCount > 0 ? `${cl.coverageCount} articles → 1 event` : '1 source';
    return `<div class="tkl-ev-cl">${cl.hasPrimarySource ? '🟢' : '⚪'} <b>${esc(pr.eventType || '')}</b> — ${esc(pr.claim || '')} <span class="tkl-ev-dup">(${dup})</span></div>`;
  }).join('');
  return `<div class="tkl-ev">
    <div class="tkl-ev-head">🧾 Evidence &amp; Thesis <span class="tkl-ev-date">${esc(date || '')}</span></div>
    ${scored ? '' : '<div class="tkl-ev-insuff">🚫 Insufficient independent evidence to assert a thesis change.</div>'}
    <div class="tkl-ev-verdict">
      <span class="tkl-ev-level">${EV_LEVEL[t.level] || ''}</span>
      <span class="tkl-ev-score">${score}<small>/100</small></span>
      <span class="tkl-ev-hz">${EV_HORIZON[t.horizon] || ''}</span>
      <span class="tkl-ev-conf">${t.confirmed ? '✓ confirmed' : 'unconfirmed'}</span>
    </div>
    ${t.headline ? `<div class="tkl-ev-hl">${esc(t.headline)}</div>` : ''}
    ${subs ? `<div class="tkl-ev-subs">${subs}${pens ? ` <span class="tkl-ev-pensep">penalties:</span> ${pens}` : ''}</div>` : ''}
    ${scored ? `<div class="tkl-ev-breadth">${c.distinctFamilies} independent evidence ${c.distinctFamilies === 1 ? 'family' : 'families'} · ${c.clusterCount} event${c.clusterCount === 1 ? '' : 's'} · ${c.coverageCount} article${c.coverageCount === 1 ? '' : 's'} collapsed</div>` : ''}
    ${drivers ? `<div class="tkl-ev-drivers"><div class="tkl-ev-dh">What changed</div><ul>${drivers}</ul></div>` : ''}
    ${clusters ? `<details class="tkl-ev-src"><summary>Sources</summary>${clusters}</details>` : ''}
  </div>`;
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
    fetchJSON('/api/tracker?op=optionsflow'),
    fetchJSON('/api/tracker?op=alerts'),
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
  const { ticker, price } = data;
  body.innerHTML = `
    <div class="tkl-head"><span class="tkl-tk">📈 ${esc(ticker)}</span></div>
    ${priceLine(price)}
    <div id="tkl-whynow"></div>
    <div id="tkl-evidence"></div>
    ${horizonSection(data)}
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
  loadEvidenceStock(ticker);  // 🧾 Evidence & Thesis panel (op=evidencestock), async fill

  body.querySelectorAll('.tkl-chip').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.reveal;
    close();                       // close() clears curTicker, so read it first
    if (cfg.onReveal) cfg.onReveal(id, ticker);
  }));
}

async function load(ticker, silent) {
  try {
    const data = await fetchJSON('/api/chart?ticker=' + encodeURIComponent(ticker));
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
