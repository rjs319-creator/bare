// ⚡ GRIDLOCK — physical-constraint & marginal-beneficiary shadow board.
// Read-only view over op=gridlock: regional constraint dashboard, physical event
// ledger, ranked equity consequences, scenario panel (op=gridlockscenario) and
// relative-value research. SHADOW / weight-0 everywhere — this never implies a
// buy signal, and the honest states (loading / warming / stale / partial /
// empty / error) are first-class.
import { esc } from './format.js';

const ACCENT = '#f0b429';
const GRAY = '#8e8e93';

async function getJSON(url) {
  try { const r = await fetch(url); return await r.json(); } catch { return null; }
}

const CLS_META = {
  DIRECT_BENEFICIARY: ['Direct beneficiary', '#34c759'],
  SECOND_ORDER_BENEFICIARY: ['Second-order', '#5ac8fa'],
  EQUIPMENT_OR_CAPACITY_BENEFICIARY: ['Equipment / capacity', '#64d2ff'],
  RELATIVE_VALUE_BENEFICIARY: ['Relative value', '#ffd60a'],
  COST_HEADWIND: ['Cost headwind', '#ff9f0a'],
  MIXED_EFFECT: ['Mixed effect', GRAY],
  TOO_INDIRECT: ['Too indirect', GRAY],
  INSUFFICIENT_EVIDENCE: ['Insufficient evidence', GRAY],
};
const num = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`);

function shadowBanner(d) {
  return `<div style="border:1px solid ${ACCENT}55;border-radius:10px;padding:10px 12px;background:${ACCENT}11;font-size:.9em;color:#d1d1d6">
    <b style="color:${ACCENT}">🧪 SHADOW RESEARCH — weight-0.</b> ${esc(d.note || 'Research candidates, never buy signals. No win probability is claimed anywhere.')}
    <div style="color:${GRAY};margin-top:4px">generated ${esc(String(d.generatedAt || '').slice(0, 16).replace('T', ' '))} UTC
      ${d.stale ? ' · <b style="color:#ff9f0a">STALE — older than the refresh window</b>' : ''}
      · ${d.eventCount ?? 0} events · ${(d.candidates || []).length} classified candidates</div>
  </div>`;
}

function regionPanel(region) {
  if (!region || !region.cps) return `<div style="color:${GRAY};padding:10px">Regional constraint state unavailable.</div>`;
  const { state, cps } = region;
  const comp = cps.components || {};
  const bar = (k) => {
    const v = comp[k];
    return `<div style="display:flex;align-items:center;gap:8px;margin:2px 0;font-size:.85em">
      <span style="width:150px;color:#d1d1d6">${esc(k)}</span>
      <div style="flex:1;background:#3a3a3c;border-radius:4px;height:8px;overflow:hidden">
        ${v == null ? '' : `<div style="width:${v}%;height:100%;background:${v >= 70 ? '#ff453a' : v >= 40 ? '#ff9f0a' : '#34c759'}"></div>`}
      </div>
      <span style="width:56px;text-align:right;color:${v == null ? GRAY : '#fff'}">${v == null ? 'missing' : v}</span>
    </div>`;
  };
  const f = (k) => state && state[k] ? state[k] : { value: null };
  const lbl = (fv, suffix = '') => fv.value == null ? `<span style="color:${GRAY}">—</span>` : `${esc(String(fv.value))}${suffix} <span style="color:${GRAY};font-size:.75em">(${esc(fv.basis || '')})</span>`;
  return `<div style="border:1px solid #3a3a3c;border-radius:10px;padding:12px;margin-top:10px">
    <div style="font-weight:700;color:${ACCENT}">🗺 ${esc(cps.isoRegion)} constraint pressure:
      <span style="font-size:1.3em">${cps.total == null ? '<span style="color:#8e8e93">withheld</span>' : cps.total + '/100'}</span>
      ${cps.direction ? `<span style="color:${GRAY};font-weight:400"> · ${esc(cps.direction)} (7d ${cps.change && cps.change.d7 != null ? (cps.change.d7 >= 0 ? '+' : '') + cps.change.d7 : '—'})</span>` : ''}
      ${cps.dominantConstraint ? `<span style="color:#ffd60a;font-weight:400"> · dominant: ${esc(cps.dominantConstraint)}</span>` : ''}
    </div>
    <div style="margin-top:8px">${Object.keys(comp).map(bar).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px 14px;margin-top:8px;font-size:.82em">
      <div>Reserve-margin proxy: ${lbl(f('reserveMarginProxy'), '%')}</div>
      <div>Load surprise: ${lbl(f('forecastError'), '%')}</div>
      <div>Outage capacity: ${lbl(f('outageCapacityMW'), ' MW')}</div>
      <div>Congestion proxy: ${lbl(f('congestionProxy'), ' $/MWh')}</div>
      <div>Gas proxy: ${lbl(f('gasPriceProxy'), ' $/MMBtu')}</div>
      <div>Large-load pipeline: ${lbl(f('announcedLargeLoadMW'), ' MW')}</div>
      <div>Generation pipeline: ${lbl(f('generationPipelineMW'), ' MW')}</div>
      <div>Weather alerts: ${lbl(f('weatherDemandRisk'))}</div>
    </div>
    <div style="color:${GRAY};font-size:.8em;margin-top:6px">
      data quality: <b style="color:${state && state.dataQuality === 'good' ? '#34c759' : state && state.dataQuality === 'partial' ? '#ff9f0a' : '#ff453a'}">${esc((state && state.dataQuality) || 'unknown')}</b>
      (coverage ${state ? Math.round((state.dataCoverage || 0) * 100) : 0}%)
      ${state && state.staleFields && state.staleFields.length ? ` · missing: ${esc(state.staleFields.slice(0, 6).join(', '))}${state.staleFields.length > 6 ? '…' : ''}` : ''}
      <br>${esc(cps.explanation || '')}</div>
  </div>`;
}

function eventLedger(events) {
  if (!Array.isArray(events) || !events.length) return `<div style="color:${GRAY};padding:10px">No physical events in the ledger yet.</div>`;
  const row = (ev) => `<tr>
    <td style="max-width:340px">${esc(ev.title)}<div style="color:${GRAY};font-size:.78em">${esc(ev.eventType)} · certainty ${esc(ev.certainty)} · ${ev.independentSourceCount || 1} source${(ev.independentSourceCount || 1) > 1 ? 's' : ''}${(ev.fieldConflicts || []).length ? ` · ⚠️ ${ev.fieldConflicts.length} conflict(s)` : ''}</div></td>
    <td>${esc(ev.lifecycle)}</td>
    <td>${esc(ev.isoRegion)}${ev.state ? `<div style="color:${GRAY};font-size:.78em">${esc(ev.state)}</div>` : ''}</td>
    <td>${ev.demandDeltaMW != null ? `+${ev.demandDeltaMW} MW load` : ev.generationDeltaMW != null ? `${ev.generationDeltaMW} MW gen` : '<span style="color:#8e8e93">not grounded</span>'}</td>
    <td>${esc(String(ev.announcedAt || '').slice(0, 10))}</td>
    <td style="max-width:160px;color:${GRAY};font-size:.82em">${esc((ev.companies || []).join(', ') || '—')}</td>
  </tr>`;
  return `<div style="margin-top:14px"><div style="font-weight:700;color:${ACCENT}">📒 Physical event ledger</div>
    <div style="overflow-x:auto"><table class="sb-table" style="width:100%;font-size:.85em;margin-top:6px">
      <thead><tr><th>Event</th><th>Lifecycle</th><th>Region</th><th>Magnitude</th><th>Announced</th><th>Companies</th></tr></thead>
      <tbody>${events.slice(0, 20).map(row).join('')}</tbody></table></div></div>`;
}

function candidateCard(c) {
  const [clsLabel, clsColor] = CLS_META[c.classification] || [c.classification, GRAY];
  const s = c.score || {};
  const chain = c.causalChain;
  const t = c.timing;
  const gatePass = c.gate && c.gate.status === 'ACTIONABLE_RESEARCH';
  const scoreChip = (label, v) => `<span style="background:#2c2c2e;border-radius:6px;padding:2px 7px;margin-right:5px;font-size:.78em">${label} <b>${v == null ? '—' : v}</b></span>`;
  return `<div style="border:1px solid ${gatePass ? '#34c75966' : '#3a3a3c'};border-radius:10px;padding:11px 13px;margin-top:9px">
    <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px">
      <b style="font-size:1.1em">${esc(c.ticker)}</b>
      <span style="color:${GRAY}">${esc(c.company || '')}</span>
      <span style="color:${clsColor};font-weight:600;font-size:.85em">${esc(clsLabel)}</span>
      <span style="color:${GRAY};font-size:.8em">${esc(c.exposureRole)} · ${esc(c.verifiedOrInferred)}${c.named ? ' · named party' : ''}</span>
      <span style="margin-left:auto;font-size:.8em;color:${gatePass ? '#34c759' : '#ff9f0a'}">${gatePass ? '✅ ACTIONABLE (research)' : `⛔ ${esc((c.gate && c.gate.status) || '')}`}</span>
    </div>
    <div style="color:${GRAY};font-size:.82em;margin-top:3px">Event: ${esc(c.eventTitle || c.eventId)} · region ${esc(c.isoRegion)} · lifecycle ${esc(c.eventLifecycle || '—')}</div>
    ${!gatePass && c.gate && c.gate.reason ? `<div style="color:#ff9f0a;font-size:.82em;margin-top:3px">Gate: ${esc(c.gate.reason)}</div>` : ''}
    <div style="margin-top:6px">
      ${scoreChip('total', s.total)}${scoreChip('event', s.components && s.components.eventMagnitude)}${scoreChip('constraint', s.components && s.components.constraintPressure)}${scoreChip('exposure', s.components && s.components.exposure)}${scoreChip('timing/conf', s.components && s.components.priceVolumeConfirm)}${scoreChip('not-repriced', s.components && s.components.notYetRepriced)}
      <span style="color:${GRAY};font-size:.78em">grade ${esc(s.dataQualityGrade || '—')}${s.missing && s.missing.length ? ` · missing: ${esc(s.missing.join(', '))}` : ''}</span>
    </div>
    ${s.penalties && s.penalties.length ? `<div style="color:#ff9f0a;font-size:.8em;margin-top:3px">Penalties (−${s.penaltyPoints}): ${esc(s.penalties.map(p => p.note).join(' · '))}</div>` : ''}
    ${chain ? `<div style="font-size:.83em;margin-top:6px;color:#d1d1d6"><b style="color:${ACCENT}">Causal chain:</b> ${esc(chain.physicalChange)} → ${esc(chain.economicConsequence)} → expected equity ${esc(chain.expectedEquityDirection)} over ~${chain.expectedHorizonDays}d</div>
      <div style="font-size:.78em;color:${GRAY};margin-top:2px">Exposure: ${esc(chain.companyExposure || '')}</div>
      <div style="font-size:.78em;color:${GRAY}">Invalidation: ${esc((chain.invalidatingEvidence || []).slice(0, 2).join(' · '))}</div>` : ''}
    ${t ? `<div style="font-size:.83em;margin-top:5px"><b style="color:#5ac8fa">Timing (OMEGA-SWING):</b>
        entry ${t.entry ? `${num(t.entry.low)}–${num(t.entry.high)}` : '—'} · stop ${num(t.stop)} · target ${num(t.target)} · R:R ${num(t.rr)} · ${esc(t.entryClass || '')}</div>`
      : `<div style="font-size:.8em;color:${GRAY};margin-top:5px">Timing: not evaluated (OMEGA budget or insufficient history)</div>`}
    <div style="color:${GRAY};font-size:.75em;margin-top:5px">🧪 SHADOW · weight-0 · no probability claimed · score ${esc(s.version || '')}</div>
  </div>`;
}

function relativeValuePanel(rv) {
  if (!Array.isArray(rv) || !rv.length) return '';
  return `<div style="margin-top:14px"><div style="font-weight:700;color:${ACCENT}">⚖️ Relative-value research (never auto-short)</div>
    ${rv.map(p => `<div style="border:1px solid #3a3a3c;border-radius:8px;padding:8px 10px;margin-top:6px;font-size:.85em">
      <b>${esc(p.long)}</b> vs <b>${esc(p.comparison)}</b> · event-relative ${p.eventRelativeReturnPct == null ? '—' : p.eventRelativeReturnPct + '%'} · ${esc(p.liquidityNote)}
      <div style="color:${GRAY};font-size:.9em;margin-top:2px">${esc(p.rationale)} ${esc(p.shortSideNote)}</div>
    </div>`).join('')}</div>`;
}

function scenarioPanel(defaultScenario) {
  const base = defaultScenario && defaultScenario.base && defaultScenario.base.assumptions;
  const a = base || {};
  return `<div style="margin-top:14px;border:1px solid #3a3a3c;border-radius:10px;padding:12px">
    <div style="font-weight:700;color:${ACCENT}">🧮 Scenario panel <span style="color:${GRAY};font-weight:400;font-size:.8em">deterministic arithmetic — the AI never calculates these</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin-top:8px;font-size:.82em">
      ${[['addedLoadMW', 'Added load (MW)'], ['generationAddMW', 'New generation (MW)'], ['retirementsMW', 'Retirements (MW)'], ['outagesMW', 'Outages (MW)'], ['gasPriceUSD', 'Gas $/MMBtu'], ['completionProb', 'Completion prob 0–1'], ['weatherSeverity', 'Weather 0/1/2']].map(([k, label]) =>
        `<label style="display:flex;flex-direction:column;gap:2px;color:${GRAY}">${label}
          <input id="gl-sc-${k}" type="number" step="any" value="${a[k] != null ? a[k] : 0}" style="background:#1c1c1e;border:1px solid #3a3a3c;border-radius:6px;color:#fff;padding:4px 6px">
        </label>`).join('')}
    </div>
    <button id="gl-sc-run" class="refresh-btn" style="color:${ACCENT};margin-top:8px">Compute bull / base / bear</button>
    <div id="gl-sc-out" style="margin-top:8px;font-size:.84em">${renderScenario(defaultScenario)}</div>
  </div>`;
}

function renderScenario(tri) {
  if (!tri || !tri.ok) return `<span style="color:${GRAY}">Scenario unavailable${tri && tri.errors ? ': ' + esc(tri.errors.join('; ')) : ''}.</span>`;
  const cell = (name, sc) => {
    const d = sc.derived;
    return `<div style="border:1px solid #3a3a3c;border-radius:8px;padding:8px">
      <b style="color:${name === 'bull' ? '#34c759' : name === 'bear' ? '#ff453a' : ACCENT}">${name.toUpperCase()}</b>
      <div style="color:#d1d1d6;margin-top:3px">reserve margin ${d.reserveMarginBeforePct.value}% → <b>${d.reserveMarginAfterPct.value}%</b></div>
      <div>price proxy <b>$${d.priceProxyUSDMWh.value}/MWh</b> (scarcity ×${d.scarcityMultiplier.value})</div>
      <div style="color:${GRAY}">constraint: ${esc(d.constraintDirection.value)}</div>
    </div>`;
  };
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">
      ${cell('bull', tri.bull)}${cell('base', tri.base)}${cell('bear', tri.bear)}</div>
    <div style="color:${GRAY};font-size:.85em;margin-top:5px">${esc(tri.base.caveat)}<br>bull: ${esc(tri.adjustments.bull)} · bear: ${esc(tri.adjustments.bear)}</div>`;
}

