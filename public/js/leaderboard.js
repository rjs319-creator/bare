// 🏆 ALGO LEADERBOARD — ranks the app's screener strategies by realized
// performance so the top performers surface and the laggards are obvious. Pulls
// the live forward-tracked scoreboard (matures toward 3-month) AND the trailing
// 3-month backtest, presents both honestly, and is the ongoing validation surface
// that feeds the self-improving Opportunities ranking.
import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';

const L = (term, txt) => `<span class="learn-term" data-learn="${term}">${txt}</span>`;

const ALGO_NAME = {
  'screener|Breakout': '🔎 Breakout', 'screener|Setup': '🔎 Breakout · Setup', 'screener|Early': '🔎 Breakout · Early',
  'Ghost|GHOST': '👻 Ghost · heavy accum', 'Ghost|STALKING': '👻 Ghost · stalking',
  'momentum|StrongBuy': '🔥 Momentum · buy', 'momentum|StrongSell': '🔥 Momentum · short',
  'CERN|INDEX_DELETE': '⚡ CERN · index deletion', 'CERN|INDEX_ADD_FADE': '⚡ CERN · index addition (fade)',
  'CERN|LOCKUP_EXPIRY': '⚡ CERN · IPO lock-up expiry', 'CERN|FORCED_DOWNGRADE': '⚡ CERN · analyst downgrade',
  'CERN|FIRE_SALE': '⚡ CERN · fund fire-sale', 'CERN|TAX_LOSS': '⚡ CERN · tax-loss selling',
  'CERN|MARGIN_SPIRAL': '⚡ CERN · margin spiral',
};

// Minimum resolved picks before a live forward record can claim a verdict or a medal.
// Mirrors lib/maturity MIN_PROMISING — without it a 3-pick, 100%-win fluke wins the
// board outright (CERN|INDEX_ADD_FADE did exactly that: "+16.85% avg, 100% win, n3"
// took 🥇 while the same engine's 54-pick record was losing money).
export const MIN_RANKED_N = 8;
const BT_TIER = { 'screener|Breakout': 'Breakout', 'screener|Setup': 'Setup', 'screener|Early': 'Early' };

function bestHorizon(h) {
  for (const k of ['3m', '1m', '1w']) if (h && h[k] && h[k].n >= 1) return { ...h[k], horizon: k };
  return null;
}
function wilsonLo(w, n, z = 1.645) {
  if (!n) return 0; const p = w / n, d = 1 + z * z / n;
  return Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d);
}

