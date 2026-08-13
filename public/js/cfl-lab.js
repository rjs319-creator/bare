// 🔭 Counterfactual Opportunity & Forecastability Lab — Research Lab panel.
// Read-only shadow view over op=cfl / cflmissed / cflduds / cflforecast.
// Weight-0: nothing here is a buy signal; it measures where the pipeline loses
// winners (and why picks fail), and whether misses were preventable at all.
import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';

const ACCENT = '#64d2ff';

const pct = (x, d = 1) => x == null ? '—' : (x * 100).toFixed(d) + '%';
const num = (x, d = 0) => x == null ? '—' : (+x).toFixed(d);

const MISS_LABEL = {
  UNIVERSE_EXCLUSION: 'Not in universe', DATA_UNAVAILABLE: 'Data unavailable',
  DATA_STALE_OR_FAILED: 'Data stale/failed', CANDIDATE_GENERATION_FAILURE: 'Screeners never surfaced it',
  RANKING_FAILURE: 'Ranked below the cut', LATE_DETECTION: 'Seen too late',
  RISK_VETO: 'Risk gate vetoed it', ALERT_FAILURE: 'No alert layer',
  PRESENTATION_FAILURE: 'Never displayed', LIQUIDITY_OR_EXECUTION_FAILURE: 'Not realistically tradable',
  INFORMATION_ARRIVED_AFTER_MOVE: 'News landed with the move', OUT_OF_DISTRIBUTION: 'Outside known conditions',
  NO_PREMOVE_EVIDENCE: 'No advance evidence existed',
};
const DISP_COLOR = {
  ACTIONABLE: '#34c759', WATCH: '#f0b429', INSUFFICIENT_EVIDENCE: '#8e8e93',
  OUT_OF_DISTRIBUTION: '#ff9f0a', DATA_STALE: '#ff453a', ABSTAIN: '#bf5af2',
};

function card(title, subtitle, body) {
  return `<div style="background:#1c1c1e;border:1px solid #2c2c2e;border-radius:10px;padding:14px 16px;margin-bottom:12px">
    <div style="font-weight:600;color:${ACCENT}">${title}</div>
    ${subtitle ? `<div class="dt-dim" style="font-size:12px;margin:2px 0 8px">${subtitle}</div>` : ''}
    ${body}</div>`;
}

function shadowBanner(d) {
  const built = d && d.generatedAt ? new Date(d.generatedAt).toLocaleString() : 'never';
  return `<div style="border:1px solid #3a3a3c;border-left:4px solid ${ACCENT};border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">
    🔭 <b>Shadow measurement system — never a buy signal.</b> It asks two questions: which big movers did the pipeline miss (and at exactly which stage), and were those misses preventable at all?
    <span class="dt-dim">Last build: ${esc(built)}. Historical sweeps use as-of-today candles (<b>no delisted names — survivorship-limited</b>); only prospective decision snapshots are fully clean. Intraday misses live in the Day-Trade Miss Audit tab.</span></div>`;
}

