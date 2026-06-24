// 🏆 ALGO LEADERBOARD — ranks the app's screener strategies by realized
// performance so the top performers surface and the laggards are obvious. Pulls
// the live forward-tracked scoreboard (matures toward 3-month) AND the trailing
// 3-month backtest, presents both honestly, and is the ongoing validation surface
// that feeds the self-improving Opportunities ranking.
import { esc } from './format.js';

const L = (term, txt) => `<span class="learn-term" data-learn="${term}">${txt}</span>`;

const ALGO_NAME = {
  'screener|Breakout': '🔎 Breakout', 'screener|Setup': '🔎 Breakout · Setup', 'screener|Early': '🔎 Breakout · Early',
  'Ghost|GHOST': '👻 Ghost · heavy accum', 'Ghost|STALKING': '👻 Ghost · stalking',
  'momentum|StrongBuy': '🔥 Momentum · buy', 'momentum|StrongSell': '🔥 Momentum · short',
};
const BT_TIER = { 'screener|Breakout': 'Breakout', 'screener|Setup': 'Setup', 'screener|Early': 'Early' };

function bestHorizon(h) {
  for (const k of ['3m', '1m', '1w']) if (h && h[k] && h[k].n >= 1) return { ...h[k], horizon: k };
  return null;
}
function wilsonLo(w, n, z = 1.645) {
  if (!n) return 0; const p = w / n, d = 1 + z * z / n;
  return Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d);
}

// Build the ranked board from scoreboard groups + the 3-month backtest summary.
export function buildBoard(groups, btSummary) {
  const rows = (groups || []).map(g => {
    const key = `${g.section}|${g.tier}`;
    const live = bestHorizon(g.horizons);
    const bt = btSummary && BT_TIER[key] ? btSummary[BT_TIER[key]] : null;   // trailing-3mo backtest
    // Rank metric: prefer the realized 3-month backtest alpha (true "last 3 months"),
    // else the live forward avg return. Confidence-weighted by sample.
    const score = bt ? bt.avgAlpha : (live ? live.avg : null);
    return {
      key, name: ALGO_NAME[key] || key, live, bt, score,
      n: bt ? bt.n : (live ? live.n : 0),
      hasData: score != null,
    };
  });
  // Algos with data first, ranked by score desc; thin/no-data sink.
  return rows.sort((a, b) => (b.hasData - a.hasData) || ((b.score ?? -99) - (a.score ?? -99)));
}

function verdict(row) {
  if (!row.hasData) return ['building', 'var(--text-dim)', 'no resolved picks yet'];
  const bt = row.bt, live = row.live;
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
    + `<div class="lb-rank">${r.hasData ? (MEDAL[i] || (i + 1)) : '·'}</div>`
    + `<div class="lb-mid"><div class="lb-name">${esc(r.name)}</div>`
    + `<div class="lb-detail" style="color:${col}">${detail}</div>${liveStr}</div>`
    + `<div class="lb-verdict" style="color:${col}">${vk}</div></div>`;
}

export async function loadLeaderboard(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Ranking the screener algos by realized performance…</p></div>`;
  let sb, bt;
  try {
    [sb, bt] = await Promise.all([
      fetch('/api/tracker?op=scoreboard').then(r => r.json()),
      fetch('/api/backtest?scope=large&months=3').then(r => r.json()).catch(() => null),
    ]);
  } catch { sb = null; }
  if (!sb) { container.innerHTML = `<div class="dt-note">Couldn't load the leaderboard right now.</div>`; return; }
  const board = buildBoard(sb.groups, bt && bt.summary);
  const withData = board.filter(r => r.hasData).length;

  let html = `<div class="rot-panel"><div class="rot-head">🏆 Which algos are actually working?</div>`
    + `<div class="rot-sub">The app's screener strategies, ranked by realized performance — the trailing <b>3-month ${L('backtest', 'backtest')}</b> ${L('beatRate', 'alpha')} where available, plus each algo's <b>live</b> forward record as it matures. This is the validation surface that re-weights the ${L('selflearning', 'Opportunities')} ranking.</div></div>`;
  html += board.map(row).join('');
  html += `<div class="dt-note" style="margin-top:10px">⚠️ <b>Honest read:</b> most strategies sit at or below SPY out-of-sample (the project's recurring finding) — the leaderboard exists to surface the few that hold up and to keep grading them. Ranks update as live picks mature toward the full 3-month horizon.</div>`;
  if (!withData) html += `<div class="dt-dim" style="margin-top:8px">Live records are still maturing; the 3-month backtest column fills the gap.</div>`;
  container.innerHTML = html;
}
