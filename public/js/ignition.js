// MOMENTUM IGNITION — frontend view (ES module, like evolve.js). Renders the op=ignition
// payload as one sortable, filterable, acceleration-ranked table. Server-authoritative;
// this only renders. Honest banner: EOD data, no real-time / no LULD.

import { esc } from './format.js';
import { fetchJSON } from './fetch-json.js';

const STAGE_CLASS = { Watch: 'ig-watch', Ignition: 'ig-ign', Pressure: 'ig-press', Extended: 'ig-ext' };
let STATE = { cards: [], sort: 'score', dir: -1, stage: 'all' };

export async function loadIgnition(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Ranking momentum by acceleration…</p></div>`;
  try {
    const ig = await fetchJSON('/api/tracker?op=ignition').catch(() => null);
    renderIgnition(container, ig);
  } catch { container.innerHTML = `<div class="mom-status error"><p>Could not load Momentum Ignition.</p></div>`; }
}

function renderIgnition(container, ig) {
  if (!ig || !ig.ok) { container.innerHTML = `<div class="mom-status error"><p>Momentum Ignition is unavailable right now.</p></div>`; return; }
  const gt = document.getElementById('ignition-gen-time');
  if (gt && ig.freshness && ig.freshness.generatedAt) gt.textContent = new Date(ig.freshness.generatedAt).toLocaleTimeString();
  STATE.cards = ig.cards || [];

  const c = ig.counts || {};
  const banner = `<div class="ig-banner">
    <b>Acceleration &gt; magnitude.</b> This ranks every momentum candidate by how fast price AND volume are <i>speeding up</i>, with a catalyst tag — so an early accelerating name beats one already up big and slowing. Regime: <b>${esc((ig.regime && ig.regime.label) || '—')}</b>. ${c.ignition || 0} igniting · ${c.watch || 0} watch of ${c.total || 0}.
    <div class="ig-note">⚠️ ${esc(ig.dataNote || 'EOD/daily data — no real-time or LULD halt prediction.')}</div>
  </div>`;

  if (!STATE.cards.length) {
    container.innerHTML = banner + `<div class="ig-empty">No momentum candidates cleared the scan today.</div>` + consolidation();
    return;
  }
  const filters = `<div class="ig-controls">
    <label>Stage: <select id="ig-stage">
      <option value="all">All</option>${['Ignition', 'Pressure', 'Watch', 'Extended'].map(s => `<option value="${s}"${STATE.stage === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select></label>
    <label>Sort: <select id="ig-sort">
      ${[['score', 'Ignition score'], ['priceAccel', 'Price acceleration'], ['volAccel', 'Volume acceleration'], ['relVol5', 'Relative volume'], ['changePct', 'Today %'], ['dollarVol', '$ volume']].map(([v, l]) => `<option value="${v}"${STATE.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select></label>
  </div>`;
  container.innerHTML = banner + filters + `<div class="ig-table-wrap"><table class="ig-table"><thead>${headRow()}</thead><tbody id="ig-body"></tbody></table></div>` + consolidation();
  container.querySelector('#ig-stage').addEventListener('change', e => { STATE.stage = e.target.value; paintBody(); });
  container.querySelector('#ig-sort').addEventListener('change', e => { STATE.sort = e.target.value; paintBody(); });
  paintBody();
}

function headRow() {
  const cols = ['Ticker', '%', 'Score', 'Stage', 'Catalyst', 'Age', 'Px accel', 'Vol accel', 'RVOL', '$Vol', 'VWAP', 'Range%', 'LULD'];
  return `<tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>`;
}

function paintBody() {
  const body = document.getElementById('ig-body'); if (!body) return;
  let rows = STATE.cards.slice();
  if (STATE.stage !== 'all') rows = rows.filter(r => r.stage === STATE.stage);
  const k = STATE.sort;
  rows.sort((a, b) => (b[k] ?? -1e9) - (a[k] ?? -1e9));
  body.innerHTML = rows.map(rowHtml).join('');
  body.querySelectorAll('tr[data-ticker]').forEach(tr => tr.addEventListener('click', () => {
    const t = tr.getAttribute('data-ticker');
    if (window.openTickerLookup) window.openTickerLookup(t);
  }));
}

const money = (x) => x == null ? '–' : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(0)}M` : `$${(x / 1e3).toFixed(0)}K`;
const sign = (x, s = '') => x == null ? '–' : `${x >= 0 ? '+' : ''}${x}${s}`;

function rowHtml(r) {
  const stageCls = STAGE_CLASS[r.stage] || '';
  const sm = r.stageMeta || {};
  const catText = r.catalyst || '';
  const catShort = catText.length > 34 ? catText.slice(0, 32).replace(/\s+\S*$/, '') + '…' : catText;
  const cat = r.catalyst ? `<span class="ig-cat${r.catalystFresh ? ' ig-fresh' : ''}" title="${esc(catText + ((r.reasons || []).length ? ' — ' + r.reasons.join(' · ') : ''))}">${esc(catShort)}</span>` : '<span class="ig-nocat">—</span>';
  const age = r.catalystAgeDays == null ? '—' : `${r.catalystAgeDays}d`;
  const accelCls = r.priceAccel >= 0 ? 'ig-pos' : 'ig-neg';
  return `<tr data-ticker="${esc(r.ticker)}" title="${esc((r.risks || []).join(' · '))}">
    <td class="ig-tk"><b>${esc(r.ticker)}</b></td>
    <td class="${r.changePct >= 0 ? 'ig-pos' : 'ig-neg'}">${sign(r.changePct, '%')}</td>
    <td class="ig-score">${r.score}</td>
    <td class="${stageCls}">${sm.icon || ''} ${esc(r.stage)}</td>
    <td>${cat}</td>
    <td class="ig-dim">${age}</td>
    <td class="${accelCls}">${sign(r.priceAccel)}</td>
    <td class="${r.volAccel >= 0 ? 'ig-pos' : 'ig-neg'}">${sign(r.volAccel, '%')}</td>
    <td>${r.relVol5 != null ? r.relVol5 + '×' : '–'}</td>
    <td class="ig-dim">${money(r.dollarVol)}</td>
    <td class="ig-dim">${esc(r.vwapStatus || '–')}</td>
    <td class="ig-dim">${r.spreadProxy != null ? r.spreadProxy + '%' : '–'}</td>
    <td class="ig-na" title="Distance-to-LULD needs a real-time feed the app doesn't have">n/a</td>
  </tr>`;
}

function consolidation() {
  return `<details class="ig-consol"><summary>How this consolidates the momentum scanners (and what stays separate)</summary>
    <div class="ig-consol-body">
      <p><b>What this view unifies.</b> Momentum Ignition ranks the SAME candidates the momentum scanners surface (Day Trade, Gap & Go, Momentum Run, Ghost, Breakout) by one honest measure — <b>acceleration of price and volume</b>, not raw % gain — with a catalyst tag and an ignition stage. Use it as the single momentum starting point.</p>
      <p><b>Recommended roles going forward:</b></p>
      <ul>
        <li><b>Fold in here (as filters/inputs):</b> Day Trade, Gap & Go, Momentum Run, Breakout/Emerging, Second Wave — they’re differently-tuned slices of one momentum engine; this is the merged, acceleration-ranked view.</li>
        <li><b>Keep distinct (orthogonal information):</b> 👻 Ghost (pre-move accumulation), 🧬 Coil (compression), ⚡ CERN (forced-flow events), 🧬 Biotech (catalyst-specific), 🔥 Overheated (the inverse — feeds the “Extended” penalty here).</li>
        <li><b>Meta-layers:</b> EVOLVE / Today already rank across everything; Confluence stays as an agreement filter.</li>
      </ul>
      <p><b>Honest limits.</b> EOD/daily data + a once-daily 5-min capture. It cannot see intraday ticks, compute distance to an LULD band, or predict a halt “before it happens” — that needs a paid real-time feed and an always-on market-hours worker. What it CAN do — rank early acceleration over exhausted moves — it does, and every Ignition/Watch pick is logged to the Scoreboard for an honest EOD track record.</p>
    </div>
  </details>`;
}
