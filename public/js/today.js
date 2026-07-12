// 🏠 TODAY — the unified decision command center (#1/#2/#10). Renders the server-
// authoritative op=today payload: every screener's picks normalized into ONE ranked,
// validated table, bucketed by horizon, with an HONEST independent-evidence count
// (not a screener-count), lifecycle state, execution-aware ranking, upcoming risk
// events, and data-freshness. The engine lives in lib/decision.js (server) — this
// module only renders, so there is no client/server scoring skew.
import { esc } from './format.js';

const HORIZONS = [
  ['intraday', '⚡ Intraday', 'gaps · momentum · VWAP/ORB — same-session'],
  ['swing', '📈 Swing', 'breakouts · coils · accumulation — days to weeks'],
  ['position', '🧭 Position', '1–6 month leads — momentum, revisions, cross-asset'],
  ['portfolio', '💼 Portfolio', 'core momentum sleeve — quarterly rebalance, multi-month hold'],
];
const STATE = {
  detected: ['·', 'Detected', 'st-grey'], early: ['🌱', 'Early', 'st-grey'],
  ready: ['🟢', 'Ready', 'st-green'], triggered: ['🚀', 'Triggered', 'st-green'],
  extended: ['🟡', 'Extended', 'st-amber'], failed: ['❌', 'Failed', 'st-red'],
  expired: ['⏰', 'Expired', 'st-red'], resolved: ['🏁', 'Resolved', 'st-grey'],
};
const SRC_TAB = { screener: 'screener', gapgo: 'gapgo', daytrade: 'daytrade', coil: 'coil', coremo: 'coremo', biotech: 'biotech', gapdown: 'gapdown',
  readthrough: 'readthrough', anomaly: 'anomaly', secondwave: 'secondwave', crossasset: 'crossasset', toneshift: 'toneshift' };

// Evidence grade per source (section → {icon,label,grade}), from op=maturity. Lets
// every card carry the EARNED trust grade next to its raw score — the honest read
// (a 0–100 score is a relative rank, the grade is what the track record supports).
let GRADES = {};
function gradeChip(sig) {
  const g = GRADES[sig.section];
  if (!g) return '';
  return `<span class="td-grade mat-${esc(g.grade)}" title="${esc(g.blurb || '')}">${g.icon} ${esc(g.label)}</span>`;
}
function pctileChip(sig) {
  if (sig.percentile == null) return '';
  return `<span class="td-pctile" title="Universe percentile — a relative rank within this screen, NOT a probability.">${sig.percentile}th pct</span>`;
}

const pct = v => (v == null ? '' : `${v > 0 ? '+' : ''}${v}%`);

// Independent-evidence chip — the honest core of #3. Shows how many DISTINCT families
// back the name, flags the misleading "several screeners but one factor" case.
function evidenceLine(sig, legend) {
  const e = sig.evidence || {};
  const names = (e.families || []).map(f => (legend && legend[f]) || f);
  const warn = e.singleFamily ? ` <span class="td-warn" title="Multiple screeners agree but they read the SAME factor — really one confirmation, not several.">⚠️ correlated</span>` : '';
  const src = (sig.sources || []).length > 1 ? ` <span class="td-dim">· ${sig.sources.length} screeners</span>` : '';
  return `<div class="td-eviden">🧩 <b>${e.familyCount || 1}</b> independent ${e.familyCount === 1 ? 'family' : 'families'}: ${esc(names.join(' + '))}${src}${warn}</div>`;
}

// Track-record line — validated expectancy from the live Scoreboard (#4/#5). Only
// shown when the name's section:tier has a real sample; otherwise says "building".
function trackLine(sig) {
  const x = sig.expectancy;
  if (!x || !x.known || !x.n) return `<span class="td-dim td-track">📊 no track record yet</span>`;
  const beat = x.avgExcess != null ? `${pct(x.avgExcess)} vs market` : `${x.winRate}% win`;
  const col = (x.avgExcess ?? 0) >= 0 ? 'td-pos' : 'td-neg';
  return `<span class="td-track ${col}" title="Realized forward return of this signal class at its horizon, vs SPY (n=${x.n})">📊 ${esc(beat)} · n=${x.n}</span>`;
}

// Per-card event chip (#8): only the actionable case — a binary print inside the
// hold window — is loud (amber). Passed/scheduled stay quiet to avoid clutter.
const evWhen = ev => (Number.isFinite(ev.inDays) ? `in ${ev.inDays}d` : ev.when ? `~${String(ev.when).slice(0, 10)}` : 'soon');
function eventChip(ev) {
  if (!ev || ev.type !== 'earnings') return '';
  if (ev.kind === 'binary') return `<span class="td-evt-chip binary" title="Earnings report lands inside this trade's window — a binary gap risk. Size down or wait until after.">⚠️ ER ${esc(evWhen(ev))}</span>`;
  if (ev.kind === 'passed') return `<span class="td-evt-chip" title="Already reported — the catalyst may already be in the price.">✓ reported</span>`;
  return '';
}

