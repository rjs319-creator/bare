// IGNITION LIVE — Day Trade family sub-tab. RENDER ONLY: every score, stage, alert and
// do-not-chase level was computed and persisted server-side by the privileged tick; this
// module never scores, never reorders beyond the user's chosen sort, and never invents a
// field the snapshot did not carry.
//
// Data: GET /api/tracker?op=ignitionlive (latest persisted snapshot, ≤ ~10 min old
// in-session), and per-ticker timelines from op=ignitionreplay&date=&ticker=.
import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS } from './fetch-json.js';

const STATE = { data: null, sortKey: 'opportunityScore', timelines: {} };

const STAGE_COLOR = {
  DORMANT: '#64748b', EARLY_IGNITION: '#0ea5e9', CONFIRMING: '#22c55e', BREAKOUT: '#16a34a',
  EXPANSION: '#84cc16', PARABOLIC: '#f97316', EXHAUSTION: '#ef4444', FAILED: '#991b1b',
};
const EXT_COLOR = { NORMAL: '#22c55e', CAUTION: '#eab308', DO_NOT_INITIATE: '#f97316', PARABOLIC_EXIT_BIAS: '#ef4444', UNKNOWN: '#64748b' };

const SORTS = [
  ['opportunityScore', 'Opportunity'],
  ['ignitionScore', 'Ignition'],
  ['attentionVelocity', 'Attention Δ'],
  ['relativeVolume', 'RVOL'],
  ['dollarVolumeAcceleration', '$Vol accel'],
  ['floatTurnover', 'Float turns'],
  ['dayChangePct', '% Change'],
];

const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const money = v => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const chip = (txt, color) => `<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:.72rem;font-weight:600;background:${color}22;color:${color}">${esc(txt)}</span>`;

function sortVal(v, key) {
  if (key === 'attentionVelocity') return v.attention && Number.isFinite(v.attention.velocity) ? v.attention.velocity : -1e9;
  const x = v[key];
  return Number.isFinite(x) ? x : -1e9;
}

// silent=true is the auto-refresh path: keep the current board until new data arrives, and
// never replace it with an error box on a failed poll — the next poll retries.
export async function loadIgnitionLive(container, { silent = false } = {}) {
  if (!container) return;
  if (!silent) container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Loading the latest IGNITION snapshot…</p></div>';
  try {
    const d = await fetchJSON('/api/tracker?op=ignitionlive', { timeoutMs: HEAVY_TIMEOUT_MS });
    STATE.data = d;
    render(container);
  } catch (e) {
    if (!silent) container.innerHTML = `<div class="mom-status"><p>IGNITION unavailable: ${esc(String((e && e.message) || e))}</p></div>`;
  }
  const t = document.getElementById('ignitionlive-gen-time');
  if (t && STATE.data && STATE.data.snapshotGeneratedAt) t.textContent = `snapshot ${new Date(STATE.data.snapshotGeneratedAt).toLocaleTimeString()}`;
}

