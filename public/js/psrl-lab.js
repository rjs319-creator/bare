// 🪜 Persistent Trends (PSRL) lab board — SHADOW, weight-0, read-only.
// Renders /api/tracker?op=psrl: ranked continuity/leadership cards with four
// arrow families + the retained episode ledger. Evidence scores only — no
// percentage-styled odds anywhere; calibration has not been earned.

import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS } from './fetch-json.js';

const ACCENT = '#ffd60a';
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '·');
const num = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '·');

const ENTRY_COLOR = {
  BUY_ZONE: 'var(--green)', BUY_ON_CONFIRMATION: 'var(--green)',
  WAIT_FOR_PULLBACK: '#ffd60a', WATCH: '#8e8e93', DEFENSIVE_WATCH: '#ff9f0a',
  DEPRIORITIZE: '#8e8e93', AVOID: 'var(--red)', INSUFFICIENT_EVIDENCE: '#8e8e93',
};
const QUADRANT_LABEL = {
  TRUE_LEADER: '⭐ True leader', DEFENSIVE_LEADER: '🛡 Defensive',
  MARKET_CARRIED_LAGGARD: '🌊 Market-carried', AVOID: '⛔ Avoid',
};

function card(title, subtitle, body) {
  return `<div style="border:1px solid #2c2c2e;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#1c1c1e">
    <div style="font-weight:600;color:${ACCENT};margin-bottom:2px">${title}</div>
    ${subtitle ? `<div style="font-size:.78em;color:#8e8e93;margin-bottom:8px">${subtitle}</div>` : ''}
    ${body}</div>`;
}

function shadowBanner(d) {
  return `<div style="border:1px dashed #48484a;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:.82em;color:#8e8e93">
    🪜 <b style="color:${ACCENT}">SHADOW — weight 0.</b> ${esc(d?.shadow?.note || 'Evidence scores only; never a buy signal.')}
    <span class="expert-only"> Engine ${esc(d?.engineVersion || '')} · as of ${esc(d?.asOf || '?')} · calibration: ${esc(d?.calibrationStatus || 'uncalibrated')} — no probabilities are displayed anywhere on this board.</span>
  </div>`;
}

function arrowCell(g) {
  const cls = (v) => (v === '↑↑' || v === '↑' ? 'color:var(--green)' : v === '↓' || v === '↓↓' ? 'color:var(--red)' : v === '⚠' ? 'color:#ff9f0a' : 'color:#8e8e93');
  const one = (label, v) => `<span title="${esc(label)}" style="${cls(v)};margin-right:6px">${esc(v || '·')}</span>`;
  return one('price trend', g?.price) + one('vs market', g?.vsMarket) + one('vs sector', g?.vsSector) + one('trajectory', g?.trajectory);
}

function boardTable(cards) {
  if (!cards?.length) return `<p style="color:#8e8e93">No scored names yet — the nightly tick has not produced a snapshot.</p>`;
  const rows = cards.map((c) => `
    <tr>
      <td>${c.rank}</td>
      <td><b>${esc(c.ticker)}</b><div style="font-size:.72em;color:#8e8e93">${esc(c.sector || '·')}</div></td>
      <td>${num(c.price, 2)}</td>
      <td style="white-space:nowrap">${arrowCell(c.glyphs)}</td>
      <td><span style="color:${ENTRY_COLOR[c.entry] || '#8e8e93'}">${esc((c.entry || '·').replaceAll('_', ' '))}</span>
        <div style="font-size:.7em;color:#8e8e93">${esc(QUADRANT_LABEL[c.quadrant] || c.quadrant || '')}</div></td>
      <td><b>${num(c.scores?.combined)}</b><div style="font-size:.7em;color:#8e8e93">T${num(c.scores?.persistentTrend)} · L${num(c.scores?.relativeLeadership)}</div></td>
      <td class="expert-only">${pct(c.ret21)} / ${pct(c.ret63)} / ${pct(c.ret126)}</td>
      <td class="expert-only">${pct(c.residual21)} / ${pct(c.residual63)}</td>
      <td class="expert-only">${num(c.continuity, 2)}</td>
      <td>${esc(c.plateauRisk || '·')}${Number.isFinite(c.jumpConcentration) ? `<div class="expert-only" style="font-size:.7em;color:#8e8e93">top1 ${pct(c.jumpConcentration, 0)}</div>` : ''}</td>
      <td class="expert-only">${num(c.extensionAtr, 1)}</td>
      <td class="expert-only">${esc(c.support || '·')}</td>
      <td style="font-size:.75em;color:#c7c7cc;max-width:260px">${esc(c.novice?.read || '')}<div style="font-size:.9em;color:#8e8e93">risk: ${esc(c.novice?.risk || '·')}</div></td>
    </tr>`).join('');
  return `<div style="overflow-x:auto"><table class="mom-table" style="font-size:.82em">
    <thead><tr><th>#</th><th>Sym</th><th>Px</th><th title="price · vs market · vs sector · trajectory">Arrows</th><th>Entry</th><th>Evidence</th>
    <th class="expert-only">21/63/126d</th><th class="expert-only">Resid 21/63</th><th class="expert-only">Cont.</th><th>Plateau</th>
    <th class="expert-only">Ext (ATR)</th><th class="expert-only">Support</th><th>Read</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <details class="expert-only" style="margin-top:8px;font-size:.75em;color:#8e8e93"><summary>🔬 Definitions</summary>
    Arrows: price trend · vs market (beta-adjusted) · vs sector · leadership trajectory. Evidence = combined score after penalties (T=trend, L=leadership components).
    Resid = beta-adjusted stock-specific relative trend (not called alpha, not a probability). Cont. = information-discreteness continuity (1 = gradual staircase).
    Plateau = jump-then-plateau risk from concentration + flat aftermath. Support grades: FULL / REDUCED (short history or missing sector) / LOW (weak beta support).</details>`;
}