function funnelPanel(fn, horizon) {
  if (!fn || !fn.days) return card('Pipeline funnel', null, '<div class="dt-dim">No reconstruction days yet — the nightly job (or a backfill) has to run first.</div>');
  const s = fn.stages || {};
  const stageRows = [
    ['Eligible universe (name-dates)', s.eligibleUniverse],
    ['Generated candidates', s.generatedCandidates],
    ['Top-ranked (selected)', s.topRanked],
    ['Alerted', `${s.alerted} <span class="dt-dim">(no alert layer exists for this lane — a finding)</span>`],
    ['Captured opportunities', s.actionableEntries],
  ].map(([l, v]) => `<tr><td style="padding:2px 10px 2px 0">${l}</td><td style="text-align:right">${v ?? '—'}</td></tr>`).join('');
  const cats = Object.entries(fn.missByCategory || {}).sort((a, b) => b[1] - a[1]);
  const maxN = cats.length ? cats[0][1] : 1;
  const hist = cats.map(([c, n]) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:2px 0">
      <span style="width:210px;flex:none">${esc(MISS_LABEL[c] || c)}</span>
      <span style="flex:1;background:#2c2c2e;border-radius:3px;height:10px;overflow:hidden"><i style="display:block;height:100%;background:${ACCENT};width:${Math.round(100 * n / maxN)}%"></i></span>
      <span style="width:30px;text-align:right">${n}</span>
    </div>`).join('') || '<div class="dt-dim">No attributed misses yet.</div>';
  const ps = fn.preventableSplit || {};
  return card(`Pipeline funnel — ${horizon.replace('h', '')} sessions`,
    `${fn.days} checkpoint days · ${fn.opportunities} significant opportunities · capture rate ${pct(fn.selection && fn.selection.opportunityCaptureRate)}`,
    `<div style="display:flex;gap:20px;flex-wrap:wrap">
      <table style="border-collapse:collapse;font-size:13px">${stageRows}</table>
      <div style="flex:1;min-width:260px"><div class="dt-dim" style="font-size:12px;margin-bottom:4px">Why winners were missed</div>${hist}</div>
    </div>
    <div style="font-size:12px;margin-top:8px">Preventable <b>${ps.preventable ?? 0}</b> vs genuinely unforecastable <b>${ps.unforecastable ?? 0}</b>
      ${ps.preventableShare != null ? `(${pct(ps.preventableShare)} preventable)` : ''}
      · median warning ${fn.warningTime && fn.warningTime.medianSessions != null ? fn.warningTime.medianSessions + ' sessions' : '—'}
      · discovery recall ${pct(fn.discovery && fn.discovery.opportunityRecall)}</div>`);
}

function missedPanel(md) {
  if (!md || !md.ok || !md.rows || !md.rows.length) {
    return card('Missed winners', null, '<div class="dt-dim">No attributed missed winners yet for this horizon — either nothing qualified, or the sweep hasn\'t run. An honest empty board beats an invented one.</div>');
  }
  const rows = md.rows.slice(0, 25).map(r => `
    <tr data-ticker="${esc(r.symbol)}">
      <td style="padding:3px 8px 3px 0"><b>${esc(r.symbol)}</b></td>
      <td>${esc(r.checkpointDate || '')}</td>
      <td style="text-align:right;color:${(r.excessReturn || 0) >= 0 ? '#34c759' : '#ff453a'}">${pct(r.excessReturn)}</td>
      <td style="text-align:right">${pct(r.mfe)}</td>
      <td>${esc(MISS_LABEL[r.primaryFailure] || r.primaryFailure || '')}</td>
      <td>${r.preventable === false ? '<span style="color:#8e8e93">unforeseeable</span>' : r.preventable === true ? '<span style="color:#f0b429">preventable</span>' : '—'}</td>
      <td class="expert-only" style="text-align:right">${r.warningSessions != null ? r.warningSessions + 's' : '—'}</td>
      <td class="expert-only">${esc(r.firstDetectionDate || 'never seen')}</td>
      <td class="expert-only" style="text-align:right">${r.highestRankBeforeMove != null ? '#' + r.highestRankBeforeMove : '—'}</td>
      <td class="expert-only">${esc(r.gapClass || '')}</td>
    </tr>`).join('');
  return card('Missed winners', `${md.n} attributed · scope ${esc(md.scope)} · benchmark-excess ranked · ${md.daysCovered} days covered${md.unreadableShards ? ` · ⚠ ${md.unreadableShards} unreadable shards` : ''}`,
    `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%">
      <tr class="dt-dim"><th style="text-align:left">Sym</th><th style="text-align:left">Checkpoint</th><th style="text-align:right">Excess</th><th style="text-align:right">MFE</th><th style="text-align:left">Why missed</th><th style="text-align:left">Verdict</th><th class="expert-only" style="text-align:right">Warning</th><th class="expert-only" style="text-align:left">First seen</th><th class="expert-only" style="text-align:right">Best rank</th><th class="expert-only" style="text-align:left">Gap</th></tr>
      ${rows}</table></div>
    <details class="expert-only" style="margin-top:6px"><summary class="dt-dim" style="font-size:12px">🔬 Definitions</summary>
      <div class="dt-dim" style="font-size:12px">Excess = closing return over SPY on the same next-open entry basis. MFE = max favorable excursion from the fill. Warning = sessions between first pipeline sighting and entry. Gap-dominant moves are excluded from "preventable" — they existed only at prices nobody could get.</div></details>`);
}

function dudsPanel(dd) {
  if (!dd || !dd.ok) return card('Duds & false positives', null, '<div class="dt-dim">Pick grading has not run yet.</div>');
  const c = dd.counts || {};
  const cats = Object.entries(dd.byCategory || {}).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<span style="display:inline-block;background:#2c2c2e;border-radius:6px;padding:2px 8px;margin:2px;font-size:12px">${esc(k)} · ${n}</span>`).join('') || '<span class="dt-dim">none</span>';
  const rows = (dd.rows || []).slice(0, 15).map(r => `
    <tr data-ticker="${esc(r.ticker)}"><td style="padding:3px 8px 3px 0"><b>${esc(r.ticker)}</b></td><td>${esc(r.date)}</td>
      <td>${esc(r.section || '')}</td><td style="text-align:right;color:#ff453a">${r.resolved && r.resolved.r != null ? pct(r.resolved.r) : '—'}</td>
      <td>${esc(r.attribution ? r.attribution.primaryFailure : '')}</td>
      <td class="expert-only" style="text-align:right">${r.path ? pct(r.path.mfe) : '—'}</td>
      <td class="expert-only" style="text-align:right">${r.path ? pct(r.path.mae) : '—'}</td></tr>`).join('');
  return card('Duds & false positives', `graded ${dd.graded} first-appearance picks · ${c.success || 0} successes · ${c.dud || 0} duds · ${c.unresolved || 0} still open${dd.truncated ? ' · ⚠ truncated by budget' : ''}`,
    `<div style="margin-bottom:6px">${cats}</div>
    ${rows ? `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%">
      <tr class="dt-dim"><th style="text-align:left">Sym</th><th style="text-align:left">Picked</th><th style="text-align:left">Section</th><th style="text-align:right">R</th><th style="text-align:left">Failure</th><th class="expert-only" style="text-align:right">MFE</th><th class="expert-only" style="text-align:right">MAE</th></tr>${rows}</table></div>` : ''}`);
}