function levels(sig) {
  if (!(sig.entry > 0)) return '';
  const parts = [`<span>Entry <b>$${esc(sig.entry)}</b></span>`];
  if (sig.stop > 0) parts.push(`<span>Stop <b>$${esc(sig.stop)}</b></span>`);
  if (sig.target > 0) parts.push(`<span>Target <b>$${esc(sig.target)}</b></span>`);
  if (sig.rr) parts.push(`<span class="td-rr">${esc(sig.rr)}:1 R:R</span>`);
  return `<div class="td-levels">${parts.join('')}</div>`;
}

function signalCard(sig, legend) {
  const [si, slbl, scls] = STATE[sig.state] || STATE.detected;
  const exWarn = (sig.execution && sig.execution.penalties && sig.execution.penalties.length)
    ? `<span class="td-exec" title="Execution frictions penalize the rank">⚠️ ${esc(sig.execution.penalties[0])}</span>` : '';
  const tab = SRC_TAB[sig.source] || 'screener';
  return `<div class="td-card" data-go="${tab}">`
    + `<div class="td-top"><span class="td-rank">#${sig.rank}</span>`
    + `<span class="td-tk" data-live="${esc(sig.ticker)}">${esc(sig.ticker)}</span>`
    + `<span class="td-co">${esc(sig.company || sig.setup || '')}</span>`
    + `<span class="td-score" title="Composite: confidence × regime-fit × execution × validated-expectancy × independent-evidence">${sig.score}</span></div>`
    + `<div class="td-chips"><span class="td-state ${scls}">${si} ${slbl}</span>`
    + (sig.side === 'short' ? `<span class="td-short" title="A short setup — profits if it falls (favored in risk-off)">🔻 SHORT</span>` : '')
    + `<span class="td-setup">${esc(sig.setup || sig.source)}</span>`
    + (sig.sector ? `<span class="td-sect">${esc(sig.sector)}</span>` : '') + gradeChip(sig) + pctileChip(sig) + exWarn + `</div>`
    + evidenceLine(sig, legend)
    + levels(sig)
    + `<div class="td-foot">${trackLine(sig)}${eventChip(sig.event)}${sig.catalyst ? `<span class="td-cat" title="${esc(sig.catalyst)}">📰 catalyst</span>` : ''}</div>`
    + `</div>`;
}

function lane(title, arr, legend) {
  if (!arr || !arr.length) return '';
  return `<div class="td-lane"><div class="td-lane-h">${title} <span class="td-dim">${arr.length}</span></div>`
    + arr.slice(0, 6).map(s => `<span class="td-lane-tk" data-go="${SRC_TAB[s.source] || 'screener'}" title="${esc(s.setup || '')} · score ${s.score}">${esc(s.ticker)}</span>`).join('') + `</div>`;
}

