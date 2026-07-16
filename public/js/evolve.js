// EVOLVE — Adaptive Pre-Move Discovery Engine (frontend view). ES module (like today.js):
// app.js imports loadEvolve and drives the tab via ensureEvolve(). Server-authoritative —
// this only RENDERS the op=evolve payload (no client-side scoring, no skew).
//
// The default view is intentionally SMALL: a short ranked list per horizon (Fast / Swing /
// Position), honest about calibration, sample support, and abstention. It is allowed to
// show nothing — that is a feature, not an empty state to apologize for.

import { esc } from './format.js';
import { evidencePanelHtml, wireEvidencePanel } from './evolve-evidence.js';

const DEC_CLASS = { TRADE_CANDIDATE: 'ev-trade', PROBE: 'ev-probe', WATCH: 'ev-watch', ABSTAIN: 'ev-abstain' };
const pct = (x, d = 0) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const signed = (x, d = 1) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);

export async function loadEvolve(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Composing specialists & calibrating…</p></div>`;
  try {
    const [ev, health] = await Promise.all([
      fetch('/api/tracker?op=evolve').then(r => r.json()).catch(() => null),
      fetch('/api/tracker?op=evolvehealth').then(r => r.json()).catch(() => null),
    ]);
    renderEvolve(container, ev, health);
  } catch (e) {
    container.innerHTML = `<div class="mom-status error"><p>Could not load EVOLVE.</p></div>`;
  }
}

function renderEvolve(container, ev, health) {
  if (!ev || !ev.ok) { container.innerHTML = `<div class="mom-status error"><p>EVOLVE is unavailable right now.</p></div>`; return; }
  const gt = document.getElementById('evolve-gen-time');
  if (gt && ev.freshness && ev.freshness.generatedAt) gt.textContent = new Date(ev.freshness.generatedAt).toLocaleTimeString();

  const parts = [intro(ev), regimeStrip(ev), modelHealthStrip(ev, health)];
  const c = ev.counts || {};
  if (!c.surfaced) {
    parts.push(`<div class="ev-empty"><div class="ev-empty-icon">🤍</div><b>No candidates clear the bar today.</b>
      <p>EVOLVE only surfaces a name when a calibrated probability of a large upside move clears an honest, regime-aware guardrail. On a lot of days — especially risk-off tapes — nothing qualifies, and that is the correct answer. It checked ${c.abstained || 0} names and stood down on all of them.</p></div>`);
  } else {
    for (const h of ['fast', 'swing', 'position']) parts.push(horizonColumn(h, ev));
  }
  parts.push(abstainNote(ev), evidencePanelHtml(), disclosure(ev));
  container.innerHTML = `<div class="ev-wrap">${parts.join('')}</div>`;
  wireEvidencePanel(container);
  container.querySelectorAll('[data-ticker]').forEach(el => el.addEventListener('click', () => {
    const t = el.getAttribute('data-ticker');
    if (window.openTickerLookup) window.openTickerLookup(t); else if (window.showTab) window.showTab('today');
  }));
  container.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => window.showTab && window.showTab(b.dataset.go)));
  container.querySelectorAll('.ev-card-head').forEach(h => h.addEventListener('click', (e) => {
    if (e.target.closest('[data-ticker]')) return;
    h.parentElement.classList.toggle('ev-open');
  }));
}

function intro(ev) {
  return `<div class="ev-intro">
    <b>What this is.</b> EVOLVE doesn't invent a new alpha model — this app's own multi-year research showed the raw signals are thin and fragile. Instead it treats the app's existing engines as <b>specialists</b>, learns <b>which one works in which market regime</b> from resolved triple-barrier outcomes, and reports a <b>calibrated probability</b> that a name hits its upside barrier before its downside barrier — never a vanity 0–100 score. It abstains when the edge, sample, data, or regime don't support a call.
  </div>`;
}

function regimeStrip(ev) {
  const r = ev.regime || {};
  const label = (r.label || 'unknown').toUpperCase();
  const sup = r.support || {};
  const dims = (r.vector && r.vector.dims) || {};
  const chips = Object.entries(dims).filter(([, v]) => v && v.known)
    .slice(0, 8).map(([k, v]) => `<span class="ev-dim" title="${esc(k)}">${esc(k)} ${Math.round(v.value * 100)}</span>`).join('');
  return `<div class="ev-regime">
    <span class="ev-reg-label">Regime: <b>${esc(label)}</b></span>
    <span class="ev-reg-sup">history in this regime: ${Math.round(sup.samples || 0)} resolved</span>
    <div class="ev-dims">${chips || '<span class="ev-dim ev-dim-un">regime vector building…</span>'}</div>
  </div>`;
}

function modelHealthStrip(ev, health) {
  const m = ev.modelHealth || {};
  const cal = m.calibrated ? `calibrated (Brier ${m.calibrationError ?? '–'})` : 'not yet calibrated';
  const n = m.resolvedSamples || 0;
  let verdict = '';
  if (health && health.ok && health.rankQuality && health.rankQuality.ready) {
    const v = health.rankQuality.verdict;
    const badge = v === 'predictive' ? '🟢 predictive' : v === 'weak-positive' ? '🟡 weak-positive' : v === 'inverted' ? '🔴 inverted' : '⚪ noise';
    verdict = ` · ranking quality: <b>${badge}</b> (IC ${health.rankQuality.ic?.ic ?? '–'})`;
  }
  return `<div class="ev-health">
    <span class="ev-h-item">🎯 ${cal}</span>
    <span class="ev-h-item">📚 ${n} resolved prediction${n === 1 ? '' : 's'}</span>
    ${verdict ? `<span class="ev-h-item">${verdict}</span>` : ''}
    ${n < 20 ? `<span class="ev-h-warn">⚠ accruing — probabilities lean on conservative priors until the ledger matures</span>` : ''}
  </div>`;
}

function horizonColumn(h, ev) {
  const meta = (ev.horizonMeta && ev.horizonMeta[h]) || {};
  const cards = (ev.byHorizon && ev.byHorizon[h]) || [];
  const title = `${meta.label || h} <span class="ev-col-bar">+${Math.round((meta.up || 0) * 100)}% before −${Math.round((meta.down || 0) * 100)}% · ≤${meta.window}d</span>`;
  const body = cards.length ? cards.map(card).join('') : `<div class="ev-col-empty">No ${esc(h)} candidates clear the bar.</div>`;
  return `<div class="ev-col"><div class="ev-col-head">${title}</div>${body}</div>`;
}

function card(c) {
  const dm = c.decisionMeta || {};
  const cls = DEC_CLASS[c.decision] || '';
  const prob = c.probability != null ? `${Math.round(c.probability * 100)}%` : '–';
  const be = `${Math.round((c.breakeven || 0) * 100)}%`;
  const payoff = c.expectedPayoff != null ? signed(c.expectedPayoff) : '–';
  const specs = (c.specialistMeta || []).map(m => `<span class="ev-spec" title="${esc(m.blurb || '')}">${m.icon}</span>`).join('');
  const unc = c.uncertainty && c.uncertainty.lo != null ? `${Math.round(c.uncertainty.lo * 100)}–${Math.round(c.uncertainty.hi * 100)}%` : '–';
  const reasons = (c.reasons || []).map(r => `<li>${esc(r.text)}</li>`).join('');
  const liq = c.liquidityWarn ? `<span class="ev-liq">🟡 ${esc((c.liquidityWarn || []).join(', '))}</span>` : '';
  const plan = (c.entry != null && c.stop != null)
    ? `<div class="ev-plan">Entry <b>${fmt(c.entry)}</b> · Invalidation <b>${fmt(c.stop)}</b>${c.target != null ? ` · Target <b>${fmt(c.target)}</b>` : ''}</div>` : '';
  return `<div class="ev-card ${cls}">
    <div class="ev-card-head">
      <span class="ev-tk" data-ticker="${esc(c.ticker)}">${esc(c.ticker)}</span>
      <span class="ev-dec">${dm.icon || ''} ${esc(dm.label || c.decision)}</span>
      <span class="ev-prob" title="calibrated P(upside barrier first); breakeven ${be}">${prob}</span>
      <span class="ev-toggle">▾</span>
    </div>
    <div class="ev-card-sub">
      <span class="ev-specs">${specs}</span>
      <span class="ev-payoff" title="expected net payoff after est. costs">EV ${payoff}</span>
      <span class="ev-unc" title="uncertainty band on the probability">±${unc}</span>
      ${liq}
    </div>
    <div class="ev-card-body">
      ${c.whyNow ? `<div class="ev-why"><b>Why now:</b> ${esc(c.whyNow)}</div>` : ''}
      ${reasons ? `<div class="ev-reasons"><b>Independent reasons:</b><ul>${reasons}</ul></div>` : ''}
      ${c.primaryRisk ? `<div class="ev-risk"><b>Primary risk:</b> ${esc(c.primaryRisk)}</div>` : ''}
      ${plan}
      <div class="ev-meta-row">
        <span>Breakeven ${be}</span>
        <span>Sample n≈${Math.round((c.sampleSupport && c.sampleSupport.effN) || 0)}</span>
        ${c.sector ? `<span>${esc(c.sector)}</span>` : ''}
        <span>${esc((c.sources || []).join(', '))}</span>
        <button class="ev-open-tk" data-ticker="${esc(c.ticker)}">Open research →</button>
      </div>
    </div>
  </div>`;
}
function fmt(x) { return x == null ? '–' : '$' + (+x).toFixed(2); }

function abstainNote(ev) {
  const s = ev.abstainedSample || [];
  const c = ev.counts || {};
  if (!c.abstained) return '';
  const rows = s.map(a => `<li><b>${esc(a.ticker)}</b> — ${esc(a.reason)}</li>`).join('');
  return `<details class="ev-abstained"><summary>🚫 Stood down on ${c.abstained} name${c.abstained === 1 ? '' : 's'} today (why EVOLVE said no)</summary>
    <ul>${rows}</ul>${c.abstained > s.length ? `<div class="ev-dim-note">…and ${c.abstained - s.length} more.</div>` : ''}</details>`;
}

function disclosure(ev) {
  return `<details class="ev-disclosure"><summary>How EVOLVE works (and what it deliberately won't claim)</summary>
    <div class="ev-disc-body">
      <p><b>Triple-barrier target.</b> Instead of guessing tomorrow's direction (a coin flip), EVOLVE labels each name by whether it reaches an upside barrier <i>before</i> a downside barrier within a window — Fast +8%/−4% in 5d, Swing +15%/−7% in 21d, Position +25%/−10% in 63d. A +8/−4 barrier needs a real ~33%+ hit rate just to break even, which is why raw "win rate" alone is meaningless.</p>
      <p><b>Specialists, not a black box.</b> The app's engines (Ghost accumulation, momentum/breakout, Coil, catalyst/CERN, rotation, read-through) are the specialists. A partial-pooled meta-learner weights each by its <i>resolved</i> track record in the current regime × cap × horizon — with shrinkage so a tiny lucky sample can't dominate.</p>
      <p><b>Calibration & abstention.</b> Probabilities are calibrated against real resolved outcomes. When the edge, sample, data, or regime don't support a call, EVOLVE abstains. Longs stand down in risk-off (this app's one validated lever). <b>PROBE</b> picks are paper-only exploration, capped, and never counted as validated alpha.</p>
      <p><b>Honest limits.</b> This app's research found no durable, regime-robust standalone alpha in the reachable data. EVOLVE's value is discipline — calibration, regime-aware weighting, and knowing when to say nothing — not a promise of pre-move magic. Everything here is out-of-sample by construction and still accruing.</p>
      <p><button class="today-cta" data-go="scoreboard">See the honest Scoreboard →</button> <button class="today-cta" data-go="today">Open the unified Today view →</button></p>
    </div>
  </details>`;
}
