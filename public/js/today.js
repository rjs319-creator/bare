// 🏠 TODAY — the unified decision command center (#1/#2/#10). Renders the server-
// authoritative op=today payload: every screener's picks normalized into ONE ranked,
// validated table, bucketed by horizon, with an HONEST independent-evidence count
// (not a screener-count), lifecycle state, execution-aware ranking, upcoming risk
// events, and data-freshness. The engine lives in lib/decision.js (server) — this
// module only renders, so there is no client/server scoring skew.
import { esc } from './format.js';

const HORIZONS = [
  ['intraday', '⚡ Intraday', 'gaps · momentum · VWAP/ORB — same-session'],
  ['swing', '📈 Swing', 'breakouts · coils · accumulation — days to weeks'],
  ['position', '🧭 Position', '1–6 month leads — momentum, revisions, cross-asset'],
  ['portfolio', '💼 Portfolio', 'core momentum sleeve — quarterly rebalance, multi-month hold'],
];
const STATE = {
  detected: ['·', 'Detected', 'st-grey'], early: ['🌱', 'Early', 'st-grey'],
  ready: ['🟢', 'Ready', 'st-green'], triggered: ['🚀', 'Triggered', 'st-green'],
  extended: ['🟡', 'Extended', 'st-amber'], failed: ['❌', 'Failed', 'st-red'],
  expired: ['⏰', 'Expired', 'st-red'], resolved: ['🏁', 'Resolved', 'st-grey'],
};
const SRC_TAB = { screener: 'screener', gapgo: 'gapgo', daytrade: 'daytrade', coil: 'coil', coremo: 'coremo', biotech: 'biotech', gapdown: 'gapdown',
  readthrough: 'readthrough', anomaly: 'anomaly', secondwave: 'secondwave', crossasset: 'crossasset', toneshift: 'toneshift' };

// Evidence grade per source (section → {icon,label,grade}), from op=maturity. Lets
// every card carry the EARNED trust grade next to its raw score — the honest read
// (a 0–100 score is a relative rank, the grade is what the track record supports).
let GRADES = {};
// The shadow challenger board (op=challenger). Optional — renders only when present, and is
// clearly labeled SHADOW / zero-weight; it never affects the production ranks above it.
let CHALLENGER = null;
function applyChallenger(c) { CHALLENGER = c && c.ok ? c : null; }
function gradeChip(sig) {
  const g = GRADES[sig.section];
  if (!g) return '';
  return `<span class="td-grade mat-${esc(g.grade)}" title="${esc(g.blurb || '')}">${g.icon} ${esc(g.label)}</span>`;
}
function pctileChip(sig) {
  if (sig.percentile == null) return '';
  return `<span class="td-pctile" title="Universe percentile — a relative rank within this screen, NOT a probability.">${sig.percentile}th pct</span>`;
}
// Strategy-family chip (#2) — the archetype this trade belongs to (Trend / Early-momentum /
// Event-driven / Intraday / Context), consolidating overlapping screeners under one banner.
// The contributing models stay visible via the evidence line's screener list.
let FAM_LEGEND = {};
function familyChip(sig) {
  const key = sig.strategyFamily;
  const meta = key && FAM_LEGEND[key];
  if (!meta) return '';
  const extra = (sig.strategyFamilies && sig.strategyFamilies.length > 1)
    ? ` +${sig.strategyFamilies.length - 1}` : '';
  return `<span class="td-fam fam-${esc(key)}" title="Strategy family — ${esc(meta.blurb || '')}${extra ? ' · also spans other families' : ''}">${meta.icon} ${esc(meta.label)}${extra}</span>`;
}

const pct = v => (v == null ? '' : `${v > 0 ? '+' : ''}${v}%`);

// Daily no-trade / opportunity-density banner (#6) — the first read of the day: is the
// opportunity set strong enough to trade at all? Regime is only a penalty in the score, so a
// bullish tape with weak candidates still reads "selective", never a forced "go".
const OPP = {
  normal: ['🟢', 'op-normal', 'Normal opportunity'],
  selective: ['🟡', 'op-selective', 'Be selective'],
  reduced: ['🟠', 'op-reduced', 'Reduced exposure'],
  'no-trade': ['🔴', 'op-notrade', 'No trade today'],
};
function opportunityBanner(o) {
  if (!o || !o.decision) return '';
  const [icon, cls, label] = OPP[o.decision] || OPP.selective;
  const avail = Object.entries(o.byHorizon || {})
    .filter(([, v]) => v.availability !== 'none')
    .map(([h, v]) => `${h} ${v.availability === 'available' ? '✓' : '·'}`).join(' · ') || 'none';
  const reasons = (o.reasons || []).slice(0, 2).map(r => `<li>${esc(r)}</li>`).join('');
  return `<div class="td-opp ${cls}">`
    + `<div class="td-opp-head"><span class="td-opp-badge">${icon} <b>${esc(label)}</b></span>`
    + `<span class="td-opp-metrics">density <b>${o.score}</b>/100 · max exposure <b>${o.maxExposurePct}%</b>`
    + (o.qualifyingCount != null ? ` · <b>${o.qualifyingCount}</b> qualify` : '')
    + (o.expectedBestEdgeAfterCostsPct != null ? ` · best net edge <b>${pct(o.expectedBestEdgeAfterCostsPct)}</b>` : '') + `</span></div>`
    + (reasons ? `<ul class="td-opp-why">${reasons}</ul>` : '')
    + `<div class="td-opp-avail td-dim">Available: ${esc(avail)}</div>`
    + `</div>`;
}

