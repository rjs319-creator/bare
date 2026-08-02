// Research Lab panel for the Peer Propagation shadow engine (peerprop-v1).
// Read-only: fetches op=peerprop and renders an HONEST shadow view — propagation
// stage, unreflected peer strength, confirming leaders, data quality, volume/
// capacity forecast, and the walk-forward + falsification verdict when cached.
// Never implies the engine affects the live rank; it carries weight 0 by design.
// Probabilities are shown as WITHHELD until out-of-fold calibration matures.
import { esc } from './format.js';

const ACCENT = '#ff9f0a';

async function getJSON(url) {
  try { const r = await fetch(url); return await r.json(); } catch { return null; }
}

const STAGE_META = {
  EARLY: { label: 'Early', color: '#34c759', hint: 'peers/leaders moved, this name has not reacted yet — the interesting state' },
  CONFIRMING: { label: 'Confirming', color: '#30d158', hint: 'own move started, peer gap remains' },
  MATURE: { label: 'Mature', color: '#8e8e93', hint: 'gap closed — the propagation already played out' },
  LATE: { label: 'Late', color: '#ff9f0a', hint: 'own move already large — chasing risk' },
  NONE: { label: 'No signal', color: '#8e8e93', hint: 'no propagation read' },
  INVALID: { label: 'Invalid', color: '#ff453a', hint: 'insufficient peer/leader data' },
};

const fmtZ = x => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(2) + 'z');
const fmtPct = x => (x == null ? '—' : Math.round(x * 100) + '%');
const fmtUsd = x => (x == null ? '—' : x >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : '$' + Math.round(x / 1e3) + 'K');

function card(c) {
  const f = c.features || {};
  const meta = STAGE_META[c.stage] || STAGE_META.NONE;
  const vf = c.volumeForecast && c.volumeForecast.available ? c.volumeForecast : null;
  const leaders = (f.topLeaders || []).map(l => `${esc(l.ticker)} (lag ${l.lag}d)`).join(', ');
  return `<div style="border:1px solid #2c2c2e;border-radius:10px;padding:10px 12px;margin:6px 0;background:#1c1c1e">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
      <div><b style="font-size:1.05em">${esc(c.ticker)}</b>
        <span style="color:${meta.color};font-weight:600;margin-left:6px" title="${esc(meta.hint)}">${esc(meta.label)}</span>
        <span style="color:#8e8e93;margin-left:6px">${esc(c.sector || 'no sector (market-only)')}</span>
      </div>
      <div style="color:#8e8e93;font-size:.85em">score ${c.score == null ? '—' : Math.round(c.score)} · quality ${fmtPct(c.dataQuality)}</div>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:.85em;color:#d1d1d6">
      <span title="peer group strength minus this name's own normalized reaction">unreflected ${fmtZ(f.unreflectedPeerStrength)}</span>
      <span>peer strength ${fmtZ(f.peerStrengthZ)}</span>
      <span>own reaction ${fmtZ(f.ownReactionZ)}</span>
      <span>${f.leadersConfirming || 0}/${f.leaders || 0} leaders confirming</span>
      <span>peers improving ${fmtPct(f.peerBreadthImproving)}</span>
      <span>within-peer ${f.withinPeerPosition == null ? '—' : Math.round(f.withinPeerPosition * 100) + 'th'}</span>
    </div>
    ${leaders ? `<div style="margin-top:4px;font-size:.82em;color:#8e8e93">leaders: ${leaders}${f.impulseAgeSessions != null ? ` · impulse ${f.impulseAgeSessions}s ago` : ''}</div>` : ''}
    ${(c.supporting || []).length ? `<div style="margin-top:4px;font-size:.82em;color:#34c759">＋ ${c.supporting.map(esc).join(' · ')}</div>` : ''}
    ${(c.contradicting || []).length ? `<div style="margin-top:2px;font-size:.82em;color:#ff9f0a">－ ${c.contradicting.map(esc).join(' · ')}</div>` : ''}
    ${vf ? `<div style="margin-top:4px;font-size:.82em;color:#5ac8fa" title="execution context only — a volume forecast is never a buy reason">🔊 exp. next-session ${fmtUsd(vf.expectedDollarVol)} (${vf.expectedRelVol == null ? '—' : vf.expectedRelVol + 'x'}) · tier ${esc(vf.forecastTier)} · P(abnormal) ${vf.pAbnormal == null ? '—' : fmtPct(vf.pAbnormal)}</div>` : ''}
    <div style="margin-top:4px;font-size:.8em;color:#636366">Probabilities withheld: ${esc((c.probabilities && c.probabilities.reason) || 'insufficient-calibration-sample')} (needs ${(c.probabilities && c.probabilities.minSamplesForPercent) || 200} matured outcomes)</div>
  </div>`;
}