// Build the ranked board from scoreboard groups + 3-month backtest + cached
// confluence-strategy backtests. Everything normalizes to alpha/excess vs SPY.
// Sections whose registry maturity is production (everything else on this board is a
// registry-shadow strategy with zero live weight — the chip must say so).
const PROD_SECTIONS = new Set(['screener', 'daytrade']);
// Metric bases — rows are RANKED ONLY WITHIN their own basis (RT-04): a 3-month
// backtest alpha, a live forward record at whatever horizon has matured, and a cached
// confluence backtest are three different yardsticks; sorting them on one scalar
// manufactured medals out of incomparable numbers.
const BASIS_ORDER = { live: 0, backtest: 1, confluence: 2 };
export const BASIS_LABEL = {
  live: 'Live forward records (scoreboard, ranked within basis)',
  backtest: '3-month backtest (promotion-blocked reference — ranked within basis)',
  confluence: 'Confluence cached backtests (ranked within basis)',
};
export function buildBoard(groups, btSummary, confAlgos) {
  const rows = (groups || [])
    // HIST_* (reconstructed history) and BROAD_* (independent shadow discovery) are
    // research lanes with separate records — never comparable leaderboard rows.
    .filter(g => !/^(HIST_|BROAD_)/.test(String(g.tier || '')))
    .map(g => {
      // Scoreboard groups are keyed section:tier:SCOPE — collapsing scope produced
      // duplicate identically-named rows with contradictory results (last-wins).
      const key = g.scope ? `${g.section}|${g.tier}|${g.scope}` : `${g.section}|${g.tier}`;
      const baseName = ALGO_NAME[`${g.section}|${g.tier}`] || `${g.section}|${g.tier}`;
      const name = (g.scope ? `${baseName} · ${g.scope}` : baseName) + (g.tier === 'StrongSell' ? ' (short)' : '');
      const live = bestHorizon(g.horizons);
      const bt = btSummary && BT_TIER[`${g.section}|${g.tier}`] ? btSummary[BT_TIER[`${g.section}|${g.tier}`]] : null;
      const basis = bt ? 'backtest' : 'live';
      const score = bt ? bt.avgAlpha : (live ? live.avg : null);
      const n = bt ? bt.n : (live ? live.n : 0);
      const maturity = PROD_SECTIONS.has(g.section) ? 'production' : 'shadow';
      return { key, name, live, bt, basis, maturity, score, n, hasData: score != null, ranked: score != null && n >= MIN_RANKED_N };
    });
  // Confluence strategies (cached backtest): excess vs SPY ≈ alpha, beatRate ≈ win.
  for (const [k, a] of Object.entries(confAlgos || {})) {
    if (a.excess == null) continue;
    const n = a.n || 0;
    rows.push({ key: k, name: a.name, conf: a, basis: 'confluence', maturity: 'shadow', score: a.excess, n, hasData: true, ranked: n >= MIN_RANKED_N });
  }
  // Thin-sample rows sort BELOW every properly-evidenced row regardless of how good
  // their point estimate looks — a lucky handful of picks must not top the board.
  // Among ranked rows, order is basis-group first, score within basis.
  return rows.sort((a, b) => (b.ranked - a.ranked) || (b.hasData - a.hasData)
    || ((BASIS_ORDER[a.basis] ?? 9) - (BASIS_ORDER[b.basis] ?? 9))
    || ((b.score ?? -99) - (a.score ?? -99)));
}

function verdict(row) {
  if (!row.hasData) return ['building', 'var(--text-dim)', 'no resolved picks yet'];
  if (!row.ranked) return ['building', 'var(--text-dim)', `only ${row.n} resolved — too few to rank (needs ${MIN_RANKED_N})`];
  const bt = row.bt, live = row.live, cf = row.conf;
  if (cf) {
    const tag = `${cf.excess > 0 ? '+' : ''}${cf.excess}% excess, ${cf.beatRate}% beat (floor ${cf.wilsonLo}%, n${cf.n})`;
    if (cf.wilsonLo >= 50) return ['beating', 'var(--green)', tag];
    if (cf.beatRate >= 48) return ['inline', 'var(--amber,#f59e0b)', tag];
    return ['lagging', 'var(--red)', tag];
  }
  if (bt) {
    if (bt.avgAlpha > 0.2 && bt.winRate >= 48) return ['beating', 'var(--green)', `+${bt.avgAlpha}% alpha over ${bt.n} (3mo backtest)`];
    if (bt.avgAlpha > -0.5) return ['inline', 'var(--amber,#f59e0b)', `${bt.avgAlpha}% alpha — roughly tracking SPY`];
    return ['lagging', 'var(--red)', `${bt.avgAlpha}% alpha — trailing SPY (3mo backtest)`];
  }
  const lo = Math.round(wilsonLo(Math.round(live.winRate / 100 * live.n), live.n) * 100);
  if (live.avg > 0 && lo >= 50) return ['beating', 'var(--green)', `+${live.avg}% avg, ${live.winRate}% win (${live.horizon}, n${live.n})`];
  if (live.avg > -0.5) return ['inline', 'var(--amber,#f59e0b)', `${live.avg}% avg (${live.horizon}, n${live.n})`];
  return ['lagging', 'var(--red)', `${live.avg}% avg, ${live.winRate}% win (${live.horizon}, n${live.n})`];
}