export function renderCommandCenter(container, p) {
  if (!container) return;
  if (!p || !p.ok) { container.innerHTML = `<div class="dt-note" style="border-left-color:var(--red)">⚠️ The command center couldn't load its signals right now — a data source may be down. Try Refresh.</div>`; return; }
  const legend = p.evidenceLegend || {};
  const reg = p.regime || {};
  const regCol = reg.bearish ? 'var(--red)' : reg.riskOn ? 'var(--green)' : 'var(--amber,#f59e0b)';

  // Header: regime + leading/weakening sectors.
  const secChip = (s, dir) => `<span class="td-sec-chip ${dir}">${esc(s.name)} <b>${pct(+(+s.changePct).toFixed(1))}</b></span>`;
  let html = `<div class="td-cc">`;
  html += `<div class="td-head" style="border-left-color:${regCol}">`
    + `<div class="td-regime"><b>${esc(p.regime.label)}</b>${reg.breadthPct != null ? ` · breadth ${reg.breadthPct}%` : ''}${reg.condition ? ` · ${esc(reg.condition)} tape` : ''}</div>`
    + `<div class="td-sectors"><span class="td-dim">Leading</span> ${(p.sectors?.leading || []).map(s => secChip(s, 'lead')).join('')} `
    + `<span class="td-dim">Weakening</span> ${(p.sectors?.weakening || []).map(s => secChip(s, 'weak')).join('')}</div></div>`;

  // Top-3 per horizon (#2 — never mixed).
  html += `<div class="td-horizons">`;
  for (const [key, title, sub] of HORIZONS) {
    const list = (p.horizons && p.horizons[key]) || [];
    html += `<div class="td-hz"><div class="td-hz-h">${title} <span class="td-dim">${esc(sub)}</span></div>`;
    html += list.length ? list.slice(0, 4).map(s => signalCard(s, legend)).join('')
      : `<div class="td-dim td-empty">No qualifying ${key} setups today.</div>`;
    html += `</div>`;
  }
  html += `</div>`;

  // Movement lanes (#10) — populated once yesterday's snapshot exists.
  const L = p.lanes || {};
  const laneHtml = lane('🆕 New', L.new, legend) + lane('⬆️ Upgraded', L.upgraded, legend)
    + lane('⬇️ Downgraded', L.downgraded, legend) + lane('❌ Failed', L.failed, legend)
    + lane('⏰ Expired', L.expired, legend);
  if (laneHtml) html += `<div class="td-lanes"><div class="td-lanes-h">Since yesterday</div>${laneHtml}</div>`;

  // Upcoming risk events (#8).
  if (p.events && p.events.length) {
    const evLabel = e => e.type === 'earnings'
      ? (e.kind === 'binary' ? `⚠️ ${esc(e.ticker)} earnings ${esc(evWhen(e))}` : e.kind === 'passed' ? `✓ ${esc(e.ticker)} reported` : `📅 ${esc(e.ticker)} earnings ${esc(evWhen(e))}`)
      : `${esc(e.ticker)}: ${esc(e.type)}`;
    html += `<div class="td-events"><div class="td-lanes-h">⚠️ Upcoming events <span class="td-dim">— a print inside a trade's window is a binary gap risk</span></div>`
      + p.events.slice(0, 10).map(e => `<span class="td-evt ${e.kind === 'binary' ? 'binary' : ''}" title="${esc(e.when ? String(e.when).slice(0, 10) : e.kind || '')}">${evLabel(e)}</span>`).join('') + `</div>`;
  }

  // Freshness / system health (#10/#11) — error ≠ empty.
  const fr = p.freshness || {};
  if (fr.warnings && fr.warnings.length) html += `<div class="dt-note" style="border-left-color:var(--amber,#f59e0b)">🔧 ${esc(fr.warnings.join(' · '))}</div>`;
  html += dataTrustPanel(fr);
  html += `<div class="td-dim td-cc-foot">One ranked table across ${p.counts?.signals ?? 0} signals — ranked by validated track record × confidence × regime-fit × execution × <b>independent evidence</b> (not a sum of screener scores). Leads, not advice; always confirm and use a stop.</div>`;
  html += `</div>`;
  container.innerHTML = html;
  container.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-live]') && ev.target.hasAttribute('data-live')) return;
    if (typeof window.showTab === 'function') window.showTab(b.dataset.go);
  }));
}

// Data-trust panel — per-source feed + freshness, plus the fact/feature/AI/unknown
// legend. Collapsed by default so it informs without cluttering the daily read.
function dataTrustPanel(fr) {
  const sources = fr.sources || [];
  if (!sources.length && !(fr.legend || []).length) return '';
  const rows = sources.map(s => {
    const dot = !s.ok ? '🔴' : s.stale ? '🟠' : '🟢';
    const age = s.ageHours == null ? 'age unknown' : s.ageHours < 1 ? '<1h old' : `${Math.round(s.ageHours)}h old`;
    const status = !s.ok ? 'unavailable' : `${age} · ${s.delayed ? 'delayed' : 'real-time'}`;
    return `<div class="dt-src"><span>${dot} <b>${esc(s.label || s.source)}</b></span><span class="td-dim">${esc((s.feed || []).join(', '))}</span><span class="dt-src-st ${s.stale ? 'stale' : ''}">${esc(status)}</span></div>`;
  }).join('');
  const legend = (fr.legend || []).map(l => `<div class="dt-leg"><span>${l.icon} <b>${esc(l.label)}</b></span> <span class="td-dim">${esc(l.basis)}</span></div>`).join('');
  return `<details class="dt-trust"><summary>🔎 Data trust — sources, freshness &amp; what's fact vs interpretation${fr.dataVersion ? ` · ${esc(fr.dataVersion)}` : ''}</summary>
    <div class="dt-trust-body">
      <div class="dt-trust-note">This is an <b>end-of-day dashboard</b> — market data is <b>delayed</b>, not a live trading feed. Always confirm a live quote before acting.</div>
      <div class="dt-srcs">${rows}</div>
      <div class="dt-leg-h">What each output is grounded in:</div>${legend}
    </div></details>`;
}

export async function loadCommandCenter(container) {
  if (!container) return null;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Ranking every screener into one table…</p></div>`;
  let p = null, mat = null;
  try { [p, mat] = await Promise.all([
    fetch('/api/tracker?op=today').then(r => r.json()),
    fetch('/api/tracker?op=maturity').then(r => r.json()).catch(() => null),
  ]); } catch { p = null; }
  GRADES = {};
  if (mat && mat.strategies) mat.strategies.forEach(s => {
    if (s.section) GRADES[s.section] = { grade: s.grade, icon: (mat.gradeMeta[s.grade] || {}).icon || '', label: (mat.gradeMeta[s.grade] || {}).label || s.grade, blurb: (mat.gradeMeta[s.grade] || {}).blurb };
  });
  renderCommandCenter(container, p);
  return p;
}