function ledgerPanel(led) {
  if (!led?.available || !led.episodes?.length) return card('📒 Episode ledger', 'retained names with reasons', '<p style="color:#8e8e93">No episodes yet.</p>');
  const row = (e) => `
    <tr><td><b>${esc(e.symbol)}</b></td><td>${esc(e.status || '·')}</td><td>${esc(e.startDate || '·')}</td>
    <td>${num(e.combined)}</td><td class="expert-only">${num(e.peakScore)}</td>
    <td class="expert-only">${pct(e.mfe)} / ${pct(e.mae)}</td>
    <td>${esc((e.currentEntry || '·').replaceAll('_', ' '))}</td>
    <td style="font-size:.75em;color:#8e8e93">${esc(e.lastReason?.reason || e.terminalEvent || '·')}</td></tr>`;
  const closed = led.closed?.length ? `<div style="margin-top:10px;font-size:.78em;color:#8e8e93">Recently closed: ${led.closed.slice(0, 8).map((e) => `${esc(e.symbol)} (${esc(e.terminalEvent || '?')})`).join(' · ')}</div>` : '';
  return card('📒 Episode ledger', `retained names stay visible with the reason for every downgrade · ${led.counts?.active ?? 0} active / ${led.counts?.closed ?? 0} closed`,
    `<div style="overflow-x:auto"><table class="mom-table" style="font-size:.8em">
    <thead><tr><th>Sym</th><th>Status</th><th>Since</th><th>Score</th><th class="expert-only">Peak</th><th class="expert-only">MFE/MAE</th><th>Entry</th><th>Why / last change</th></tr></thead>
    <tbody>${led.episodes.slice(0, 30).map(row).join('')}</tbody></table></div>${closed}`);
}

export async function loadPsrlLab(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Scoring persistent trends…</p></div>`;
  let d = null;
  try {
    d = await fetchJSON(`/api/tracker?op=psrl&_cb=${Date.now()}`, { timeoutMs: HEAVY_TIMEOUT_MS });
  } catch { /* rendered below as unavailable */ }
  if (!d || d.ok === false) {
    container.innerHTML = `<p style="color:var(--red)">Persistent Trends unavailable${d?.error ? `: ${esc(d.error)}` : ''}.</p>`;
    return;
  }
  if (!d.available) {
    container.innerHTML = shadowBanner(d) + `<p style="color:#8e8e93">${esc(d.note || 'No snapshot yet.')}</p>`;
    return;
  }
  container.innerHTML = [
    shadowBanner(d),
    card('🪜 Leadership board', `staircase continuity × beta-adjusted leadership · ${d.counts?.scored ?? 0} scored of ${d.counts?.input ?? 0} scanned`, boardTable(d.cards)),
    ledgerPanel(d.ledger),
  ].join('');
}
