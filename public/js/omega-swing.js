// OMEGA-SWING — frontend view (ES module, like ignition.js / evolve.js). Renders the op=omega
// payload as tiered RESEARCH CANDIDATES (shadow: NOT buy signals) with each name's 5–10 day
// continuation read, EXECUTABLE next-session entry plan, and invalidation. Server-authoritative.
//
// HONESTY (v2): OMEGA is a SHADOW strategy (weight-0). Probabilities are an UNCALIBRATED
// baseline, so we show qualitative evidence BANDS, never percentages, and never a "model
// confidence" number. Entries are next-session (T+1 open / conditional trigger) — the signal
// close is not tradeable. Sizes are capped, educational estimates. The evidence status sits
// right next to the action, not hidden at the bottom.

import { esc } from './format.js';

// Executable states (from lib/omega-execution) → plain-language action.
const STATE_LABEL = {
  ELIGIBLE_NEXT_OPEN: '🟢 Eligible next open', BUY_ABOVE: '⬆️ Buy only above trigger',
  BUY_ON_PULLBACK: '↩️ Buy only on pullback', WAIT_CONFIRMATION: '⏳ Wait for close confirmation',
  GAP_TOO_LARGE_SKIP: '⛔ Opening gap too large — skip', NO_POSITIVE_UTILITY: '⛔ Past positive utility',
  FILLED: '🟢 Eligible next open', NO_FILL: '👁 No trigger yet', AVOID: '🚫 Avoid',
};
// Shadow research tiers — NOT "Prime / positive edge / buy". These are ranked research candidates.
const TIER_ORDER = [
  ['OMEGA_PRIME', '💠 High-ranked research candidate', 'Top-ranked on 5–10d continuation with a clean executable entry — a research candidate, not a buy signal.'],
  ['OMEGA_QUALIFIED', '🟢 Conditional candidate', 'Ranks well with acceptable risk, but lower conviction or setup quality.'],
  ['OMEGA_WATCH', '👁 Watch', 'Strong stock waiting for a breakout, pullback, or confirmation.'],
];
const BAND_LABEL = { favorable: 'Favorable', 'lean-favorable': 'Lean favorable', neutral: 'Neutral', unfavorable: 'Unfavorable', unknown: '—' };