// Independent-evidence chip — the honest core of #3. Shows how many DISTINCT families
// back the name, flags the misleading "several screeners but one factor" case.
function evidenceLine(sig, legend) {
  const e = sig.evidence || {};
  const names = (e.families || []).map(f => (legend && legend[f]) || f);
  const warn = e.singleFamily ? ` <span class="td-warn" title="Multiple screeners agree but they read the SAME factor — really one confirmation, not several.">⚠️ correlated</span>` : '';
  const src = (sig.sources || []).length > 1 ? ` <span class="td-dim">· ${sig.sources.length} screeners</span>` : '';
  return `<div class="td-eviden">🧩 <b>${e.familyCount || 1}</b> independent ${e.familyCount === 1 ? 'family' : 'families'}: ${esc(names.join(' + '))}${src}${warn}</div>${redundancyLine(sig)}`;
}

// The MEASURED redundancy discount for this name. Only rendered when the pair actually
// earned a credit from the ledgers — an asserted prior says nothing worth showing, so a
// name with no measurement stays silent rather than implying a measurement happened.
function redundancyLine(sig) {
  const e = sig.evidence || {};
  if (!e.measured || !Number.isFinite(e.effectiveCount)) return '';
  const declared = e.familyCount || 1;
  const units = e.effectiveCount;
  // Only interesting when measurement DISAGREES with the declared count.
  if (units >= declared - 0.01) return '';
  const discounted = (e.credits || []).filter(c => c.against && c.credit < 0.99);
  const detail = discounted
    .map(c => `${esc(c.source)} counts ${c.credit.toFixed(2)}× (overlaps ${esc(c.against)})`)
    .join(' · ');
  const title = `Measured from the live ledgers, not assumed: these engines overlap and their realized returns move together, so agreement between them is not ${declared} independent votes. ${detail || ''}`;
  return `<div class="td-redun" title="${esc(title)}">⚖️ worth <b>${units.toFixed(2)}</b> of ${declared} — ${detail ? esc(detail) : 'overlapping evidence, measured'}</div>`;
}

// Signal-domain breadth (#2) — how many of the 8 distinct evidence DOMAINS (price,
// volume, fundamentals, news, options, insiders, sentiment, regime) corroborate the
// name. Broader than the family count: a real edge shows up in more than one domain.
function breadthChip(sig) {
  const b = sig.breadth;
  if (!b || !b.of) return '';
  const lit = (b.lit || []).map(d => (b.domains.find(x => x.key === d) || {}).label || d).join(', ');
  const cls = b.litCount >= 3 ? 'br-wide' : b.litCount === 2 ? 'br-ok' : 'br-thin';
  return `<span class="td-breadth ${cls}" title="Signal-domain breadth — ${b.litCount} of ${b.of} evidence domains lit${lit ? `: ${esc(lit)}` : ''}. One domain = a single kind of evidence, not confirmation.">🌐 ${b.litCount}/${b.of} domains</span>`;
}

// Track-record line — validated expectancy from the live Scoreboard (#4/#5). Only
// shown when the name's section:tier has a real sample; otherwise says "building".
function trackLine(sig) {
  const x = sig.expectancy;
  // Honest empty state — never invent a number when the sample is inadequate (#3).
  if (!x || !x.known || !x.n) return `<span class="td-dim td-track">📊 no track record yet — insufficient data</span>`;
  const col = (x.avgExcess ?? 0) >= 0 ? 'td-pos' : 'td-neg';
  // Evidence-based metrics shown SEPARATELY (#3): success rate · mean-vs-market · median · sample.
  const parts = [];
  if (x.winRate != null) parts.push(`${x.winRate}% win`);
  if (x.avgExcess != null) parts.push(`${pct(x.avgExcess)} vs mkt`);
  if (x.median != null) parts.push(`med ${pct(x.median)}`);
  parts.push(`n=${x.n}`);
  const ci = x.ci ? `<span class="td-ci" title="90% confidence interval on the mean forward return — if it straddles 0, the average isn't distinguishable from zero at this sample.">CI [${pct(x.ci.lo)}, ${pct(x.ci.hi)}]</span>` : '';
  return `<span class="td-track ${col}" title="Realized forward return of this signal class at its ${esc(x.horizonKey || '')} horizon, vs SPY (n=${x.n})">📊 ${esc(parts.join(' · '))}</span>${ci}`;
}
// Model/scoring version chip (#3) — the reader can see WHICH model version produced this,
// so track records are never silently blended across versions.
function versionChip(sig) {
  const v = sig.scoringVersion || sig.schemaVersion;
  if (!v) return '';
  return `<span class="td-ver" title="Model / scoring version that produced this signal">⚙︎ ${esc(v)}</span>`;
}

