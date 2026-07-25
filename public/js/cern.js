// ⚡ EVENTS (CERN) — forced-flow event engine, novice-first view.
//
// The engine itself is unchanged; this is purely how it presents. The old view
// showed a card labelled "Trade · passed every gate · sized" while that same card
// wore a red "No edge (fades)" chip, put 19 do-not-trade cards at the same visual
// weight as the 4 actionable ones, and led with `κ·x` / `P(profit)` / "posteriors".
// A beginner could not tell what to do, or whether to believe any of it.
//
// The rewrite answers three questions in order, in plain English:
//   1. Should I trust this engine at all?   → one status banner, up top, honest.
//   2. What is it even looking for?         → a plain "what this is" line, always visible.
//   3. What would it actually do, and why?  → a few rich cards; everything else collapsed.
//
// Trust language is NOT invented here — the grade per event type is earned server-side
// by the app's single grader (lib/maturity gradeTrack, surfaced on op=cerndecay), so the
// Events tab, the Evidence tab and the Leaderboard cannot disagree about the same record.
import { esc } from './format.js';
import { fetchJSON, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';

// Plain-English name + "what actually happened" for every event type, so a novice
// never meets a raw SCREAMING_SNAKE enum. Keys mirror lib/cern.js EVENT_TYPES.
const EVENT = {
  INDEX_DELETE: { name: 'Dropped from an index', what: 'The stock was removed from a major index, so every fund tracking that index had to sell it on a deadline — regardless of price.' },
  INDEX_ADD_FADE: { name: 'Added to an index', what: 'The stock was added to a major index. Funds had to buy it, which often pushes it above fair value for a while.' },
  LOCKUP_EXPIRY: { name: 'IPO lock-up expiry', what: 'The post-IPO lock-up ended, so founders, staff and early investors all became free to sell at once.' },
  TAX_LOSS: { name: 'Tax-loss selling', what: 'Late in the year holders dump losers to book a tax write-off — selling driven by the calendar, not the business.' },
  FIRE_SALE: { name: 'Fund fire-sale', what: 'A concentrated ETF is being cashed out heavily, so it has to sell everything it owns proportionally, this name included.' },
  MARGIN_SPIRAL: { name: 'Margin-call spiral', what: 'A sharp drop triggered margin calls, forcing leveraged holders to sell into the fall — which drops it further.' },
  FORCED_DOWNGRADE: { name: 'Analyst downgrade', what: 'A sell-side downgrade sets off mechanical de-risking: mandate funds trim and quant models flip out of the name.' },
};
export const eventName = t => (EVENT[t] ? EVENT[t].name : String(t || '').replace(/_/g, ' ').toLowerCase());
const eventWhat = t => (EVENT[t] ? EVENT[t].what : 'A forced-flow event — someone had to trade regardless of price.');

// Plain-English face of the app's maturity grades. The canonical grade word stays in
// the tooltip so a card can always be traced back to the Evidence tab's verdict.
const GRADE = {
  validated: { icon: '✅', label: 'Proven', cls: 'ok' },
  promising: { icon: '🟡', label: 'Promising', cls: 'prov' },
  experimental: { icon: '🧪', label: 'Untested', cls: 'wait' },
  disabled: { icon: '⛔', label: 'Losing money so far', cls: 'bad' },
};
const gradeOf = v => GRADE[(v && v.grade) || 'experimental'] || GRADE.experimental;
// A type only counts as scored when the server actually returned a resolved record.
// Guarded rather than assumed so an older/partial payload degrades to "not scored yet"
// instead of rendering `null%` on a card a beginner might act on.
const scored = v => !!(v && v.n20 && Number.isFinite(v.finalExcess));

const pct = (n, dp = 0) => `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;
const money = n => (n == null ? '—' : `$${n}`);

export async function loadCern(container, metaEl) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading the event engine…</p></div>`;
  try {
    // State + per-type decay/grade + the app-wide evidence verdict, in parallel.
    // Everything but the state is optional — the tab still renders without them.
    const [state, decay, maturity] = await Promise.all([
      fetchJSON('/api/tracker?op=cern'),
      fetchJSON('/api/tracker?op=cerndecay').catch(() => null),
      fetchJSON('/api/tracker?op=maturity', { timeoutMs: OPTIONAL_TIMEOUT_MS }).catch(() => null),
    ]);
    if (!state || !state.ok) {
      container.innerHTML = `<div class="mom-status error"><p>${esc((state && state.error) || 'The event engine is unavailable right now.')}</p></div>`;
      return;
    }
    render(container, metaEl, state, decay, maturity);
  } catch {
    container.innerHTML = `<div class="mom-status error"><p>Could not load the event engine.</p></div>`;
  }
}