function forecastPanel(fc) {
  if (!fc || !fc.ok) return card('Forecastability & abstention', null,
    '<div class="dt-dim">No decision snapshot yet — snapshots are captured by the nightly warm screener run. Until then there is nothing honest to score.</div>');
  const chips = Object.entries(fc.byDisposition || {}).map(([d, n]) =>
    `<span style="display:inline-block;border:1px solid ${DISP_COLOR[d] || '#8e8e93'};color:${DISP_COLOR[d] || '#8e8e93'};border-radius:6px;padding:2px 8px;margin:2px;font-size:12px">${esc(d)} · ${n}</span>`).join('');
  const rows = (fc.rows || []).slice(0, 20).map(r => `
    <tr data-ticker="${esc(r.symbol)}"><td style="padding:3px 8px 3px 0"><b>${esc(r.symbol)}</b></td>
      <td style="text-align:right">${num(r.forecastabilityScore)}</td>
      <td><span style="color:${DISP_COLOR[r.disposition] || '#8e8e93'}">${esc(r.disposition)}</span></td>
      <td class="expert-only">${esc(r.evidenceStrength || '')}</td>
      <td class="expert-only" style="text-align:right">${num(r.analogueCount)}</td>
      <td class="expert-only" style="text-align:right">${r.distributionShiftScore != null ? num(r.distributionShiftScore, 1) + 'σ' : '—'}</td>
      <td class="expert-only" style="font-size:11px">${esc((r.reasonCodes || []).join(', '))}</td></tr>`).join('');
  return card('Forecastability & abstention', `decision ${esc(fc.date || '')} · ${fc.n} selected names scored · probabilities withheld until a calibrator has support`,
    `<div style="margin-bottom:6px">${chips || '<span class="dt-dim">none</span>'}</div>
    <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px;width:100%">
      <tr class="dt-dim"><th style="text-align:left">Sym</th><th style="text-align:right">Score</th><th style="text-align:left">Disposition</th><th class="expert-only" style="text-align:left">Evidence</th><th class="expert-only" style="text-align:right">Analogues</th><th class="expert-only" style="text-align:right">Shift</th><th class="expert-only" style="text-align:left">Reasons</th></tr>${rows}</table></div>
    <div class="dt-dim" style="font-size:12px;margin-top:6px">${esc(fc.note || '')}</div>`);
}