// Per-card event chip (#8): only the actionable case — a binary print inside the
// hold window — is loud (amber). Passed/scheduled stay quiet to avoid clutter.
const evWhen = ev => (Number.isFinite(ev.inDays) ? `in ${ev.inDays}d` : ev.when ? `~${String(ev.when).slice(0, 10)}` : 'soon');
function eventChip(ev) {
  if (!ev || ev.type !== 'earnings') return '';
  if (ev.kind === 'binary') return `<span class="td-evt-chip binary" title="Earnings report lands inside this trade's window — a binary gap risk. Size down or wait until after.">⚠️ ER ${esc(evWhen(ev))}</span>`;
  if (ev.kind === 'passed') return `<span class="td-evt-chip" title="Already reported — the catalyst may already be in the price.">✓ reported</span>`;
  return '';
}

// Remaining-edge line (#3) — how much of the advertised move is still ahead at the current
// price. Only shown when the model actually rated the name AND it isn't perfectly fresh
// (a fresh name has nothing to disclose; showing "0% consumed" on every card is noise).
const FRESHNESS = {
  fresh: ['🔋', 'Fresh', 're-fresh'], actionable: ['🔋', 'Actionable', 're-fresh'],
  'partially-consumed': ['🪫', 'Partly consumed', 're-part'], late: ['🪫', 'Late', 're-late'],
  expired: ['⏳', 'Edge spent', 're-late'], invalidated: ['❌', 'Invalidated', 're-late'],
  unrated: ['', '', ''], new: ['', '', ''],
};
function remainingLine(sig) {
  const r = sig.remainingEdge;
  if (!r || !r.rated) return '';
  if (r.freshness === 'fresh' && (r.consumedPct || 0) < 1) return ''; // nothing consumed → nothing to say
  const [icon, label, cls] = FRESHNESS[r.freshness] || FRESHNESS.unrated;
  if (!label) return '';
  const title = `Remaining-edge (measured from this signal's immutable origin): advertised move ${pct(r.originalEdgePct)}, ${r.consumedPct}% already realized, ~${pct(r.netRemainingPct)} net upside left to target after costs from here. A name that has run is ranked below a fresh one with the same original score.`;
  return `<div class="td-remain ${cls}" title="${esc(title)}">${icon} ${esc(label)} — `
    + `<b>${r.consumedPct}%</b> of the move used, <b>${pct(r.netRemainingPct)}</b> left`
    + (r.extensionR >= 1 ? ` <span class="td-dim">· ${r.extensionR}R past entry</span>` : '')
    + `</div>`;
}

// Adversarial failure model (#5) — a SHADOW caution. Shown only when the failure read is
// non-trivial, always labelled "shadow" so it's never mistaken for something that moved the
// rank (it didn't — the model is unvalidated). Surfaces the expected failure mode + the
// suggested size trim, so the reader sees the RISK the winner score is silent about.
function failureLine(sig) {
  const f = sig.failure;
  if (!f || f.failureProb < 0.25) return '';
  const drivers = (f.drivers || []).map(d => d.modeLabel).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(', ');
  const sizePct = Math.round((f.sizeMult ?? 1) * 100);
  const cls = f.failureProb >= 0.5 ? 're-late' : 're-part';
  const title = `Adversarial failure model (SHADOW — does NOT affect this rank): ${Math.round(f.failureProb * 100)}% failure-risk from ${esc(drivers || 'multiple flags')}. It would trim size to ${sizePct}% if it were validated. Run op=failuremodel to test whether flagged names actually underperform.`;
  return `<div class="td-remain ${cls}" title="${esc(title)}">⚠️ <b>shadow</b> failure risk ${Math.round(f.failureProb * 100)}%`
    + (drivers ? ` — ${esc(drivers)}` : '') + ` <span class="td-dim">· suggests ${sizePct}% size (not applied)</span></div>`;
}

