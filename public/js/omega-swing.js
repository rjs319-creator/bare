// OMEGA-SWING — frontend view (ES module, like ignition.js / evolve.js). Renders the
// op=omega payload as tiered candidate cards (Prime / Qualified / Watch) with each name's
// 5–10 day continuation read, entry plan, and invalidation. Server-authoritative — this only
// renders. Honest banner: EOD data, baseline probabilities until the walk-forward confirms.

import { esc } from './format.js';

const ENTRY_LABEL = {
  BUY_NOW: '🟢 Buy now', BUY_ON_BREAKOUT: '⬆️ Buy on breakout', BUY_ON_FIRST_PULLBACK: '↩️ Buy on first pullback',
  WAIT_FOR_CLOSE_CONFIRMATION: '⏳ Wait for close confirmation', WATCH: '👁 Watch', SKIP: '🚫 Skip',
};
const TIER_ORDER = [
  ['OMEGA_PRIME', '💠 OMEGA Prime', 'Positive expected utility, strong RS, persistent volume, good entry, no severe warning.'],
  ['OMEGA_QUALIFIED', '🟢 OMEGA Qualified', 'Positive expected edge with acceptable risk, but lower confidence or setup quality.'],
  ['OMEGA_WATCH', '👁 OMEGA Watch', 'Strong stock waiting for a breakout, pullback, or confirmation.'],
];

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
  const c = om.counts || {};
  let html = banner(om);
  if (!(om.cards || []).length) { container.innerHTML = html + `<div class="om-empty">No liquid continuation candidates cleared the scan today. Zero is a valid outcome — OMEGA-SWING does not force picks.</div>`; return; }

  for (const [tier, label, blurb] of TIER_ORDER) {
    const cards = (om.byTier && om.byTier[tier]) || [];
    html += `<div class="om-tier-head"><h3>${label} <span class="om-count">${cards.length}</span></h3><span class="om-tier-blurb">${esc(blurb)}</span></div>`;
    html += cards.length ? `<div class="om-cards">${cards.map(cardHtml).join('')}</div>` : `<div class="om-tier-empty">None today.</div>`;
  }
  html += evidenceNote();
  container.innerHTML = html;
  container.querySelectorAll('[data-ticker]').forEach(el => el.addEventListener('click', () => {
    const t = el.getAttribute('data-ticker'); if (window.openTickerLookup) window.openTickerLookup(t);
  }));
}

function banner(om) {
  const c = om.counts || {}, r = om.regime || {};
  return `<div class="om-banner">
    <b>OMEGA-SWING — 5–10 day momentum continuation.</b> Liquid names that already started moving but still have room to continue higher over the next 1–2 weeks — early-to-middle-stage momentum with good entry location and controlled downside, ranked by <b>expected utility</b> (not win rate). Regime: <b>${esc(r.label || '—')}</b>. ${c.prime || 0} Prime · ${c.qualified || 0} Qualified · ${c.watch || 0} Watch of ${c.total || 0}.
    <div class="om-note">⚠️ ${esc(om.dataNote || 'EOD/daily data — probabilities are a baseline until the walk-forward confirms them.')}</div>
  </div>`;
}

