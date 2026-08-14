// 📉 Short Interest Overlay — Shadow Research (OMEGA_SI_LEVEL_5D_TOP10) panel.
// Read-only view over op=sistatus / op=siwf / op=sisnapshot. Weight-0 research:
// it reports whether FINRA short-interest crowding adds incremental 5-session
// alpha to OMEGA selection. It NEVER affects live OMEGA ranking, and it never
// renders buy/sell language or squeeze predictions from short interest alone.
import { esc } from './format.js';
import { fetchJSON, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';

const ACCENT = '#ff9f0a';

const VERDICT_STYLE = {
  INSUFFICIENT_DATA: { color: '#8e8e93', label: 'INSUFFICIENT_DATA' },
  NO_INCREMENTAL_ALPHA: { color: '#ff453a', label: 'NO_INCREMENTAL_ALPHA' },
  SHADOW_CANDIDATE: { color: '#f0b429', label: 'SHADOW_CANDIDATE' },
  PROMOTION_REVIEW_REQUIRED: { color: '#34c759', label: 'PROMOTION_REVIEW_REQUIRED' },
};

const pctS = (x, d = 3) => (x == null || !isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(+x).toFixed(d)}%`);
const num = (x, d = 2) => (x == null || !isFinite(x) ? '—' : (+x).toFixed(d));

function card(title, body, subtitle = '') {
  return `<div class="mom-block" style="margin-bottom:14px">
    <h3 style="color:${ACCENT};margin:0 0 2px">${title}</h3>
    ${subtitle ? `<p style="color:#8e8e93;font-size:.78em;margin:0 0 8px">${subtitle}</p>` : ''}
    ${body}</div>`;
}

function shadowBanner() {
  return `<div style="border:1px solid ${ACCENT}55;background:${ACCENT}11;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:.85em">
    🛡️ <b>Does not affect live OMEGA ranking.</b> Shadow research, weight-0: no alerts, no recommendations,
    no portfolio changes. Short interest here is FINRA <i>consolidated short interest</i> (semi-monthly),
    joined only after its conservative public-availability date — never daily short-sale volume.</div>`;
}

function verdictPanel(st) {
  const v = VERDICT_STYLE[st.verdict] || VERDICT_STYLE.INSUFFICIENT_DATA;
  const r = st.retrospective;
  const rows = [];
  if (r) {
    rows.push(['Resolved OOS dates', r.oosDates], ['Joined rows', r.joinedRows], ['Tickers', r.tickers],
      ['SI coverage', r.siCoverage != null ? (r.siCoverage * 100).toFixed(1) + '%' : '—'],
      ['Incremental (C−B)', r.incremental ? pctS(r.incremental.meanPct) + '/cohort' : '—'],
      ['95% CI', r.incremental && r.incremental.ci95 ? `[${pctS(r.incremental.ci95.lo)}, ${pctS(r.incremental.ci95.hi)}]` : '—'],
      ['Positive folds', r.positiveFolds], ['FDR q', r.incremental ? num(r.incremental.q, 4) : '—']);
  }
  const fin = st.finra;
  if (fin) rows.push(['Latest FINRA settlement', esc(fin.latestSettlementDate || '—')],
    ['Est. publication', esc(fin.latestPublicationDate || '—')],
    ['Usable from (conservative)', esc(fin.availableAt || '—')],
    ['Data age', fin.dataAgeDays != null ? fin.dataAgeDays + 'd' : '—']);
  const p = st.prospective;
  if (p) rows.push(['Prospective days logged', p.logged], ['Prospective resolved', `${p.resolved} / ${p.promotionGate.minResolvedDates} (${p.progressPct}%)`]);
  const tbl = `<table class="mom-table" style="font-size:.85em"><tbody>${rows.map(([k, val]) =>
    `<tr><td style="color:#8e8e93">${k}</td><td>${val == null ? '—' : val}</td></tr>`).join('')}</tbody></table>`;
  const warn = (st.integrityWarnings || []).map((w) => `<p style="color:#f0b429;font-size:.8em;margin:4px 0 0">⚠️ ${esc(w)}</p>`).join('');
  const revNote = `<p style="color:#8e8e93;font-size:.78em;margin:6px 0 0">Revision risk: retrospectively downloaded FINRA history may already embed revisions whose original prints are unrecoverable — every historical record is treated as revision-risky by construction.</p>`;
  return card('Verdict',
    `<p style="margin:0 0 8px"><span style="color:${v.color};font-weight:700;border:1px solid ${v.color};border-radius:6px;padding:2px 8px">${v.label}</span></p>
     ${(st.verdictReasons || []).length ? `<p style="color:#8e8e93;font-size:.8em;margin:0 0 8px">${st.verdictReasons.map(esc).join(' · ')}</p>` : ''}
     ${tbl}${warn}${revNote}`);
}

function wfPanel(wf) {
  if (!wf || !wf.arms) return '';
  const armRow = (k, a) => a ? `<tr><td>${k}</td><td>${pctS(a.meanPct)}</td><td>${pctS(a.medianPct)}</td><td>${(a.winRate * 100).toFixed(1)}%</td><td>${num(a.sharpeLike)}</td></tr>` : '';
  const folds = (wf.folds || []).map((f) => f.usable
    ? `<tr><td>${f.fold}</td><td>${esc(f.trainDates.first)} → ${esc(f.trainDates.last)} (${f.trainDates.n})</td><td>${f.purgedDates}</td><td>${esc(f.testDates.first)} → ${esc(f.testDates.last)} (${f.testDates.n})</td><td>${pctS(f.incrementalMeanPct)}</td></tr>`
    : `<tr><td>${f.fold}</td><td colspan="4" style="color:#ff453a">unusable — ${esc(f.reason || '')}</td></tr>`).join('');
  const rob = Object.entries(wf.robustness || {}).map(([id, r]) => {
    const i = r.incremental;
    return `<tr><td>${esc(id)}</td><td>${r.oosDates}</td><td>${i ? pctS(i.meanPct) : '—'}</td><td>${i && i.bootstrap ? `[${pctS(i.bootstrap.lo)}, ${pctS(i.bootstrap.hi)}]` : '—'}</td><td>${r.positiveFolds}/${r.usableFolds}</td><td>${i ? num(i.tTest.pOneSided, 4) : '—'}</td></tr>`;
  }).join('');
  return card('Walk-forward (retrospective, expanding + purged)',
    `<table class="mom-table" style="font-size:.82em"><thead><tr><th>arm</th><th>mean/cohort</th><th>median</th><th>win</th><th>Sharpe-like</th></tr></thead>
      <tbody>${armRow('A · fixed OMEGA', wf.arms.A)}${armRow('B · trained baseline', wf.arms.B)}${armRow('C · baseline + SI', wf.arms.C)}</tbody></table>
     <table class="mom-table" style="font-size:.8em;margin-top:8px"><thead><tr><th>fold</th><th>train</th><th>purged</th><th>test</th><th>incr</th></tr></thead><tbody>${folds}</tbody></table>
     <table class="mom-table expert-only" style="font-size:.8em;margin-top:8px"><thead><tr><th>robustness spec</th><th>OOS</th><th>incr</th><th>95% CI</th><th>folds+</th><th>p(1s)</th></tr></thead><tbody>${rob}</tbody></table>`,
    'Net residual returns per cohort vs SPY after 0.16% round-trip cost. Incremental = C − B (the SI contribution alone).');
}

function tickerPanel(snap) {
  if (!snap || !Array.isArray(snap.rows) || !snap.rows.length) return '';
  const rows = snap.rows.map((r) => {
    const crowded = r.crowding && r.crowding.startsWith('Extreme');
    const stale = r.revisionFlag === 'R' || r.revisionRisk;
    return `<tr><td><b>${esc(r.ticker)}</b></td><td>${num(r.daysToCover)}</td><td>${esc(r.publicationDate || '—')}</td>
      <td style="color:${crowded ? '#ff9f0a' : '#8e8e93'}">${esc(r.crowding || 'Normal')}</td>
      <td style="color:#8e8e93">${stale ? '⚠️ revised/retro' : '—'}</td></tr>`;
  }).join('');
  return card('Per-ticker (informational only — never a signal)',
    `<div style="max-height:320px;overflow:auto"><table class="mom-table" style="font-size:.8em">
      <thead><tr><th>ticker</th><th>days-to-cover</th><th>publication</th><th>crowding</th><th>staleness/revision</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`,
    `Settlement ${esc(snap.rows[0]?.settlementDate || '—')} · availability is settlement + 13 calendar days (conservative).`);
}

export async function loadSiLab(container) {
  if (!container) return;
  container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Loading short-interest shadow research…</p></div>';
  const [status, wf, snap] = await Promise.all([
    fetchJSON('/api/tracker?op=sistatus', { timeoutMs: OPTIONAL_TIMEOUT_MS }).catch(() => null),
    fetchJSON('/api/tracker?op=siwf', { timeoutMs: OPTIONAL_TIMEOUT_MS }).catch(() => null),
    fetchJSON('/api/tracker?op=sisnapshot', { timeoutMs: OPTIONAL_TIMEOUT_MS }).catch(() => null),
  ]);
  if (!status) {
    container.innerHTML = '<div class="mom-status"><p>Short-interest shadow data unavailable right now.</p></div>';
    return;
  }
  container.innerHTML = [shadowBanner(), verdictPanel(status), wfPanel(wf), tickerPanel(snap)].join('');
}