function levels(sig) {
  const parts = [];
  if (sig.entry > 0) {
    parts.push(`<span>Entry <b>$${esc(sig.entry)}</b></span>`);
    if (sig.stop > 0) parts.push(`<span title="Invalidation — the setup is wrong if it trades through here">Stop <b>$${esc(sig.stop)}</b></span>`);
    if (sig.target > 0) parts.push(`<span>Target <b>$${esc(sig.target)}</b></span>`);
    if (sig.rr) parts.push(`<span class="td-rr">${esc(sig.rr)}:1 R:R</span>`);
  }
  // Holding period is horizon-derived, so it shows even for names without price levels
  // (answers the spec's "holding period" ask on every card).
  if (sig.holdWindow) parts.push(`<span class="td-hold" title="Expected holding period for this horizon">⏳ ${esc(sig.holdWindow)}</span>`);
  if (!parts.length) return '';
  return `<div class="td-levels">${parts.join('')}</div>`;
}

function signalCard(sig, legend) {
  const [si, slbl, scls] = STATE[sig.state] || STATE.detected;
  const exWarn = (sig.execution && sig.execution.penalties && sig.execution.penalties.length)
    ? `<span class="td-exec" title="Execution frictions penalize the rank">⚠️ ${esc(sig.execution.penalties[0])}</span>` : '';
  const tab = SRC_TAB[sig.source] || 'screener';
  return `<div class="td-card" data-go="${tab}">`
    + `<div class="td-top"><span class="td-rank">#${sig.rank}</span>`
    + `<span class="td-tk" data-live="${esc(sig.ticker)}">${esc(sig.ticker)}</span>`
    + `<span class="td-co">${esc(sig.company || sig.setup || '')}</span>`
    + `<span class="td-score" title="Composite: confidence × regime-fit × execution × validated-expectancy × independent-evidence">${sig.score}</span></div>`
    + `<div class="td-chips"><span class="td-state ${scls}">${si} ${slbl}</span>`
    + (sig.side === 'short' ? `<span class="td-short" title="A short setup — profits if it falls (favored in risk-off)">🔻 SHORT</span>` : '')
    + familyChip(sig)
    + `<span class="td-setup">${esc(sig.setup || sig.source)}</span>`
    + (sig.sector ? `<span class="td-sect">${esc(sig.sector)}</span>` : '') + gradeChip(sig) + pctileChip(sig) + versionChip(sig) + exWarn + `</div>`
    + evidenceLine(sig, legend)
    + `<div class="td-breadth-row">${breadthChip(sig)}</div>`
    + remainingLine(sig)
    + failureLine(sig)
    + levels(sig)
    + `<div class="td-foot">${trackLine(sig)}${eventChip(sig.event)}${sig.catalyst ? `<span class="td-cat" title="${esc(sig.catalyst)}">📰 catalyst</span>` : ''}</div>`
    + `</div>`;
}

function lane(title, arr, legend) {
  if (!arr || !arr.length) return '';
  return `<div class="td-lane"><div class="td-lane-h">${title} <span class="td-dim">${arr.length}</span></div>`
    + arr.slice(0, 6).map(s => `<span class="td-lane-tk" data-go="${SRC_TAB[s.source] || 'screener'}" title="${esc(s.setup || '')} · score ${s.score}">${esc(s.ticker)}</span>`).join('') + `</div>`;
}