function render(container) {
  const d = STATE.data;
  if (!d || d.ok === false) {
    container.innerHTML = `<div class="mom-status"><p>${esc((d && d.error) || 'No data.')}</p></div>`;
    return;
  }
  const views = Array.isArray(d.views) ? [...d.views] : [];
  views.sort((a, b) => sortVal(b, STATE.sortKey) - sortVal(a, STATE.sortKey));

  const banner = `<div class="fade-caveats" style="margin-bottom:10px">
    <b>Default sort: Opportunity Score — deliberately not % gain.</b> Ignition measures how abnormal the momentum event is;
    Opportunity measures whether the CURRENT price is a defensible entry. A 97-ignition name that has gone parabolic ranks
    below an 85 with a clean setup. Scores are RULE_BASED_ESTIMATEs (pre-registered weights, not probabilities, no edge claimed).
    Bars are 5-minute; the board refreshes from a ~10-minute scheduled tick${d.snapshotStale ? ' — <b>this snapshot is stale</b>' : ''}.
    ${Number.isFinite(d.snapshotAgeMinutes) ? `Snapshot age: ${d.snapshotAgeMinutes} min.` : ''}</div>`;

  if (!views.length) {
    container.innerHTML = banner + `<div class="mom-status"><p>${esc(d.emptyMessage || 'No candidates in the latest snapshot. The system is permitted to say there is nothing.')}</p></div>`;
    return;
  }

  const sortBtns = `<div style="margin:6px 0 10px;display:flex;gap:6px;flex-wrap:wrap">${SORTS.map(([k, label]) =>
    `<button class="bt-view-btn${k === STATE.sortKey ? ' active' : ''}" data-igsort="${k}">${label}</button>`).join('')}</div>`;

  const alerts = (d.alerts || []).length
    ? `<div class="rot-panel" style="margin-bottom:10px"><b>🔔 Alerts this tick:</b> ${d.alerts.map(a => `${chip(a.state, STAGE_COLOR[a.stage] || '#0ea5e9')} <b>${esc(a.ticker)}</b> ${esc(a.message)}`).join('<br>')}</div>`
    : '';

  const head = `<tr>
    <th></th><th>Ticker</th><th>Price</th><th>%Chg</th><th>Opp</th><th>Ign</th><th>Stage</th>
    <th>Ext</th><th>RVOL</th><th>VolAcc</th><th>$VolAcc</th><th>Float</th><th>Turns</th>
    <th>Cat</th><th>Attn</th><th>Dilution</th><th>Setup</th><th>Trigger</th><th>No-chase ></th></tr>`;

  // Every view in the snapshot renders — blocked/stale names carry capped scores and sort
  // to the tail, but a threshold never removes a row from the board.
  const rows = views.map(v => {
    const attn = v.attention || {};
    const attnTxt = Number.isFinite(attn.rankNow)
      ? (Number.isFinite(attn.rank20mAgo) ? `#${attn.rank20mAgo}→#${attn.rankNow}` : `#${attn.rankNow}`) + (attn.surge ? ' 🚀' : '')
      : '—';
    const dil = v.dilution || {};
    const floatM = Number.isFinite(v.floatShares) ? (v.floatShares / 1e6).toFixed(1) + 'M' : 'UNK';
    return `<tr data-igtk="${esc(v.ticker)}" style="cursor:pointer">
      <td>▸</td>
      <td><b>${esc(v.ticker)}</b></td>
      <td>${money(v.price)}</td>
      <td>${num(v.dayChangePct)}%</td>
      <td><b>${v.opportunityScore ?? '—'}</b></td>
      <td>${v.ignitionScore ?? '—'}</td>
      <td>${chip(v.stage || '—', STAGE_COLOR[v.stage] || '#64748b')}</td>
      <td>${chip(`${v.extensionRisk ?? '?'} ${v.extensionLabel || ''}`.trim(), EXT_COLOR[v.extensionLabel] || '#64748b')}</td>
      <td>${num(v.relativeVolume)}×</td>
      <td>${num(v.fiveMinVolumeAcceleration)}×</td>
      <td>${num(v.dollarVolumeAcceleration)}×</td>
      <td>${esc(floatM)}</td>
      <td>${num(v.floatTurnover, 2)}</td>
      <td>${v.catalystGrade ? chip(v.catalystGrade, v.catalystGrade === 'A' ? '#22c55e' : v.catalystGrade === 'B' ? '#84cc16' : '#94a3b8') : '—'}</td>
      <td>${esc(attnTxt)}</td>
      <td>${chip(dil.label || 'UNKNOWN', dil.label === 'EXTREME' ? '#ef4444' : dil.label === 'HIGH' ? '#f97316' : dil.label === 'MODERATE' ? '#eab308' : dil.label === 'LOW' ? '#22c55e' : '#64748b')}</td>
      <td>${esc(v.setup || '—')}</td>
      <td>${money(v.trigger)}</td>
      <td>${money(v.doNotChasePrice)}</td>
    </tr>
    <tr class="ig-why" data-igwhy="${esc(v.ticker)}" style="display:none"><td colspan="19">${whyPanel(v)}</td></tr>`;
  }).join('');

  container.innerHTML = banner + alerts + sortBtns
    + `<div style="overflow-x:auto"><table class="bio-table" style="width:100%;font-size:.78rem">${head}${rows}</table></div>`
    + `<div class="fade-caveats" style="margin-top:8px">No halt/LULD feed (halt status UNKNOWN) · no NBBO (check spreads manually on thin names) ·
       float UNKNOWN earns zero supply credit · dilution UNKNOWN ≠ safe · everything actionable is PAPER only.</div>`;
  wire(container);
}