function wfPanel(wf) {
  if (!wf || !wf.ok) return '';
  const f = wf.falsification || {};
  const per = (wf.experiment && wf.experiment.result && wf.experiment.result.perRanker) || {};
  const row = name => { const s = per[name] || {}; return `<tr><td style="padding:2px 8px">${esc(name)}</td><td style="padding:2px 8px;text-align:right">${s.meanIC == null ? '—' : s.meanIC}</td><td style="padding:2px 8px;text-align:right">${s.ci90 ? s.ci90.join(' … ') : '—'}</td></tr>`; };
  const chk = v => (v === true ? '✅' : v === false ? '❌' : '—');
  return `<div style="border:1px solid #2c2c2e;border-radius:10px;padding:10px 12px;margin:10px 0;background:#151517">
    <b style="color:${ACCENT}">Walk-forward + falsifications</b>
    <span style="color:#8e8e93;font-size:.85em;margin-left:8px">${esc(String(wf.events || 0))} events · ${esc(String(wf.decisionDates || 0))} dates</span>
    <table style="margin-top:6px;font-size:.85em;border-collapse:collapse"><tr style="color:#8e8e93"><td style="padding:2px 8px">ranker</td><td style="padding:2px 8px">mean IC</td><td style="padding:2px 8px">90% CI</td></tr>
      ${['peer-propagation', 'residual-momentum', 'control-random', 'peerprop-reversed-edges', 'peerprop-random-peers'].map(row).join('')}
    </table>
    <div style="margin-top:6px;font-size:.85em;color:#d1d1d6">
      ${chk(f.beatsResidualMomentum)} beats residual momentum ·
      ${chk(f.beatsRandomControl)} beats random ·
      ${chk(f.reversedEdgesWeaker)} reversed edges weaker ·
      ${chk(f.randomPeersWeaker)} random peers weaker
    </div>
    <div style="margin-top:4px;font-size:.85em;color:${/NO VALIDATED/.test(wf.verdict || '') ? '#ff9f0a' : '#34c759'}">${esc(wf.verdict || '')}</div>
  </div>`;
}

export async function loadPeerLab(container) {
  if (!container) return;
  container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Building peer-propagation board…</p></div>';
  const [board, wf] = await Promise.all([
    getJSON('/api/tracker?op=peerprop&_cb=' + Date.now()),
    getJSON('/api/tracker?op=peerpropwf&cached=1&_cb=' + Date.now()),   // cached report only — never triggers the heavy recompute
  ]);
  if (!board || board.ok === false || !Array.isArray(board.candidates)) {
    container.innerHTML = `<div class="mom-status error"><p>Peer-propagation board unavailable${board && board.error ? ': ' + esc(board.error) : ''}.</p></div>`;
    return;
  }
  const cands = board.candidates;
  const byStage = { EARLY: [], CONFIRMING: [], MATURE: [], LATE: [] };
  for (const c of cands) if (byStage[c.stage]) byStage[c.stage].push(c);
  const section = (stage, arr) => arr.length
    ? `<div style="margin-top:10px"><b style="color:${(STAGE_META[stage] || {}).color || '#8e8e93'}">${esc((STAGE_META[stage] || {}).label || stage)}</b>
       <span style="color:#8e8e93;font-size:.85em;margin-left:6px">${esc((STAGE_META[stage] || {}).hint || '')}</span>${arr.map(card).join('')}</div>`
    : '';
  const u = board.universe || {};
  const g = board.graphStats || {};
  container.innerHTML = `
    <div style="font-size:.85em;color:#8e8e93;margin-bottom:4px">
      ${esc(String(u.eligible || 0))}/${esc(String(u.total || 0))} names eligible · ${esc(String(g.edgesKept || 0))} directed leader edges across ${esc(String(g.followersWithLeaders || 0))} followers
      ${board.stale ? ' · <span style="color:#ff9f0a">stale cache</span>' : ''}
    </div>
    <div style="font-size:.85em;color:#ff9f0a;margin-bottom:8px">🛡 Shadow research engine — weight 0 in every live rank. ${esc(board.honesty || '')}</div>
    ${wfPanel(wf)}
    ${section('EARLY', byStage.EARLY)}
    ${section('CONFIRMING', byStage.CONFIRMING)}
    ${section('LATE', byStage.LATE)}
    ${byStage.EARLY.length + byStage.CONFIRMING.length + byStage.LATE.length === 0 ? '<div class="dt-note">No propagation candidates today — an honest empty board beats a padded one.</div>' : ''}
    <div style="margin-top:10px;font-size:.8em;color:#636366">Networks: sector×band peers + statistical leader graph (residual lead/lag). Customer-supplier / analyst-coverage / 13F networks are DISABLED — no point-in-time data (never simulated). Caveats: ${(board.caveats || []).map(esc).join(' · ')}</div>`;
}