// ── Challenger action-first section (shadow) ─────────────────────────────────
function chalNum(v, suf = '') { return (typeof v === 'number' && isFinite(v)) ? (Math.round(v * 100) / 100) + suf : '—'; }
function chalCard(d) {
  const sv = d.survival || {}; const ev = d.event || {};
  const rows = [
    ['Horizon', esc(d.horizon || '—')],
    ['Expected hold', sv.expectedSessionsToResolution != null ? sv.expectedSessionsToResolution + ' sessions' : '—'],
    ['Entry trigger', d.trigger ? esc(d.trigger) : (d.entry != null ? 'near ' + d.entry : '—')],
    ['Stop / invalidation', d.invalidation ? esc(d.invalidation) : (d.stop != null ? String(d.stop) : '—')],
    ['Target / exit', d.target != null ? String(d.target) : (sv.entryState ? esc(sv.entryState) : '—')],
    ['Setup expiry', d.expiry ? ((d.expiry.sessionsRemaining != null ? d.expiry.sessionsRemaining : '?') + ' sessions left') : '—'],
    ['Exp. net utility', chalNum(d.expectedNetUtilityPct, '%')],
    ['Uncertainty', chalNum(d.uncertainty)],
    ['Event', ev.category ? `${esc(ev.category)}${ev.score != null ? ` · surprise ${Math.round(ev.score)}` : ''}${ev.degraded ? ' (weak)' : ''}` : '—'],
    ['Primary driver', d.primaryDriver ? esc(d.primaryDriver) : '—'],
    ['Primary risk', d.primaryRisk ? esc(d.primaryRisk) : '—'],
    ['Governance', `${esc(d.governanceStatus || 'paper')} · weight 0 (shadow)`],
  ];
  const internals = `<details class="td-action-more"><summary>internals</summary><div class="td-action-int">`
    + `Residual score ${chalNum(d.residualScore)} · pctile ${chalNum(d.percentileRank)}<br>`
    + `Survival: P(target) ${chalNum(sv.pTargetBeforeStop)} · P(stop) ${chalNum(sv.pStopBeforeTarget)} · P(neither) ${chalNum(sv.pNeither)} · effN ${sv.effN ?? 0}${sv.shrunkToPrior ? ' (prior)' : ''}<br>`
    + `Entry state ${esc(sv.entryState || '—')} · edge now ${chalNum(sv.edgeNowPct, '%')} vs after-wait ${chalNum(sv.edgeAfterWaitPct, '%')} · basis ${esc(sv.basis || 'eod-next-session')}<br>`
    + `Failure prob ${chalNum(d.failureProb)} · execution ${chalNum(d.executionQuality)} · regime-fit ${chalNum(d.regimeFit)}<br>`
    + `Reasons: ${esc((d.reasons || []).join(' · '))}`
    + `</div></details>`;
  return `<div class="td-action-card ${esc(d.decision)}"><div class="td-action-tk"><b>${esc(d.ticker)}</b> <span class="td-action-dec">${esc(d.decision)}</span></div>`
    + rows.map(([k, v]) => `<div class="td-action-row"><span>${k}</span><span>${v}</span></div>`).join('') + internals + `</div>`;
}
function chalAvoid(d) { return `<div class="td-action-avoid"><b>${esc(d.ticker)}</b> <span class="td-dim">${esc((d.reasons && d.reasons[0]) || '')}</span></div>`; }
function actionSection() {
  const c = CHALLENGER;
  if (!c) return '';
  const D = c.decisions || { TRADE: [], WAIT: [], AVOID: [] };
  const nt = c.noTradeCause;
  let h = `<div class="td-action"><div class="td-action-h">🧪 Challenger decision <span class="td-dim">— an independent, shadow-only four-outcome read</span> <span class="td-action-badge">SHADOW · 0 weight · not affecting ranks</span></div>`;
  if (c.boardDecision === 'NO_TRADE') {
    h += `<div class="td-action-notrade"><b>NO-TRADE</b> — ${esc(nt ? nt.label : 'no candidate qualifies to enter now')}${nt && nt.detail ? `<div class="td-dim">${esc(nt.detail)}</div>` : ''}</div>`;
  }
  const col = (title, arr, render, empty) => `<div class="td-action-col"><div class="td-action-col-h">${title} <span class="td-dim">${arr.length}</span></div>`
    + (arr.length ? arr.map(render).join('') : `<div class="td-dim td-empty">${empty}</div>`) + `</div>`;
  h += `<div class="td-action-grid">`
    + col('✅ TRADE NOW', (D.TRADE || []).slice(0, 5), chalCard, 'None qualify to enter now.')
    + col('⏳ WAIT FOR TRIGGER', (D.WAIT || []).slice(0, 6), chalCard, 'No setups waiting on a trigger.')
    + col('⛔ AVOID', (D.AVOID || []).slice(0, 8), chalAvoid, 'Nothing flagged avoid.')
    + `</div>`;
  h += `<div class="td-dim td-action-foot">${esc(c.note || '')}</div></div>`;
  return h;
}