function render(container, metaEl, state, decay, maturity) {
  if (!state.configured) {
    container.innerHTML = `<div class="mom-status"><p>${esc(state.note || 'The event engine has not run yet.')} It runs once a day after the close — check back after the next run.</p></div>`;
    if (metaEl) metaEl.textContent = '· not yet initialized';
    return;
  }
  const types = (decay && decay.types) || {};
  const open = state.open || [];
  const trade = open.filter(o => o.action === 'TRADE');
  const probe = open.filter(o => o.action === 'PROBE');
  const act = [...trade, ...probe];
  const watch = open.filter(o => o.action === 'LOG_ONLY');

  container.innerHTML = statusBanner(state, types, maturity)
    + whatThisIs()
    + alertsPanel(state)
    + actionableSection(act, types)
    + watchingSection(watch, types)
    + trackRecordPanel(decay)
    + beliefsPanel(state.posteriors)
    + `<div class="chart-disclaimer">⚠ A learning system first. It logs every qualifying event whether it trades or not, and only earns real position size once its own record proves it. Not financial advice.</div>`;

  // Probes are paper — they must not be counted alongside the sized signals.
  if (metaEl) metaEl.textContent = `· ${trade.length} to act on · ${probe.length} on paper · ${watch.length} watching only`;
}

// ── 1. Should I trust this? ──────────────────────────────────────────────────
// One banner, worst-case honest. Prefers the app-wide Evidence verdict for the
// tab (single source of truth); falls back to the per-type records when the
// maturity payload is unavailable.
function statusBanner(state, types, maturity) {
  const verdict = (maturity && (maturity.strategies || []).find(s => s.id === 'events')) || null;
  const graded = Object.entries(types).filter(([, v]) => scored(v));
  const losing = graded.filter(([, v]) => v.grade === 'disabled');
  const proven = graded.filter(([, v]) => v.grade === 'validated');

  // Headline follows the WORST honest read available: the app-wide Evidence verdict
  // for this tab if there is one, else the per-type records. Headline and body must
  // never disagree — a "no track record yet" heading over a "underperforms over 77
  // resolved" body is precisely the kind of mixed message this rewrite exists to kill.
  const isLosing = (verdict && verdict.grade === 'disabled') || (losing.length && !proven.length);
  const isProven = (verdict && verdict.grade === 'validated') || (!isLosing && proven.length);

  let cls = 'wait', icon = '🧪', head = 'Watch only — no track record yet', body;
  if (isLosing) {
    cls = 'bad'; icon = '⛔'; head = 'Watch only — its results are behind the market';
  } else if (isProven) {
    cls = 'ok'; icon = '✅'; head = 'This engine has earned a proven record';
  }

  if (verdict && verdict.reason) {
    body = esc(verdict.reason);
  } else if (losing.length) {
    body = `${losing.map(([t, v]) => `${eventName(t)} averages ${pct(v.finalExcess, 1)} vs the S&P over ${v.n20} resolved`).join('; ')}.`;
  } else {
    body = 'None of its events have run long enough to be scored yet.';
  }

  // The engine's own confidence numbers are priors until events resolve — say so,
  // because every card below quotes them.
  const learned = Object.values(state.posteriors || {}).reduce((a, p) => a + (p.n || 0), 0);
  const priorNote = learned === 0
    ? `Nothing has resolved yet, so the confidence figures on the cards below are the engine's <b>starting assumptions</b>, not learned results.`
    : `${learned} resolved event${learned === 1 ? '' : 's'} have updated its confidence figures so far.`;

  return `<div class="ev-banner ${cls}">
    <div class="ev-banner-hd">${icon} ${esc(head)}</div>
    <div class="ev-banner-bd">${body}</div>
    <div class="ev-banner-bd">${priorNote} It has logged <b>${state.pendingCount + state.archiveCount}</b> events in total and is still building its record.</div>
  </div>`;
}

// ── 2. What is it even looking for? ──────────────────────────────────────────
function whatThisIs() {
  return `<div class="ev-explain">
    <b>What this tab hunts.</b> Every other screener looks for stocks going up. This one looks for
    moments when somebody <i>had</i> to sell no matter what the price was — an index fund dumping a
    stock that got deleted from the index, IPO insiders all unlocking on the same day, a fund being
    cashed out. That kind of selling can push a price below where it belongs, and it sometimes
    springs back. The engine measures how far the price fell versus its peers, checks there was no
    real bad news behind it, and tracks whether the bounce actually happens.
  </div>`;
}

