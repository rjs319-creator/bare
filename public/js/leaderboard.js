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
export function buildBoard(groups, btSummary, confAlgos) {
  const rows = (groups || []).map(g => {
    const key = `${g.section}|${g.tier}`;
    const live = bestHorizon(g.horizons);
    const bt = btSummary && BT_TIER[key] ? btSummary[BT_TIER[key]] : null;
    const score = bt ? bt.avgAlpha : (live ? live.avg : null);
    const n = bt ? bt.n : (live ? live.n : 0);
    return { key, name: ALGO_NAME[key] || key, live, bt, score, n, hasData: score != null, ranked: score != null && n >= MIN_RANKED_N };
  });
  // Confluence strategies (cached backtest): excess vs SPY ≈ alpha, beatRate ≈ win.
  for (const [k, a] of Object.entries(confAlgos || {})) {
    if (a.excess == null) continue;
    const n = a.n || 0;
    rows.push({ key: k, name: a.name, conf: a, score: a.excess, n, hasData: true, ranked: n >= MIN_RANKED_N });
  }
  // Thin-sample rows sort BELOW every properly-evidenced row regardless of how good
  // their point estimate looks — a lucky handful of picks must not top the board.
  return rows.sort((a, b) => (b.ranked - a.ranked) || (b.hasData - a.hasData) || ((b.score ?? -99) - (a.score ?? -99)));
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
  const liveStr = live ? `<span class="lb-live">live: ${live.avg > 0 ? '+' : ''}${live.avg}% · ${live.winRate}% win <span class="dt-dim">(${live.horizon}, n${live.n})</span></span>` : `<span class="dt-dim">live: building</span>`;
  return `<div class="lb-row">`
    + `<div class="lb-rank">${r.ranked ? (MEDAL[i] || (i + 1)) : '·'}</div>`
    + `<div class="lb-mid"><div class="lb-name">${esc(r.name)}</div>`
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
    + `<div class="rot-sub">The app's screener strategies, ranked by realized performance — the trailing <b>3-month ${L('backtest', 'backtest')}</b> ${L('beatRate', 'alpha')} where available, plus each algo's <b>live</b> forward record as it matures. This is the validation surface that re-weights the ${L('selflearning', 'Opportunities')} ranking.</div></div>`;
  html += board.map(row).join('');
  html += `<div class="dt-note" style="margin-top:10px">⚠️ <b>Honest read:</b> most strategies sit at or below SPY out-of-sample (the project's recurring finding) — the leaderboard exists to surface the few that hold up and to keep grading them. Ranks update as live picks mature toward the full 3-month horizon. A strategy needs <b>${MIN_RANKED_N} resolved picks</b> before it can be ranked at all: a handful of lucky picks is not a track record, however good the average looks.</div>`;
  if (!withData) html += `<div class="dt-dim" style="margin-top:8px">Live records are still maturing; the 3-month backtest column fills the gap.</div>`;
  container.innerHTML = html;
}