export function renderCommandCenter(container, p) {
  if (!container) return;
  if (!p || !p.ok) { container.innerHTML = `<div class="dt-note" style="border-left-color:var(--red)">⚠️ The command center couldn't load its signals right now — a data source may be down. Try Refresh.</div>`; return; }
  const legend = p.evidenceLegend || {};
  FAM_LEGEND = p.strategyFamilyLegend || {};
  const reg = p.regime || {};
  const regCol = reg.bearish ? 'var(--red)' : reg.riskOn ? 'var(--green)' : 'var(--amber,#f59e0b)';

  // Header: regime + leading/weakening sectors.
  const secChip = (s, dir) => `<span class="td-sec-chip ${dir}">${esc(s.name)} <b>${pct(+(+s.changePct).toFixed(1))}</b></span>`;
  let html = `<div class="td-cc">`;
  html += opportunityBanner(p.opportunity);
  html += actionSection(); // shadow challenger — first read, clearly labeled, never affects ranks below
  html += `<div class="td-head" style="border-left-color:${regCol}">`
    + `<div class="td-regime"><b>${esc(p.regime.label)}</b>${reg.breadthPct != null ? ` · breadth ${reg.breadthPct}%` : ''}${reg.condition ? ` · ${esc(reg.condition)} tape` : ''}</div>`
    + `<div class="td-sectors"><span class="td-dim">Leading</span> ${(p.sectors?.leading || []).map(s => secChip(s, 'lead')).join('')} `
    + `<span class="td-dim">Weakening</span> ${(p.sectors?.weakening || []).map(s => secChip(s, 'weak')).join('')}</div></div>`;

  // Related workspaces — Today is the single starting point; the overlapping shortlists
  // (Quick Hit / Opportunities / Edge Book / Game Plan) are one tap away as drill-downs,
  // not competing landing pages (#1 consolidation).
  html += `<div class="td-related"><span class="td-dim">Also explore:</span>`
    + [['quickhit', '⚡ Quick Hit'], ['opportunities', '⭐ Opportunities'], ['edge', '📓 Edge Book'], ['gameplan', '🗞️ Game Plan']]
      .map(([t, l]) => `<button class="td-rel" data-go="${t}">${l}</button>`).join('') + `</div>`;

  // THE shortlist (#1b): one ranked top 5–10 across every screener and horizon, so the
  // reader gets a single actionable list before drilling into the horizon buckets below.
  const top = (p.top || []).slice(0, 10);
  if (top.length) {
    html += `<div class="td-top-plays"><div class="td-hz-h">⭐ Top ${top.length} plays `
      + `<span class="td-dim">the single ranked shortlist across every screener &amp; horizon</span></div>`
      + `<div class="td-top-grid">` + top.map(s => signalCard(s, legend)).join('') + `</div></div>`;
  }

  // Top-3 per horizon (#2 — never mixed).
  html += `<div class="td-horizons">`;
  for (const [key, title, sub] of HORIZONS) {
    const list = (p.horizons && p.horizons[key]) || [];
    html += `<div class="td-hz"><div class="td-hz-h">${title} <span class="td-dim">${esc(sub)}</span></div>`;
    html += list.length ? list.slice(0, 4).map(s => signalCard(s, legend)).join('')
      : `<div class="td-dim td-empty">No qualifying ${key} setups today.</div>`;
    html += `</div>`;
  }
  html += `</div>`;

  // Movement lanes (#10) — populated once yesterday's snapshot exists.
  const L = p.lanes || {};
  const laneHtml = lane('🆕 New', L.new, legend) + lane('⬆️ Upgraded', L.upgraded, legend)
    + lane('⬇️ Downgraded', L.downgraded, legend) + lane('🏁 Resolved', L.resolved, legend)
    + lane('❌ Failed', L.failed, legend) + lane('⏰ Expired', L.expired, legend);
  if (laneHtml) html += `<div class="td-lanes"><div class="td-lanes-h">Since yesterday</div>${laneHtml}</div>`;

  // Upcoming risk events (#8).
  if (p.events && p.events.length) {
    const evLabel = e => e.type === 'earnings'
      ? (e.kind === 'binary' ? `⚠️ ${esc(e.ticker)} earnings ${esc(evWhen(e))}` : e.kind === 'passed' ? `✓ ${esc(e.ticker)} reported` : `📅 ${esc(e.ticker)} earnings ${esc(evWhen(e))}`)
      : `${esc(e.ticker)}: ${esc(e.type)}`;
    html += `<div class="td-events"><div class="td-lanes-h">⚠️ Upcoming events <span class="td-dim">— a print inside a trade's window is a binary gap risk</span></div>`
      + p.events.slice(0, 10).map(e => `<span class="td-evt ${e.kind === 'binary' ? 'binary' : ''}" title="${esc(e.when ? String(e.when).slice(0, 10) : e.kind || '')}">${evLabel(e)}</span>`).join('') + `</div>`;
  }

  // Freshness / system health (#10/#11) — error ≠ empty.
  const fr = p.freshness || {};
  if (fr.warnings && fr.warnings.length) html += `<div class="dt-note" style="border-left-color:var(--amber,#f59e0b)">🔧 ${esc(fr.warnings.join(' · '))}</div>`;
  html += redundancyPanel(p.redundancy);
  html += dataTrustPanel(fr);
  html += `<div class="td-dim td-cc-foot">One ranked table across ${p.counts?.signals ?? 0} signals — ranked by validated track record × confidence × regime-fit × execution × <b>independent evidence</b> (not a sum of screener scores). Leads, not advice; always confirm and use a stop.</div>`;
  html += `</div>`;
  container.innerHTML = html;
  const redunBtn = container.querySelector('[data-redun-load]');
  if (redunBtn) redunBtn.addEventListener('click', async () => {
    const host = container.querySelector('[data-redun-pairs]');
    host.innerHTML = `<div class="td-dim">Measuring overlap and return correlation across the ledgers…</div>`;
    try {
      const m = await fetch('/api/tracker?op=redundancy').then(r => r.json());
      renderPairs(host, m);
    } catch {
      host.innerHTML = `<div class="td-dim">Couldn't load the pair matrix right now — the ranking is unaffected.</div>`;
    }
  });
  container.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-live]') && ev.target.hasAttribute('data-live')) return;
    if (typeof window.showTab === 'function') window.showTab(b.dataset.go);
  }));
}

