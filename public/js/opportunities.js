// ⭐ OPPORTUNITIES — the app's answer to "what should I buy before it runs up?"
// Ranks the breakout screener's PRE-breakout names (quiet accumulation + tight
// setups, not yet extended) into one clear, conviction-ranked list with a plain-
// English thesis (for novices), entry/stop/target (for action), an expandable
// expert detail, and tap-to-learn on every term. Regime-gated — stands down when
// the backdrop is hostile (the project's one validated lever).
import { esc } from './format.js';

const L = (term, txt) => `<span class="learn-term" data-learn="${term}">${txt}</span>`;

// Map the signals onto an "opportunity to buy early" score (0-100).
const GHOST_VAL = { GHOST: 95, STALKING: 78, WATCH: 55, PASS: 35 };   // accumulation strength
const STAGE_VAL = { Setup: 100, Early: 82, Breakout: 60 };            // earlier = more "before the run"
const STAGE_LABEL = { Setup: '🎯 Coiled setup', Early: '🌱 Early base', Breakout: '🚀 Breaking out' };
const GHOST_LABEL = { GHOST: 'heavy accumulation', STALKING: 'quiet accumulation', WATCH: 'early interest' };

// Build a per-(section|tier) reliability map from the live scoreboard, and a
// confidence-aware weight: the app literally uses its own realized results to tilt
// the ranking. Small samples → neutral (we don't over-trust a handful of picks).
function buildReliability(groups) {
  const map = {};
  (groups || []).forEach(g => {
    const h = g.horizons || {};
    const best = h['1m'] || h['1w'] || h['3m'] || null;
    map[`${g.section}|${g.tier}`] = best ? { avg: best.avg, winRate: best.winRate, n: best.n } : { n: 0 };
  });
  return map;
}
function relWeight(rec) {
  if (!rec || (rec.n || 0) < 8) return 1;                       // not enough data → neutral
  const a = rec.avg || 0, w = (rec.winRate || 50) - 50;
  return 1 + Math.max(-0.15, Math.min(0.2, a * 0.02 + w * 0.004));  // beating → boost, losing → trim
}

export function rankOpportunities(results, reliability = {}) {
  return (results || [])
    .filter(c => c.levels && c.ghost && c.status && c.levels.entry > 0)
    .map(c => {
      const g = GHOST_VAL[c.ghost.tier] ?? 40;
      const stage = STAGE_VAL[c.status] ?? 60;
      const q = c.quant?.score ?? 0;
      const narr = Math.min((c.narrativeStrength ?? 0) * 10, 100);
      // Accumulation + early-stage weighted heaviest — that's the "before it runs" edge.
      const base = 0.34 * q + 0.30 * g + 0.21 * stage + 0.15 * narr;
      const rec = reliability[`Ghost|${c.ghost.tier}`];
      const opp = Math.round(base * relWeight(rec));            // tilt by the live track record
      return { ...c, opp, rec };
    })
    .sort((a, b) => b.opp - a.opp);
}

function conviction(opp) {
  if (opp >= 80) return { label: 'High conviction', col: 'var(--green)', stars: '⭐⭐⭐' };
  if (opp >= 68) return { label: 'Solid setup', col: 'var(--amber,#f59e0b)', stars: '⭐⭐' };
  return { label: 'On watch', col: 'var(--text-dim)', stars: '⭐' };
}

function thesis(c) {
  const acc = GHOST_LABEL[c.ghost.tier] || 'building interest';
  const stage = c.status === 'Setup' ? 'a tight base, coiled to break'
    : c.status === 'Early' ? 'an early base — more room before it moves'
    : 'breaking out right now';
  const mom = (c.quant?.score ?? 0) >= 85 ? 'top-tier momentum quality'
    : (c.quant?.score ?? 0) >= 70 ? 'strong momentum quality' : 'building momentum';
  const story = (c.narrativeStrength >= 6 && c.theme) ? ` <span class="dt-dim">Story: ${esc(c.theme)}.</span>` : '';
  return `Smart money is showing ${L('accumulation', acc)} while price holds ${stage} — a name being bought ${L('ghost', 'before the obvious move')}. ${mom} (${c.quant?.score ?? '—'}/100).${story}`;
}

function levelsRow(lv) {
  const rr = lv.rr ? `${L('rr', lv.rr + ':1 R:R')}` : '';
  return `<div class="opp-levels">`
    + `<span><span class="opp-lk">${L('entry', 'Entry')}</span> <b>$${esc(lv.entry)}</b></span>`
    + `<span><span class="opp-lk">${L('stop', 'Stop')}</span> <b>$${esc(lv.stop)}</b></span>`
    + `<span><span class="opp-lk">${L('target', 'Target')}</span> <b>$${esc(lv.target)}</b></span>`
    + (rr ? `<span class="opp-rr">${rr}</span>` : '') + `</div>`;
}