const pct = (x, d = 1) => x == null ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const prob = (x) => x == null ? '–' : `${Math.round(x * 100)}%`;
const money = (x) => x == null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(0)}M` : `$${(x / 1e3).toFixed(0)}K`;

function cardHtml(cd) {
  const f = cd.features || {}, p = cd.pred || {}, e = cd.entry || {}, rk = cd.risk || {};
  const dayCls = (cd.changePct ?? 0) >= 0 ? 'om-pos' : 'om-neg';
  const stage = cd.stageMeta || {};
  const conf = Math.round((p.core ?? 0.5) * 100);
  const stat = (label, val, cls = '') => `<div class="om-stat"><span class="om-stat-l">${label}</span><span class="om-stat-v ${cls}">${val}</span></div>`;
  return `<div class="om-card om-${cd.tier}">
    <div class="om-card-top">
      <div class="om-id" data-ticker="${esc(cd.ticker)}" role="button">
        <b class="om-tk">${esc(cd.ticker)}</b>
        <span class="om-co">${esc((cd.company || '').slice(0, 26))}</span>
      </div>
      <div class="om-px">$${cd.price ?? '–'} <span class="${dayCls}">${cd.changePct == null ? '' : (cd.changePct >= 0 ? '+' : '') + cd.changePct + '%'}</span></div>
      <div class="om-score" title="OMEGA-SWING score 0–100">${cd.score}</div>
    </div>
    <div class="om-chips">
      <span class="om-chip om-stage">${stage.icon || ''} ${esc(cd.stage)}</span>
      ${cd.setup ? `<span class="om-chip om-setup" title="${esc(cd.setupLegendText || '')}">${esc(cd.setup)}</span>` : ''}
      ${cd.sector ? `<span class="om-chip om-sec">${esc(cd.sector)}</span>` : ''}
      <span class="om-chip om-entry">${ENTRY_LABEL[e.classification] || e.classification || ''}</span>
    </div>
    <div class="om-stats">
      ${stat('Exp 5d resid', pct(p.expResidual5), (p.expResidual5 ?? 0) >= 0 ? 'om-pos' : 'om-neg')}
      ${stat('Exp 10d resid', pct(p.expResidual10), (p.expResidual10 ?? 0) >= 0 ? 'om-pos' : 'om-neg')}
      ${stat('P(≥3% / 10d)', prob(p.p3pct))}
      ${stat('P(≥5% / 10d)', prob(p.p5pct))}
      ${stat('Exp adverse', pct(p.expMAE), 'om-neg')}
      ${stat('RS vs SPY 10d', pct(f.rsSpy10))}
      ${stat('Vol persist', f.volPersistence != null ? Math.round(f.volPersistence * 100) + '%' : '–')}
      ${stat('$ADV', money(f.dollarVol))}
    </div>
    <div class="om-plan">
      <div class="om-plan-row"><span>Entry zone</span><b>$${rk.entryZoneLow ?? '–'}–$${rk.entryZoneHigh ?? '–'}</b></div>
      <div class="om-plan-row"><span>Invalidation</span><b class="om-neg">$${rk.invalidation ?? '–'}${rk.riskPct != null ? ` (−${rk.riskPct}%)` : ''}</b></div>
      <div class="om-plan-row"><span>Targets</span><b class="om-pos">$${rk.target1 ?? '–'} → $${rk.target2 ?? '–'}${rk.rr != null ? ` · ${rk.rr}R` : ''}</b></div>
      <div class="om-plan-row"><span>Suggested size</span><b>${rk.sizePctOfEquity != null ? rk.sizePctOfEquity + '% (1% risk)' : '–'}</b></div>
    </div>
    ${e.reason ? `<div class="om-why"><b>Entry:</b> ${esc(e.reason)}</div>` : ''}
    ${(cd.reasons || []).length ? `<ul class="om-reasons">${cd.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${cd.catalyst ? `<div class="om-cat">🗞 ${esc(cd.catalyst)}</div>` : ''}
    ${(cd.risks || []).length ? `<div class="om-risks">⚠️ ${cd.risks.map(esc).join(' · ')}</div>` : ''}
    <div class="om-foot"><span>Model confidence ${conf}%</span><span>${p.source === 'baseline' ? 'baseline prob' : 'model'}</span></div>
  </div>`;
}

function evidenceNote() {
  return `<details class="om-evidence"><summary>How OMEGA-SWING is validated (and its honest limits)</summary>
    <div class="om-evidence-body">
      <p><b>The label is sector- and market-relative.</b> Every pick is scored on its <i>residual</i> return — its 5- and 10-day move minus a weighted market + sector-ETF move — so a stock up 4% while its sector is flat ranks above one up 5% while the sector is up 7%.</p>
      <p><b>What decides if it works.</b> The interpretable 0–100 score is the shipped ranker; a trained model only overrides it after it beats the baseline out-of-sample. Run <code>op=omegawf</code> for the purged walk-forward: score→residual rank-IC, calibration, tier-conditional payoff (does Prime beat Qualified beats Watch?), and by-regime IC. Every Prime/Qualified/Watch pick is also logged to the <b>Scoreboard</b> (OMEGA section) for a live 1w/1m forward track record.</p>
      <p><b>Honest limits.</b> EOD/daily free-tier data — no real-time quotes, spreads, or intraday fills, so entry levels are next-session positioning, not live triggers. The app's own multi-session research found no durable regime-robust selection edge on this data; the one validated lever is standing down in risk-off, which OMEGA-SWING does. A day with zero Prime candidates is expected and correct — it does not force picks.</p>
    </div>
  </details>`;
}