// Data-trust panel — per-source feed + freshness, plus the fact/feature/AI/unknown
// legend. Collapsed by default so it informs without cluttering the daily read.
function dataTrustPanel(fr) {
  const sources = fr.sources || [];
  if (!sources.length && !(fr.legend || []).length) return '';
  const rows = sources.map(s => {
    const dot = !s.ok ? '🔴' : s.stale ? '🟠' : '🟢';
    const age = s.ageHours == null ? 'age unknown' : s.ageHours < 1 ? '<1h old' : `${Math.round(s.ageHours)}h old`;
    const status = !s.ok ? 'unavailable' : `${age} · ${s.delayed ? 'delayed' : 'real-time'}`;
    return `<div class="dt-src"><span>${dot} <b>${esc(s.label || s.source)}</b></span><span class="td-dim">${esc((s.feed || []).join(', '))}</span><span class="dt-src-st ${s.stale ? 'stale' : ''}">${esc(status)}</span></div>`;
  }).join('');
  const legend = (fr.legend || []).map(l => `<div class="dt-leg"><span>${l.icon} <b>${esc(l.label)}</b></span> <span class="td-dim">${esc(l.basis)}</span></div>`).join('');
  return `<details class="dt-trust"><summary>🔎 Data trust — sources, freshness &amp; what's fact vs interpretation${fr.dataVersion ? ` · ${esc(fr.dataVersion)}` : ''}</summary>
    <div class="dt-trust-body">
      <div class="dt-trust-note">This is an <b>end-of-day dashboard</b> — market data is <b>delayed</b>, not a live trading feed. Always confirm a live quote before acting.</div>
      <div class="dt-srcs">${rows}</div>
      <div class="dt-leg-h">What each output is grounded in:</div>${legend}
    </div></details>`;
}

// ── Measured-redundancy panel ────────────────────────────────────────────────
// Answers "is the evidence behind these picks actually independent, or is the board
// double-counting?" — from the ledgers, not from the hand-assigned family map. Collapsed
// by default; the full pair matrix is fetched lazily on first open (op=redundancy is a
// rate-limited heavy op, so it must never run on page load).
function redundancyPanel(r) {
  if (!r) return '';
  if (r.method !== 'measured') {
    return `<details class="td-redunp"><summary>⚖️ Evidence independence — <b>assumed</b>, not yet measured</summary>
      <div class="td-redunp-body">
        <div class="td-redunp-note">${esc(r.note || '')}</div>
        <div class="td-dim">Until a pair of algorithms has enough shared history, a second agreeing screener in the same family is charged a flat <b>${r.priorCredit}</b> — a defensible default, but an assumption. Nothing here is measured yet.</div>
      </div></details>`;
  }
  const pays = r.confirmationPays === false
    ? `<div class="td-redunp-warn">⚠️ <b>Agreement is not paying.</b> When two algorithms pick the same name it has averaged <b>${r.avgConfirmationLift}%</b> versus names only one picked — so treating agreement as confirmation has been costing, not helping.</div>`
    : r.confirmationPays === true
      ? `<div class="td-redunp-ok">✓ Co-selected names have out-performed single-selected ones by ${r.avgConfirmationLift}% on average.</div>` : '';
  const verdictLabel = { 'more-redundant-than-assumed': 'More redundant than the family map assumed', 'largely-independent': 'Largely independent', mixed: 'Mixed — wrong in both directions', insufficient: 'Not enough history yet' }[r.verdict] || esc(r.verdict);
  return `<details class="td-redunp" data-redun><summary>⚖️ Evidence independence — <b>measured</b> from ${r.measurablePairs}/${r.totalPairs} algorithm pairs</summary>
    <div class="td-redunp-body">
      <div class="td-redunp-note"><b>${esc(verdictLabel)}.</b> How much a <i>second</i> agreeing screener is really worth is earned from the ledgers here — overlap in the names they pick, plus how much their realized returns move together — instead of being assumed at a flat ${r.priorCredit}.</div>
      ${pays}
      <div class="td-redunp-grid">
        <div><span class="td-dim">Avg measured credit</span><b>${r.avgMeasuredCredit ?? '—'}</b></div>
        <div><span class="td-dim">Static assumption</span><b>${r.priorCredit}</b></div>
        <div><span class="td-dim">Pairs measured</span><b>${r.measurablePairs}/${r.totalPairs}</b></div>
        <div><span class="td-dim">Model</span><b>${esc(r.version || '')}</b></div>
      </div>
      <div class="td-redunp-pairs" data-redun-pairs><button class="td-redunp-btn" data-redun-load>Show the pair-by-pair matrix</button></div>
      <div class="td-dim td-redunp-foot">A credit of 1.00 = fully independent evidence. 0.30 = the old flat assumption. Below that = the two engines are close to the same signal, so their agreement is mostly double-counting.${r.asOf ? ` Measured ${esc(String(r.asOf).slice(0, 10))}.` : ''}</div>
    </div></details>`;
}