export async function loadOmega(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scoring 5–10 day continuation candidates…</p></div>`;
  try {
    const om = await fetch('/api/tracker?op=omega').then(r => r.json()).catch(() => null);
    renderOmega(container, om);
  } catch { container.innerHTML = `<div class="mom-status error"><p>Could not load OMEGA-SWING.</p></div>`; }
}

function renderOmega(container, om) {
  if (!om || !om.ok) { container.innerHTML = `<div class="mom-status error"><p>OMEGA-SWING is unavailable right now.</p></div>`; return; }
  const gt = document.getElementById('omega-gen-time');
  if (gt && om.freshness && om.freshness.generatedAt) gt.textContent = new Date(om.freshness.generatedAt).toLocaleTimeString();

  if (om.degraded) { container.innerHTML = banner(om) + `<div class="om-empty">Decision engine warming up — try again shortly.</div>`; return; }
  let html = banner(om);
  if (!(om.cards || []).length) { container.innerHTML = html + `<div class="om-empty">No liquid continuation candidates cleared the scan today. Zero is a valid outcome — OMEGA-SWING does not force picks.</div>`; return; }

  for (const [tier, label, blurb] of TIER_ORDER) {
    const cards = (om.byTier && om.byTier[tier]) || [];
    html += `<div class="om-tier-head"><h3>${label} <span class="om-count">${cards.length}</span></h3><span class="om-tier-blurb">${esc(blurb)}</span></div>`;
    html += cards.length ? `<div class="om-cards">${cards.map(c => cardHtml(c)).join('')}</div>` : `<div class="om-tier-empty">None today.</div>`;
  }
  html += avoidSection(om);
  html += evidenceNote();
  container.innerHTML = html;
  container.querySelectorAll('[data-ticker]').forEach(el => el.addEventListener('click', () => {
    const t = el.getAttribute('data-ticker'); if (window.openTickerLookup) window.openTickerLookup(t);
  }));
}

function banner(om) {
  const c = om.counts || {}, r = om.regime || {};
  const shadow = om.maturity && om.maturity !== 'production';
  return `<div class="om-banner">
    <b>OMEGA-SWING — 5–10 day momentum continuation.</b> Liquid names still early-to-middle in a move, ranked by <b>expected utility</b>. Regime: <b>${esc(r.label || '—')}</b>. ${c.prime || 0} high-ranked · ${c.qualified || 0} conditional · ${c.watch || 0} watch of ${c.total || 0}.
    ${shadow ? `<div class="om-shadow">🧪 <b>SHADOW RESEARCH — weight-0.</b> ${esc(om.evidenceStatus || 'Ranked research candidates, NOT buy signals.')}</div>` : ''}
    ${researchEvidenceLine(om.researchEvidence)}
    <div class="om-note">⚠️ ${esc(om.dataNote || 'EOD/daily data — entries are next-session; probabilities are an uncalibrated baseline shown as evidence bands.')}</div>
  </div>`;
}

// Survivorship-free research verdict — the honest headline the app can stand behind. Recorded
// snapshot from the research harness (survivorship-complete master), distinct from the live feed.
function researchEvidenceLine(rv) {
  if (!rv || !rv.available) return '';
  const m = rv.metrics || {}, u = rv.universe || {};
  const noEdge = rv.verdict === 'no-edge';
  const ic = m.scoreIC_survivorshipFree, mic = m.momentumBaselineIC;
  const icTxt = (ic != null && mic != null) ? ` · score IC ${ic >= 0 ? '+' : ''}${ic.toFixed(3)} vs momentum ${mic >= 0 ? '+' : ''}${mic.toFixed(3)}` : '';
  const cls = noEdge ? 'om-research-noedge' : 'om-research-edge';
  const verdictTxt = noEdge ? 'no edge' : esc(rv.verdict);
  return `<div class="om-research ${cls}" title="${esc(rv.scope || '')}">
    🔬 <b>Survivorship-free research verdict: ${verdictTxt}.</b>
    survivorship-safe ✓ · ${rv.promotable ? 'promotable' : 'not promotable'} · ${u.delisted ?? '–'} delisted names in-panel${icTxt}.
    <span class="om-research-sub">Research-side (survivorship-complete master), distinct from the survivor-biased live feed. On current evidence there is nothing to promote.</span>
  </div>`;
}

const pct = (x, d = 1) => x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const money = (x) => x == null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(0)}M` : `$${(x / 1e3).toFixed(0)}K`;

// A probability field is shown as a PERCENT only when the calibration gate says display:true;
// otherwise a qualitative band + the honest reason. No uncalibrated number is ever a percent.
function probCell(label, assess, rawP) {
  if (assess && assess.display) return `<div class="om-stat"><span class="om-stat-l">${label}</span><span class="om-stat-v">${Math.round(rawP * 100)}%</span></div>`;
  const band = assess ? BAND_LABEL[assess.band] || '—' : '—';
  return `<div class="om-stat" title="Probability unavailable — insufficient calibration evidence (uncalibrated baseline)."><span class="om-stat-l">${label}</span><span class="om-stat-v om-band">${band}</span></div>`;
}

function cardHtml(cd, opts = {}) {
  const f = cd.features || {}, e = cd.execution || {}, rk = cd.risk || {}, sz = cd.sizing || {}, cal = cd.calibration || {};
  const dayCls = (cd.changePct ?? 0) >= 0 ? 'om-pos' : 'om-neg';
  const stage = cd.stageMeta || {};
  const stat = (label, val, cls = '') => `<div class="om-stat"><span class="om-stat-l">${label}</span><span class="om-stat-v ${cls}">${val}</span></div>`;
  const state = e.executableState || (cd.entry && cd.entry.classification) || 'AVOID';
  return `<div class="om-card om-${cd.tier}${cd.funnelDisplaced ? ' om-carried' : ''}">
    <div class="om-card-top">
      <div class="om-id" data-ticker="${esc(cd.ticker)}" role="button">
        <b class="om-tk">${esc(cd.ticker)}</b>
        <span class="om-co">${esc((cd.company || '').slice(0, 26))}</span>
      </div>
      <div class="om-px">$${cd.price ?? '–'} <span class="${dayCls}">${cd.changePct == null ? '' : (cd.changePct >= 0 ? '+' : '') + cd.changePct + '%'}</span></div>
      <div class="om-score" title="OMEGA-SWING rank score 0–100 (interpretable baseline)">${cd.score}</div>
    </div>
    ${opts.transition || ''}
    <div class="om-action"><b>${STATE_LABEL[state] || state}</b>${e.maxAcceptableEntryPrice ? ` <span class="om-maxentry">· max entry $${e.maxAcceptableEntryPrice} · max gap ${Math.round((e.maxAcceptableGapPct || 0) * 100)}%</span>` : ''}</div>
    <div class="om-chips">
      <span class="om-chip om-stage">${stage.icon || ''} ${esc(cd.stage)}</span>
      ${cd.setup ? `<span class="om-chip om-setup">${esc(cd.setup)}</span>` : ''}
      ${cd.sector ? `<span class="om-chip om-sec">${esc(cd.sector)}</span>` : ''}
      ${cd.funnelDisplaced ? `<span class="om-chip om-carry" title="${esc(cd.carryReason || 'carried forward from a prior day — dropped below the top-60 shortlist')}">↩ carried-forward</span>` : ''}
      ${cd.candidateSource ? `<span class="om-chip om-src" title="Source screener + within-funnel rank">from ${esc(cd.candidateSource)} #${cd.sourceRank ?? '–'}</span>` : ''}
    </div>
    <div class="om-stats">
      ${stat('Exp 10d resid', pct(cd.pred && cd.pred.expResidual10), ((cd.pred && cd.pred.expResidual10) ?? 0) >= 0 ? 'om-pos' : 'om-neg')}
      ${probCell('P(≥3% / 10d)', cal.p3pct, cd.pred && cd.pred.p3pct)}
      ${probCell('P(≥5% / 10d)', cal.p5pct, cd.pred && cd.pred.p5pct)}
      ${stat('RS vs SPY 10d', pct(f.rsSpy10))}
      ${stat('Vol persist', f.volPersistence != null ? Math.round(f.volPersistence * 100) + '%' : '–')}
      ${stat('$ADV', money(f.dollarVol))}
    </div>
    <div class="om-plan">
      <div class="om-plan-row"><span>Entry zone</span><b>$${rk.entryZoneLow ?? '–'}–$${rk.entryZoneHigh ?? '–'}</b></div>
      <div class="om-plan-row"><span>Invalidation</span><b class="om-neg">$${rk.invalidation ?? '–'}${rk.riskPct != null ? ` (−${rk.riskPct}%)` : ''}</b></div>
      <div class="om-plan-row"><span>Targets</span><b class="om-pos">$${rk.target1 ?? '–'} → $${rk.target2 ?? '–'}${rk.rr != null ? ` · ${rk.rr}R` : ''}</b></div>
      <div class="om-plan-row"><span>Suggested size</span><b>${sz.sizePctOfEquity != null ? sz.sizePctOfEquity + `% <span class="om-sizenote">(≤${sz.maxStandalonePct}% cap · educational)</span>` : '–'}</b></div>
    </div>
    ${e.reason || (cd.entry && cd.entry.reason) ? `<div class="om-why"><b>Entry:</b> ${esc(e.reason || cd.entry.reason)}</div>` : ''}
    ${(cd.reasons || []).length ? `<ul class="om-reasons">${cd.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${cd.catalyst ? `<div class="om-cat">🗞 ${esc(cd.catalyst)}</div>` : ''}
    ${(cd.risks || []).length ? `<div class="om-risks">⚠️ ${cd.risks.map(esc).join(' · ')}</div>` : ''}
    <div class="om-foot"><span>Evidence: baseline (uncalibrated) · shadow</span><span>${esc(cd.provenance || 'prospective_live')}</span></div>
  </div>`;
}

// Derive WHY a name is now Avoid, from fields already on the card object (buildOmega /
// evaluateCandidate). Never a sell signal — these stay research candidates, shown for monitoring.
export function deriveAvoidReason(cd) {
  const f = cd.features || {};
  const risks = [...(cd.penalties || []), ...(cd.risks || [])].map(x => String(x));
  const hasRisk = (re) => risks.some(x => re.test(x));
  const out = [];
  if (cd.stage === 'FAILED' || cd.stage === 'EXHAUSTED') out.push('failed/exhausted momentum');
  if (cd.utility != null && cd.utility <= 0) out.push('negative expected utility');
  if (hasRisk(/thin liquidity/i)) out.push('liquidity too thin');
  if (hasRisk(/risk-off/i)) out.push('risk-off regime');
  if ((f.rsSpy5 != null && f.rsSpy5 < 0) || (f.rsSpy10 != null && f.rsSpy10 < 0)) out.push('lost relative strength');
  if (f.volPersistence != null && f.volPersistence < 0.4) out.push('volume persistence faded');
  if (f.extAbove20 != null && f.extAbove20 > 15) out.push('over-extended');
  if (!out.length) out.push('no longer clears the entry bar');
  return out;
}

// COLLAPSED "No Longer Actionable" section (Defect A). AVOID cards are computed and bucketed
// server-side but previously had no render path, so picks silently vanished. They are still
// research candidates (NOT sell signals): same shadow/evidence-band rendering, no percentages.
export function avoidSection(om) {
  const cards = (om.byTier && om.byTier.AVOID) || [];
  if (!cards.length) return '';
  const body = cards.map(cd => {
    const reasons = deriveAvoidReason(cd);
    const transition = `<div class="om-transition"><b>Why Avoid:</b> ${reasons.map(esc).join(' · ')}</div>`;
    return cardHtml(cd, { transition });
  }).join('');
  return `<details class="om-avoid"><summary>🚫 No Longer Actionable <span class="om-count">${cards.length}</span></summary>
    <div class="om-avoid-body">
      <p class="om-avoid-note">Names that were research candidates but no longer clear the entry bar — kept visible (not silently dropped) so the transition is monitored. These are <b>not</b> sell signals; probabilities remain uncalibrated evidence bands.</p>
      <div class="om-cards">${body}</div>
    </div>
  </details>`;
}

function evidenceNote() {
  return `<details class="om-evidence"><summary>How OMEGA-SWING is validated (and its honest limits)</summary>
    <div class="om-evidence-body">
      <p><b>Shadow, weight-0.</b> OMEGA is registered as a SHADOW strategy — it MUST NOT originate or boost a live trade. These are ranked research candidates, not buy signals, until it clears the promotion gate on purged + prospective evidence.</p>
      <p><b>Executable entries.</b> A signal computed from the daily close can't be filled at that close. Every entry is next-session: T+1 open (+ slippage), a breakout stop, or a pullback limit — and an opening gap past the point of positive utility is a skip, not a chase.</p>
      <p><b>The label is sector- and market-relative, net of costs.</b> Each pick is scored on its <i>residual</i> 5–10d return minus a weighted market + sector move, then net of a modeled round-trip cost.</p>
      <p><b>Probabilities are an uncalibrated baseline.</b> They are shown as qualitative evidence bands, never as calibrated percentages — a number would imply a calibration that does not exist yet.</p>
      <p><b>What decides if it works.</b> Run <code>op=omegawf</code> for the purged walk-forward: score→residual rank-IC, tier-payoff monotonicity, calibration, and by-regime IC — with fail-closed gates (a static-universe replay can never be promoted). Prospective picks are logged to the <b>Scoreboard</b> (OMEGA section, prospective-only) and graded against the ACTUAL logged OMEGA score.</p>
      <p><b>Honest limits.</b> EOD/daily free-tier data — no real-time quotes, spreads, or intraday fills. The app's own research found no durable regime-robust selection edge on this data; the one validated lever is standing down in risk-off. A day with zero candidates is expected and correct.</p>
    </div>
  </details>`;
}