function expertDetail(c) {
  const f = c.factors || {};
  const moms = [f.mom21 != null ? `1m ${f.mom21 > 0 ? '+' : ''}${f.mom21}%` : null, f.mom63 != null ? `3m ${f.mom63 > 0 ? '+' : ''}${f.mom63}%` : null, f.mom126 != null ? `6m ${f.mom126 > 0 ? '+' : ''}${f.mom126}%` : null].filter(Boolean).join(' · ');
  const strong = c.ghost.strongPillars != null ? `${c.ghost.strongPillars}/6 ${L('accumulation', 'accumulation pillars')} strong` : '';
  return `<div class="opp-expert expert-only">`
    + `<div>${L('score', 'Quant')} ${c.quant?.score ?? '—'}/100 · ${L('accumulation', 'GAI')} ${c.ghost.score ?? '—'}/100 · ${strong}</div>`
    + (moms ? `<div class="dt-dim">${L('momentum', 'Momentum')}: ${moms}</div>` : '')
    + (c.narrative ? `<div class="dt-dim">${esc(c.narrative)}</div>` : '') + `</div>`;
}

function oppCard(c) {
  const cv = conviction(c.opp);
  return `<div class="opp-card" data-go="screener" data-opp="${esc(c.ticker)}">`
    + `<div class="opp-head">`
    + `<div class="opp-id"><span class="opp-tk" data-live="${esc(c.ticker)}">${esc(c.ticker)}</span> <span class="opp-co">${esc(c.company || '')}</span></div>`
    + `<div class="opp-conv" style="color:${cv.col}" title="${cv.label}">${cv.stars}</div></div>`
    + `<div class="opp-badges"><span class="opp-badge">${STAGE_LABEL[c.status] || c.status}</span>`
    + `<span class="opp-badge ghost-${(c.ghost.tier || '').toLowerCase()}">${L('ghost', c.ghost.tier)}</span>`
    + `<span class="dt-dim">${esc(c.sector || '')}</span></div>`
    + `<div class="opp-thesis">${thesis(c)}</div>`
    + levelsRow(c.levels)
    + expertDetail(c)
    + `</div>`;
}

export async function loadOpportunities(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Finding the best setups to buy before they run…</p></div>`;
  let d, sb;
  try {
    [d, sb] = await Promise.all([
      fetch('/api/screener?scope=large').then(r => r.json()),
      fetch('/api/tracker?op=scoreboard').then(r => r.json()).catch(() => null),
    ]);
  } catch { d = null; }
  if (!d) { container.innerHTML = `<div class="dt-note">Couldn't load opportunities right now.</div>`; return; }
  const regime = d.regime || {};
  const riskOff = regime.bearish === true || regime.riskOn === false;
  const reliability = buildReliability(sb && sb.groups);
  const ranked = rankOpportunities(d.results, reliability);
  const top = ranked.slice(0, 6);

  // Honest track-record line for the accumulation signal these are ranked on.
  const accRecs = ['Ghost|GHOST', 'Ghost|STALKING'].map(k => reliability[k]).filter(r => r && r.n >= 8);
  let trackLine;
  if (accRecs.length) {
    const tot = accRecs.reduce((a, r) => ({ n: a.n + r.n, sum: a.sum + r.avg * r.n }), { n: 0, sum: 0 });
    const avg = tot.sum / tot.n;
    trackLine = `📊 Live track record: accumulation picks have averaged <b style="color:${avg > 0 ? 'var(--green)' : 'var(--red)'}">${avg > 0 ? '+' : ''}${avg.toFixed(1)}%</b> over ${tot.n} resolved (1mo) — the ranking is tilted by this.`;
  } else {
    const logged = (sb && sb.totalPicks) || 0;
    trackLine = `📊 Track record building — ${logged} picks logged; forward returns mature over weeks, then auto-tilt this ranking.`;
  }

  let html = `<div class="rot-head" style="margin-top:4px">⭐ Top opportunities <span class="dt-dim">· quiet accumulation + early setups, ranked</span></div>`;
  if (riskOff) {
    html += `<div class="dt-note" style="border-left-color:var(--red)"><b>🛑 Risk-off backdrop — standing down.</b> The market is ${L('regime', 'risk-off')}; new long setups fail far more often here (the one thing this app has truly validated). The watchlist below is for when it turns — don't force it.</div>`;
  } else {
    html += `<div class="dt-note" style="border-left-color:var(--green)"><b>✅ Constructive backdrop.</b> Market is ${regime.riskOn ? L('regime', 'risk-on') : 'neutral'}${regime.breadthPct != null ? ` · breadth ${regime.breadthPct}%` : ''} — a reasonable environment to look for early longs. These are <b>pre-breakout</b> names (being accumulated, not yet extended), ranked by conviction.</div>`;
  }
  html += `<div class="dt-note" style="border-left-color:var(--cyan)">${trackLine}</div>`;
  html += top.length ? top.map(oppCard).join('') : `<div class="dt-note">No clean pre-breakout setups passed the screen today — that's normal on some days. Check back, or browse the full ${L('breakout', 'screeners')}.</div>`;
  html += `<div class="dt-dim opp-foot">Ranked by accumulation strength, setup stage, momentum quality &amp; story — then tilted by each signal's live ${L('beatRate', 'track record')}. Not advice; always confirm and use a ${L('stop', 'stop')}.</div>`;
  container.innerHTML = html;
}