// Render the fetched pair matrix. Kept dumb: the route already decided measured vs prior.
function renderPairs(host, m) {
  const pairs = (m && m.pairs) || [];
  if (!pairs.length) { host.innerHTML = `<div class="td-dim">No algorithm pairs with shared history yet.</div>`; return; }
  const cov = m.coverage || {};
  const rows = pairs.slice().sort((a, b) => (a.credit ?? 1) - (b.credit ?? 1)).map(p => {
    const measured = p.method === 'measured';
    const cls = !measured ? 'pr-prior' : p.credit < 0.5 ? 'pr-dupe' : p.credit < 0.85 ? 'pr-part' : 'pr-indep';
    const verdict = !measured ? 'assumed' : p.credit < 0.5 ? 'near-duplicate' : p.credit < 0.85 ? 'partly redundant' : 'independent';
    const drift = measured && Math.abs(p.credit - p.priorCredit) >= 0.2
      ? `<span class="td-redunp-drift" title="The static family map assumed ${p.priorCredit}; the ledgers say ${p.credit}.">map said ${p.priorCredit}</span>` : '';
    return `<tr class="${cls}">
      <td>${esc(p.a)} × ${esc(p.b)}</td>
      <td>${p.overlapRate == null ? '—' : (p.overlapRate * 100).toFixed(0) + '%'}</td>
      <td>${p.returnCorr == null ? '—' : p.returnCorr.toFixed(2)}</td>
      <td><b>${p.credit == null ? '—' : p.credit.toFixed(2)}</b> ${drift}</td>
      <td class="td-dim">${verdict}</td></tr>`;
  }).join('');
  host.innerHTML = `<table class="td-redunp-tbl">
    <thead><tr><th>Algorithm pair</th><th title="How often they pick the same name on the same day">Overlap</th><th title="How much their realized excess returns move together">Return corr</th><th title="What the 2nd one's agreement is worth (1.00 = fully independent)">Credit</th><th>Read</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="td-dim td-redunp-cov">${cov.resolved ?? 0} resolved picks across ${cov.tickers ?? 0} tickers${cov.span ? `, ${esc(cov.span.from)} → ${esc(cov.span.to)}` : ''}. Pairs below the sample gate show the assumed prior.</div>`;
}

const TODAY_CACHE_KEY = 'today.cc.v1';

// Rebuild the evidence-grade map from an op=maturity payload.
function applyGrades(mat) {
  GRADES = {};
  if (mat && mat.strategies) mat.strategies.forEach(s => {
    if (s.section) GRADES[s.section] = { grade: s.grade, icon: (mat.gradeMeta[s.grade] || {}).icon || '', label: (mat.gradeMeta[s.grade] || {}).label || s.grade, blurb: (mat.gradeMeta[s.grade] || {}).blurb };
  });
}

// A subtle "refreshing…" hint shown over a stale (cached) render until the fresh data lands.
function markUpdating(container, on) {
  const cc = container.querySelector('.td-cc');
  if (!cc) return;
  let n = cc.querySelector('.td-refreshing');
  if (on) { if (!n) { n = document.createElement('div'); n.className = 'td-refreshing'; n.textContent = '🔄 Showing your last scan — refreshing with the latest…'; cc.prepend(n); } }
  else if (n) n.remove();
}

export async function loadCommandCenter(container) {
  if (!container) return null;
  // 1) INSTANT PAINT from the last cached payload so there's no long blank spinner while
  //    op=today (which self-fetches 12 sources) computes on a cold hit. Flagged "refreshing".
  let painted = false;
  try {
    const c = JSON.parse(localStorage.getItem(TODAY_CACHE_KEY) || 'null');
    if (c && c.p && c.p.ok) { applyGrades(c.mat); applyChallenger(c.chal); renderCommandCenter(container, c.p); markUpdating(container, true); painted = true; }
  } catch { /* corrupt cache → ignore */ }
  if (!painted) container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Ranking every screener into one table…</p></div>`;

  // 2) Fetch fresh in the background; swap in when it arrives.
  let p = null, mat = null, chal = null;
  try { [p, mat, chal] = await Promise.all([
    fetch('/api/tracker?op=today').then(r => r.json()),
    fetch('/api/tracker?op=maturity').then(r => r.json()).catch(() => null),
    fetch('/api/tracker?op=challenger').then(r => r.json()).catch(() => null), // shadow — optional
  ]); } catch { p = null; }

  if (p && p.ok) {
    applyGrades(mat);
    applyChallenger(chal);
    try { localStorage.setItem(TODAY_CACHE_KEY, JSON.stringify({ p, mat, chal, at: Date.now() })); } catch { /* quota → skip caching */ }
    renderCommandCenter(container, p);          // replace stale with fresh
  } else if (!painted) {
    renderCommandCenter(container, p);          // nothing cached → show the empty/error state
  } else {
    markUpdating(container, false);             // fresh fetch failed but stale is shown → keep it, drop the hint
  }
  return p;
}