// ── 3. What would it do, and why? ────────────────────────────────────────────
function actionableSection(items, types) {
  if (!items.length) {
    return `<div class="ev-sec-head">🎯 Nothing to act on today</div>
      <div class="mom-status"><p>No forced-selling event currently clears the engine's gates. That is normal — margin spirals need a real high-beta sell-off, and tax-loss selling only fires in November and December.</p></div>`;
  }
  const trade = items.filter(o => o.action === 'TRADE');
  const probe = items.filter(o => o.action === 'PROBE');
  let html = '';
  if (trade.length) {
    html += `<div class="ev-sec-head">🎯 ${trade.length} the engine would act on <span class="ev-sec-sub">cleared every gate and got a position size</span></div>`
      + `<div class="scr-grid">${trade.map(o => card(o, types[o.type])).join('')}</div>`;
  }
  if (probe.length) {
    html += `<div class="ev-sec-head">🧪 ${probe.length} test position${probe.length === 1 ? '' : 's'} <span class="ev-sec-sub">paper only — the engine is buying information, not the stock</span></div>`
      + `<div class="scr-grid">${probe.map(o => card(o, types[o.type])).join('')}</div>`;
  }
  return html;
}

// Everything the engine is only observing. Collapsed by default: these are the
// cards a beginner must NOT act on, and they outnumber the real ones ~5:1.
function watchingSection(items, types) {
  if (!items.length) return '';
  return `<details class="ev-more">
    <summary>📋 Show the ${items.length} it is only watching <span class="ev-sec-sub">logged to learn from · no position, not suggestions</span></summary>
    <div class="ev-more-note">The engine records these and checks later how they turned out. That is how it earns (or loses) the right to trade an event type. They are research, not ideas.</div>
    <div class="scr-grid">${items.map(o => card(o, types[o.type], true)).join('')}</div>
  </details>`;
}

// Reward-to-risk from the plan's own levels, direction-aware. A novice reads
// "target +18%" and stops there; the −38% stop next to it is the real story.
export function rewardRisk(o) {
  if (o.target == null || o.stop == null || !o.entry) return null;
  const long = o.side !== 'short';
  const reward = long ? o.target - o.entry : o.entry - o.target;
  const risk = long ? o.entry - o.stop : o.stop - o.entry;
  if (!(risk > 0) || !(reward > 0)) return null;
  return {
    ratio: reward / risk,
    rewardPct: (reward / o.entry) * 100,
    riskPct: (risk / o.entry) * 100,
  };
}