function whyPanel(v) {
  const why = (v.whyNow || []).map(w => `<div>✓ ${esc(w)}</div>`).join('') || '<div>—</div>';
  const risks = (v.risks || []).map(r => `<div>⚠ ${esc(r)}</div>`).join('') || '<div>—</div>';
  const comp = v.ignitionComponents
    ? Object.entries(v.ignitionComponents).map(([k, p]) => `${esc(k.toLowerCase().replace(/_/g, ' '))} ${p}`).join(' · ')
    : '';
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:8px 4px">
    <div><b>WHY NOW</b>${why}</div>
    <div><b>RISKS</b>${risks}</div>
    <div><b>PLAN</b>
      <div>Setup: ${esc(v.setup || '—')} · Trigger ${money(v.trigger)} · Invalidation ${money(v.invalidation)} · R:R ${num(v.riskReward)}</div>
      <div><b>DO NOT CHASE above ${money(v.doNotChasePrice)}</b> — wait for a pullback, new base or VWAP reclaim.</div>
      <div>Supply pressure ${v.supplyPressureScore ?? '—'}/100 · turnover velocity ${v.floatTurnoverVelocityPerMin ?? '—'}/min</div>
      <div>Data: ${esc(v.dataQuality ? `${v.dataQuality.quality} (${v.dataQuality.feed})` : '—')} · ${esc(v.haltStatus || '')}</div>
    </div>
    <div><b>SCORE COMPONENTS</b><div style="font-size:.72rem;color:#64748b">${esc(comp)}</div>
      <div id="ig-tl-${esc(v.ticker)}" style="margin-top:6px"><button class="bt-view-btn" data-igtl="${esc(v.ticker)}">Load move timeline</button></div>
    </div>
  </div>`;
}

function wire(container) {
  container.querySelectorAll('[data-igsort]').forEach(b => b.addEventListener('click', () => {
    STATE.sortKey = b.getAttribute('data-igsort');
    render(container);
  }));
  container.querySelectorAll('[data-igtk]').forEach(row => row.addEventListener('click', () => {
    const t = row.getAttribute('data-igtk');
    const why = container.querySelector(`[data-igwhy="${t}"]`);
    if (why) why.style.display = why.style.display === 'none' ? '' : 'none';
  }));
  container.querySelectorAll('[data-igtl]').forEach(b => b.addEventListener('click', async ev => {
    ev.stopPropagation();
    const t = b.getAttribute('data-igtl');
    const box = document.getElementById(`ig-tl-${t}`);
    if (!box) return;
    box.innerHTML = 'Loading timeline…';
    try {
      const date = (STATE.data && STATE.data.sessionDate) || new Date().toISOString().slice(0, 10);
      const d = STATE.timelines[t] || await fetchJSON(`/api/tracker?op=ignitionreplay&date=${date}&ticker=${encodeURIComponent(t)}`, { timeoutMs: HEAVY_TIMEOUT_MS });
      STATE.timelines[t] = d;
      const frames = (d.frames || []).filter(f => (f.views || []).length || (f.alerts || []).length);
      if (!frames.length) { box.innerHTML = 'No recorded frames for this name today.'; return; }
      box.innerHTML = '<b>MOVE TIMELINE</b>' + frames.map(f => {
        const v = (f.views || [])[0];
        const al = (f.alerts || []).map(a => ` 🔔${esc(a.state)}`).join('');
        const time = new Date(f.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return v
          ? `<div style="font-size:.75rem">${time} · ${esc(v.stage)} · Ign ${v.ignitionScore} · Opp ${v.opportunityScore} · ${money(v.price)}${al}</div>`
          : `<div style="font-size:.75rem">${time} ·${al}</div>`;
      }).join('');
    } catch (e) { box.innerHTML = `Timeline unavailable: ${esc(String((e && e.message) || e))}`; }
  }));
}