const MEDAL = ['🥇', '🥈', '🥉'];
function row(r, i) {
  const [vk, col, detail] = verdict(r);
  const live = r.live;
  const matChip = r.maturity === 'production'
    ? `<span class="dt-tier-a" style="font-size:0.6rem" title="Registry maturity: production">production</span>`
    : `<span class="dt-dim" style="font-size:0.6rem;border:1px solid #64748b55;border-radius:4px;padding:0 4px" title="Registry maturity: shadow — zero live weight; this row is measurement, not clearance">shadow · 0 weight</span>`;
  const liveStr = live ? `<span class="lb-live">live: ${live.avg > 0 ? '+' : ''}${live.avg}% · ${live.winRate}% win <span class="dt-dim">(${live.horizon}, n${live.n})</span></span>` : `<span class="dt-dim">live: building</span>`;
  return `<div class="lb-row">`
    + `<div class="lb-rank">${r.ranked ? (MEDAL[i] || (i + 1)) : '·'}</div>`
    + `<div class="lb-mid"><div class="lb-name">${esc(r.name)} ${matChip}</div>`
    + `<div class="lb-detail" style="color:${col}">${detail}</div>${liveStr}</div>`
    + `<div class="lb-verdict" style="color:${col}">${vk}</div></div>`;
}

export async function loadLeaderboard(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Ranking the screener algos by realized performance…</p></div>`;
  let sb, bt, lb;
  try {
    [sb, bt, lb] = await Promise.all([
      fetchJSON('/api/tracker?op=scoreboard', { timeoutMs: HEAVY_TIMEOUT_MS }),
      fetchJSON('/api/backtest?scope=large&months=3', { timeoutMs: OPTIONAL_TIMEOUT_MS }).catch(() => null),
      fetchJSON('/api/tracker?op=leaderboard', { timeoutMs: OPTIONAL_TIMEOUT_MS }).catch(() => null),
    ]);
  } catch { sb = null; }
  if (!sb) { container.innerHTML = `<div class="dt-note">Couldn't load the leaderboard right now.</div>`; return; }
  const board = buildBoard(sb.groups, bt && bt.summary, lb && lb.algos);
  const withData = board.filter(r => r.hasData).length;

  let html = `<div class="rot-panel"><div class="rot-head">🏆 Which algos are actually working?</div>`
    + `<div class="rot-sub">The app's screener strategies, ranked by realized performance — <b>within</b> each metric basis (a live forward record, a 3-month ${L('backtest', 'backtest')} and a cached confluence backtest are different yardsticks and never share a rank). This board is <b>measurement only</b>: it feeds no ranking, no weights, and no candidate list — registry governance does that.</div></div>`;
  // Render grouped by basis; medals restart inside each basis so a backtest number
  // never outranks a live record (or vice versa) on an incomparable scalar.
  let lastBasis = null, medalIdx = 0;
  html += board.map(r => {
    let head = '';
    if (r.ranked && r.basis !== lastBasis) { lastBasis = r.basis; medalIdx = 0; head = `<div class="dt-dim" style="margin:8px 0 2px;font-size:0.66rem">${esc(BASIS_LABEL[r.basis] || r.basis)}</div>`; }
    return head + row(r, r.ranked ? medalIdx++ : 999);
  }).join('');
  html += `<div class="dt-note" style="margin-top:10px">⚠️ <b>Honest read:</b> most strategies sit at or below SPY out-of-sample (the project's recurring finding) — the leaderboard exists to surface the few that hold up and to keep grading them. Ranks update as live picks mature toward the full 3-month horizon. A strategy needs <b>${MIN_RANKED_N} resolved picks</b> before it can be ranked at all: a handful of lucky picks is not a track record, however good the average looks.</div>`;
  if (!withData) html += `<div class="dt-dim" style="margin-top:8px">Live records are still maturing; the 3-month backtest column fills the gap.</div>`;
  container.innerHTML = html;
}