function card(o, typeInfo, muted = false) {
  const g = gradeOf(typeInfo);
  const rr = rewardRisk(o);
  const canonical = (typeInfo && typeInfo.grade) || 'experimental';
  const gradeTip = (typeInfo && typeInfo.gradeReason) || 'No events of this type have run the full window yet.';

  const rrLine = rr
    ? `<div class="ev-rr ${rr.ratio < 1 ? 'warn' : ''}">${rr.ratio < 1 ? '⚠ ' : ''}Reward vs risk <b>${rr.ratio.toFixed(1)} : 1</b>${rr.ratio < 1 ? ' — you would risk more than you stand to make' : ''}</div>`
    : '';

  // Sizing is shown (it is the engine's actual output) but never without the
  // evidence standing behind it — a ¼-Kelly number off an untested posterior is
  // a guess, and the card has to say so.
  const sizeLine = o.action === 'TRADE' && o.size
    ? `<div class="ev-line"><span class="ev-k">Suggested size</span><span class="ev-v"><b>${(o.size * 100).toFixed(1)}% of your account</b> <span class="ev-dim">— ${canonical === 'validated' ? 'backed by this type\'s resolved record' : 'a model guess; this event type has not proven itself yet'}</span></span></div>`
    : `<div class="ev-line"><span class="ev-k">Suggested size</span><span class="ev-v"><b>None</b> <span class="ev-dim">— tracked on paper only</span></span></div>`;

  const record = scored(typeInfo)
    ? `${typeInfo.n20} past ${eventName(o.type)} event${typeInfo.n20 === 1 ? '' : 's'} have run their course → averaged <b>${pct(typeInfo.finalExcess, 1)}</b> vs the S&P, beating it ${typeInfo.beatMktRate}% of the time`
    : `No past ${eventName(o.type)} event has run its course yet — there is nothing to judge this on`;

  const hold = typeInfo && typeInfo.recommendedHold != null
    ? `<div class="ev-line"><span class="ev-k">Holding window</span><span class="ev-v">Edge has peaked around <b>day ${typeInfo.recommendedHold}</b>${typeInfo.trustworthy ? '' : ' <span class="ev-dim">(provisional)</span>'}</span></div>`
    : (typeInfo && typeInfo.fades
      ? `<div class="ev-line"><span class="ev-k">Holding window</span><span class="ev-v ev-neg">None — this type has been behind the market from day 1</span></div>`
      : '');

  return `<div class="cx-card ev-card${muted ? ' ev-muted' : ''}">
    <div class="ev-card-top">
      <span class="cx-ticker">${esc(o.symbol)}</span>
      <span class="ev-evt">${esc(eventName(o.type))}</span>
      <span class="cx-hold ${g.cls}" title="${esc(canonical.toUpperCase())} — ${esc(gradeTip)}">${g.icon} ${esc(g.label)}</span>
    </div>
    <div class="ev-what">${esc(eventWhat(o.type))}</div>
    <div class="ev-read">${o.side === 'long'
      ? 'The engine reads the drop as forced selling that went too far, and is betting the price recovers.'
      : 'The engine reads the rise as forced buying that went too far, and is betting the price gives it back.'}</div>
    <div class="alert-targets">
      <div class="at-box"><div class="at-label">${o.side === 'long' ? 'Buy near' : 'Sell near'}</div><div class="at-val entry">${money(o.entry)}</div></div>
      <div class="at-box"><div class="at-label">Target${rr ? ` (${pct(rr.rewardPct)})` : ''}</div><div class="at-val target">${money(o.target)}</div></div>
      <div class="at-box"><div class="at-label">Stop${rr ? ` (−${rr.riskPct.toFixed(0)}%)` : ''}</div><div class="at-val stop">${money(o.stop)}</div></div>
    </div>
    ${rrLine}
    ${sizeLine}
    ${hold}
    <div class="ev-line"><span class="ev-k">Track record</span><span class="ev-v">${record}</span></div>
  </div>`;
}

// ── Track record per event type — the honest scoreboard, with the decay curve ──
function trackRecordPanel(decay) {
  const types = (decay && decay.types) || {};
  const entries = Object.entries(types).sort((a, b) => (b[1].n20 - a[1].n20) || (b[1].n - a[1].n));
  if (!entries.length) {
    return `<div class="bt-eff"><div class="bt-eff-head">📉 Has any of this ever worked?</div>
      <div class="bt-eff-sub">This fills in once events have been logged and enough time has passed to score them.</div></div>`;
  }
  const rows = entries.map(([t, v]) => {
    const g = gradeOf(v);
    const summary = scored(v)
      ? `Averaged <b class="${v.finalExcess >= 0 ? 'ev-pos' : 'ev-neg'}">${pct(v.finalExcess, 1)}</b> vs the S&P over ${v.n20} scored (beat it ${v.beatMktRate}% of the time)`
      : `${v.n} logged, none scored yet${v.daysNeeded ? ` — needs ${v.daysNeeded} more` : ''}`;
    return `<div class="cx-decay-row">
      <div class="cx-decay-hd">
        <span class="cx-decay-nm">${esc(eventName(t))}</span>
        <span class="cx-hold ${g.cls}" title="${esc((v.grade || 'experimental').toUpperCase())} — ${esc(v.gradeReason || '')}">${g.icon} ${esc(g.label)}</span>
        <span class="cx-decay-n">${v.n} logged</span>
      </div>
      <div class="ev-decay-txt">${summary}</div>
      <div class="cx-decay-chart" title="Average return versus the S&P 500 on each day after the event fires. Above the middle line means it was beating the market; below means it was behind.">${decaySvg(v, decay.maxDay || 20)}</div>
    </div>`;
  }).join('');
  return `<div class="bt-eff">
    <div class="bt-eff-head">📉 Has any of this ever worked?</div>
    <div class="bt-eff-sub">Each event type's own record: how it did against the S&P 500 on each day after firing. The <span style="color:#f0a832">amber line</span>, when present, marks the day the edge peaked — the point to be out by. A type needs ${decay.minTrust || 20} scored events before its verdict is more than provisional.</div>
    ${rows}
  </div>`;
}