function wireScenario(container) {
  const btn = container.querySelector('#gl-sc-run');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const out = container.querySelector('#gl-sc-out');
    out.innerHTML = `<span style="color:${GRAY}">computing…</span>`;
    const v = (k) => container.querySelector(`#gl-sc-${k}`) ? container.querySelector(`#gl-sc-${k}`).value : '';
    const q = ['addedLoadMW', 'generationAddMW', 'retirementsMW', 'outagesMW', 'gasPriceUSD', 'completionProb', 'weatherSeverity']
      .map(k => `${k}=${encodeURIComponent(v(k))}`).join('&');
    const tri = await getJSON(`/api/tracker?op=gridlockscenario&${q}`);
    out.innerHTML = renderScenario(tri);
  });
}

export async function loadGridlock(container) {
  if (!container) return;
  container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Loading GRIDLOCK (shadow)…</p></div>';
  const d = await getJSON('/api/tracker?op=gridlock');
  if (!d) {
    container.innerHTML = `<div class="mom-status error"><p>GRIDLOCK board unreachable — network or server error. Nothing here affects live picks.</p></div>`;
    return;
  }
  if (d.disabled) {
    container.innerHTML = `<div style="color:${GRAY};padding:12px">GRIDLOCK is disabled (GRIDLOCK_MODE=off). The rest of the app is unaffected.</div>`;
    return;
  }
  if (d.ok === false && d.warming) {
    container.innerHTML = `<div style="color:${GRAY};padding:12px">🌱 ${esc(d.note || 'First snapshot pending — the nightly cron builds it.')}</div>`;
    return;
  }
  if (d.ok === false) {
    container.innerHTML = `<div class="mom-status error"><p>GRIDLOCK error: ${esc(d.error || 'unknown')}. Shadow-only — nothing else is affected.</p></div>`;
    return;
  }
  const cands = Array.isArray(d.candidates) ? d.candidates : [];
  const res = d.resolution || {};
  const resLine = res.predictions
    ? `prospective record: ${res.predictions} candidate${res.predictions === 1 ? '' : 's'} logged${res.note ? ` — ${esc(res.note)}` : ''}`
    : 'prospective record: accruing from zero — no performance is claimed';
  const partial = d.coverage && d.coverage.sourceFailures && d.coverage.sourceFailures.length
    ? `<div style="color:#ff9f0a;font-size:.82em;margin-top:6px">⚠️ Partial data: ${esc(d.coverage.sourceFailures.join(' · '))}</div>` : '';
  container.innerHTML = `
    ${shadowBanner(d)}
    ${partial}
    ${regionPanel(d.region)}
    ${eventLedger(d.events)}
    <div style="margin-top:14px"><div style="font-weight:700;color:${ACCENT}">🎯 Ranked equity consequences</div>
      ${cands.length ? cands.map(candidateCard).join('') : `<div style="color:${GRAY};padding:10px">No classified beneficiaries today — an honest empty board beats a forced pick.</div>`}
    </div>
    ${d.recordedRejections && d.recordedRejections.length ? `<details style="margin-top:8px;color:${GRAY};font-size:.82em"><summary>Recorded rejections (${d.recordedRejections.length}) — logged, not hidden</summary>${d.recordedRejections.slice(0, 40).map(r => `<div>${esc(r.ticker)} — ${esc(r.classification)}${r.reason ? `: ${esc(r.reason)}` : ''}</div>`).join('')}</details>` : ''}
    ${relativeValuePanel(d.relativeValue)}
    ${scenarioPanel(d.scenarioDefault)}
    <div style="color:${GRAY};font-size:.8em;margin-top:10px">📋 ${resLine} · outcomes resolve on the Scoreboard (Gridlock section, sector-relative).</div>
  `;
  wireScenario(container);
}