function tournamentPanel(d) {
  return card('Model tournament', 'champion vs challengers — promotion is governed, never automatic',
    `<table style="border-collapse:collapse;font-size:13px;width:100%">
      <tr class="dt-dim"><th style="text-align:left">Model</th><th style="text-align:left">Role</th><th style="text-align:left">Status</th></tr>
      <tr><td style="padding:3px 8px 3px 0">Breakout screener (screener-v2)</td><td>Registry production (ceiling-capped)</td><td>governed by op=maturity (policy cohort Early:large)</td></tr>
      <tr><td style="padding:3px 8px 3px 0">Forecastability gate (cfl-v1)</td><td>Shadow challenger</td><td>accruing evidence — no calibrator support yet, cannot gate anything</td></tr>
    </table>
    <div class="dt-dim" style="font-size:12px;margin-top:6px">Promotion contract: PIT lineage → recall improves on untouched data → precision/utility holds → survives realistic + doubled costs → calibration acceptable → not concentrated in a few trades → multi-regime → alpha-prosecutor battery (label shuffle, future-feature leak, placebo, drop-best-year, best-trade excision) does not invalidate → thresholds pre-declared. ${d && d.state && d.state.lastTick ? 'Last tick ' + esc(d.state.lastTick.at || '') : ''}</div>`);
}

function integrityPanel(d) {
  if (!d || !d.ok) return '';
  const i = d.integrity || {};
  const bf = d.state && d.state.backfill ? Object.entries(d.state.backfill) : [];
  const bfRows = bf.map(([k, v]) => `<tr><td style="padding:2px 8px 2px 0">${esc(k)}</td><td>${v.nextStart == null ? '✅ complete' : `cursor ${v.nextStart}/${v.totalCheckpoints}`}</td><td class="dt-dim">${esc(v.at || '')}</td></tr>`).join('');
  return card('Data integrity', 'what these numbers can and cannot claim',
    `<table style="border-collapse:collapse;font-size:13px">
      <tr><td style="padding:2px 10px 2px 0">Survivorship-safe history</td><td>${i.survivorshipSafe ? '✅' : '❌ delisted names absent — retrospective miss rates are bounds, not truths'}</td></tr>
      <tr><td style="padding:2px 10px 2px 0">Price adjustment basis</td><td>${esc(i.adjustmentBasis || 'unknown')} (as-of-fetch, not point-in-time vintages)</td></tr>
      <tr><td style="padding:2px 10px 2px 0">Macro overlay point-in-time</td><td>${i.macroPIT ? '✅' : '❌ risk-off veto not replayable historically'}</td></tr>
      <tr><td style="padding:2px 10px 2px 0">Alert layer (swing lane)</td><td>${esc(i.alertLayer || 'unknown')}</td></tr>
      <tr><td style="padding:2px 10px 2px 0">Candle cache build</td><td>${esc(i.candleCacheBuiltDate || '—')} · ${i.datasetSize || 0} names</td></tr>
      <tr><td style="padding:2px 10px 2px 0">Intraday horizon</td><td>delegated to ${esc(i.intradayHorizon || 'large-mover-audit')} (no fabricated intraday labels)</td></tr>
    </table>
    ${bfRows ? `<div class="dt-dim" style="font-size:12px;margin-top:8px">Backfill state</div><table style="border-collapse:collapse;font-size:12px">${bfRows}</table>` : ''}`);
}

export async function loadCflLab(container) {
  if (!container) return;
  container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Reconstructing the counterfactual view…</p></div>';
  const get = (url, t) => fetchJSON(url, { timeoutMs: t }).catch(() => null);
  const [summary, missed, duds, forecast] = await Promise.all([
    get('/api/tracker?op=cfl', HEAVY_TIMEOUT_MS),
    get('/api/tracker?op=cflmissed&horizon=h21', OPTIONAL_TIMEOUT_MS),
    get('/api/tracker?op=cflduds', OPTIONAL_TIMEOUT_MS),
    get('/api/tracker?op=cflforecast', OPTIONAL_TIMEOUT_MS),
  ]);
  if (!summary) {
    container.innerHTML = '<div class="mom-status error"><p>Counterfactual Lab data unavailable.</p></div>';
    return;
  }
  const fn = summary.ok && summary.funnels ? summary.funnels.h21 : null;
  container.innerHTML = [
    shadowBanner(summary.ok ? summary : null),
    funnelPanel(fn, 'h21'),
    missedPanel(missed),
    dudsPanel(duds),
    forecastPanel(forecast),
    tournamentPanel(summary),
    integrityPanel(summary.ok ? summary : null),
    summary.ok ? '' : `<div class="dt-note">Not built yet — the nightly <code>cfl</code> chain (op=cfltick) or a manual backfill has to run first. ${esc(summary.hint || '')}</div>`,
  ].join('');
}