// Compact inline SVG decay curve (no chart library — matches the app's house style).
function decaySvg(v, maxDay) {
  const pts = (v.curve || []).filter(c => c.avgExcess != null);
  if (pts.length < 2) return `<div class="cx-decay-empty">The curve appears once at least two days have enough scored events.</div>`;
  const W = 300, H = 84, padL = 30, padR = 8, padT = 8, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const days = v.curve.length || maxDay;
  const maxAbs = pts.reduce((m, p) => Math.max(m, Math.abs(p.avgExcess)), 1);
  const x = day => padL + ((day - 1) / (days - 1)) * plotW;
  const zeroY = padT + plotH / 2, y = val => zeroY - (val / maxAbs) * (plotH / 2);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.avgExcess).toFixed(1)}`).join(' ');
  const dots = pts.map(p => `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.avgExcess).toFixed(1)}" r="1.6" fill="${p.avgExcess >= 0 ? '#10d98a' : '#ef4444'}"/>`).join('');
  const hold = v.recommendedHold != null
    ? `<line x1="${x(v.recommendedHold).toFixed(1)}" y1="${padT}" x2="${x(v.recommendedHold).toFixed(1)}" y2="${H - padB}" stroke="#f0a832" stroke-width="1" stroke-dasharray="3 2"/>`
    : '';
  const grid = `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#3a4150"/>`
    + `<text x="${padL - 4}" y="${padT + 4}" text-anchor="end" font-size="8" fill="#8a93a6">+${maxAbs.toFixed(1)}%</text>`
    + `<text x="${padL - 4}" y="${zeroY + 3}" text-anchor="end" font-size="8" fill="#8a93a6">0</text>`
    + `<text x="${padL - 4}" y="${H - padB}" text-anchor="end" font-size="8" fill="#8a93a6">-${maxAbs.toFixed(1)}%</text>`
    + `<text x="${padL}" y="${H - 3}" font-size="8" fill="#8a93a6">day 1</text>`
    + `<text x="${W - padR}" y="${H - 3}" text-anchor="end" font-size="8" fill="#8a93a6">day ${days}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:inherit" role="img" aria-label="Average return versus the S&P by day">${grid}${hold}<path d="${line}" fill="none" stroke="#06c4d4" stroke-width="1.5"/>${dots}</svg>`;
}

// The κ posteriors — demoted behind a disclosure. Real information, but it is the
// engine's internals, not something a beginner needs before acting.
function beliefsPanel(posteriors) {
  const entries = Object.entries(posteriors || {});
  if (!entries.length) return '';
  const rows = entries.map(([k, p]) => {
    const bounce = `${Math.round(p.kappa * 100)}%`;
    const evidence = p.n
      ? `${p.n} resolved${p.tradedN ? ` · ${p.tradedN} traded` : ''}`
      : `<span class="ev-dim">nothing resolved — still the starting assumption</span>`;
    return `<div class="bt-ic-row"><span style="${p.drifted ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(eventName(k))}</span>`
      + `<span><b>${bounce}</b> <span style="color:var(--text-dim)">±${Math.round(p.sd * 100)}%</span></span>`
      + `<span>${evidence}${p.drifted ? ' <span style="color:var(--amber)">⚠ shifted</span>' : ''}</span></div>`;
  }).join('');
  return `<details class="ev-more">
    <summary>🧠 Under the hood — what the engine currently believes</summary>
    <div class="ev-more-note">For each event type the engine keeps one number: <b>how much of the price drop it expects to come back</b>. 100% would mean it expects the whole drop to reverse. The ± is how unsure it is, and the last column is how much real evidence sits behind it. Until events resolve, these are the values it was seeded with — not something it has learned.</div>
    <div class="bt-ic-row head"><span>Event type</span><span>Expected bounce-back</span><span>Evidence</span></div>
    ${rows}
  </details>`;
}

function alertsPanel(state) {
  const candidates = state.candidates || [], drift = state.drift || [];
  if (!candidates.length && !drift.length) return '';
  return drift.map(c => `<div class="bt-reco" style="background:var(--amber-dim);border-color:#f0a83233">⚠ <b>${esc(eventName(c.eventType))}</b> stopped behaving the way it used to, so the engine has automatically cut its position sizing until the pattern is clear again.</div>`).join('')
    + candidates.map(c => `<div class="bt-reco">🔬 <b>Possible new event type</b> — the engine keeps seeing the same unexplained drop-and-bounce pattern (${c.n} times) that none of its seven categories covers. ${esc(c.note || '')}</div>`).join('');
}
