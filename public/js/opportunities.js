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

// Model health from the apex model's ALREADY-RESOLVED picks (op=drift). This is the
// loop operating NOW: the app grades its own recent picks and tilts accordingly.
export function modelHealth(drift) {
  const live = drift && drift.live;
  if (!live || (live.n || 0) < 10) return { factor: 1, n: live ? live.n : 0, state: 'building' };
  const base = (drift.baseline && drift.baseline.winRate) || 32;
  const ratio = (live.winRate || 0) / Math.max(base, 1);
  const factor = Math.max(0.82, Math.min(1.1, 0.72 + ratio * 0.38));   // underperforming → trim, beating → boost
  return { factor, n: live.n, live: live.winRate, base, degrading: ratio < 0.7, beating: ratio > 1.1, state: drift.status || (ratio < 0.7 ? 'degrading' : 'ok') };
}

export function rankOpportunities(results, reliability = {}, healthFactor = 1) {
  return (results || [])
    .filter(c => c.levels && c.ghost && c.status && c.levels.entry > 0)
    .map(c => {
      const g = GHOST_VAL[c.ghost.tier] ?? 40;
      const stage = STAGE_VAL[c.status] ?? 60;
      const q = c.quant?.score ?? 0;
      const narr = Math.min((c.narrativeStrength ?? 0) * 10, 100);
      const conv = c.conviction?.score ?? 70;                  // the LEARNED conviction (recalibrated from resolved picks)
      // Accumulation + early-stage + the results-trained conviction drive the score.
      const base = 0.28 * q + 0.26 * g + 0.18 * stage + 0.12 * narr + 0.16 * conv;
      const rec = reliability[`Ghost|${c.ghost.tier}`];
      const opp = Math.round(base * relWeight(rec) * healthFactor);   // tilt by the model's live record + tier track record
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

// How close is it to the buy trigger? The crux of "get in BEFORE it runs."
function proximity(c) {
  const px = c.price, entry = c.levels.entry;
  if (!(px > 0) || !(entry > 0)) return '';
  const pct = (entry / px - 1) * 100;
  if (pct > 1) return `<div class="opp-prox prox-coiled">🟢 <b>${pct.toFixed(1)}% below the buy trigger</b> ($${esc(entry)}) — room to position before it breaks.</div>`;
  if (pct >= -1) return `<div class="opp-prox prox-now">⚡ <b>Right at the trigger</b> ($${esc(entry)}) — breaking now; confirm on volume.</div>`;
  return `<div class="opp-prox prox-ext">🟡 <b>${Math.abs(pct).toFixed(1)}% past the trigger</b> — already moving; wait for a pullback toward $${esc(entry)}.</div>`;
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
    + (c.conviction?.sleeveA ? `<span class="opp-badge opp-sleevea" title="Top-quintile by the results-trained conviction model">🏅 ${L('conviction', 'top-quintile')}</span>` : '')
    + `<span class="dt-dim">${esc(c.sector || '')}</span></div>`
    + `<div class="opp-thesis">${thesis(c)}</div>`
    + proximity(c)
    + levelsRow(c.levels)
    + expertDetail(c)
    + `</div>`;
}

export async function loadOpportunities(container, scope = 'large', limit = 6) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Finding the best setups to buy before they run…</p></div>`;
  let d, sb, drift;
  try {
    [d, sb, drift] = await Promise.all([
      fetch('/api/screener?scope=' + scope).then(r => r.json()),
      fetch('/api/tracker?op=scoreboard').then(r => r.json()).catch(() => null),
      fetch('/api/tracker?op=drift').then(r => r.json()).catch(() => null),
    ]);
  } catch { d = null; }
  if (!d) { container.innerHTML = `<div class="dt-note">Couldn't load opportunities right now.</div>`; return; }
  const regime = d.regime || {};
  const riskOff = regime.bearish === true || regime.riskOn === false;
  const reliability = buildReliability(sb && sb.groups);
  const health = modelHealth(drift);
  const ranked = rankOpportunities(d.results, reliability, health.factor);
  const top = ranked.slice(0, limit);

  // Model-health line — the loop OPERATING now: the app grades its own resolved
  // picks and this ranking responds (down-weights when degrading, boosts when beating).
  let trackLine, trackCol;
  if (health.state === 'building') {
    const logged = (sb && sb.totalPicks) || 0;
    trackLine = `📊 The ranking self-tunes from results — ${logged} picks logged, ${health.n} resolved so far. As more mature it tilts harder.`;
    trackCol = 'var(--cyan)';
  } else if (health.degrading) {
    trackLine = `⚠️ <b>The model is grading its own recent picks as weak</b> — its last ${health.n} resolved won just <b>${health.live}%</b> vs a ${health.base}% baseline. This list is <b>down-weighted</b> and these are research ideas, not green lights — size down and lean on the ${L('regime', 'regime')}.`;
    trackCol = 'var(--red)';
  } else if (health.beating) {
    trackLine = `✅ <b>The model's recent picks are working</b> — its last ${health.n} resolved beat baseline (${health.live}% vs ${health.base}%). The ranking is leaning into it. Still confirm and use a ${L('stop', 'stop')}.`;
    trackCol = 'var(--green)';
  } else {
    trackLine = `📊 The model's recent picks are tracking baseline (${health.live}% over ${health.n} resolved). Ranking tilts live with each new result.`;
    trackCol = 'var(--cyan)';
  }

  let html = `<div class="rot-head" style="margin-top:4px">⭐ Top opportunities <span class="dt-dim">· quiet accumulation + early setups, ranked</span></div>`;
  if (riskOff) {
    html += `<div class="dt-note" style="border-left-color:var(--red)"><b>🛑 Risk-off backdrop — standing down.</b> The market is ${L('regime', 'risk-off')}; new long setups fail far more often here (the one thing this app has truly validated). The watchlist below is for when it turns — don't force it.</div>`;
  } else {
    html += `<div class="dt-note" style="border-left-color:var(--green)"><b>✅ Constructive backdrop.</b> Market is ${regime.riskOn ? L('regime', 'risk-on') : 'neutral'}${regime.breadthPct != null ? ` · breadth ${regime.breadthPct}%` : ''} — a reasonable environment to look for early longs. These are <b>pre-breakout</b> names (being accumulated, not yet extended), ranked by conviction.</div>`;
  }
  html += `<div class="dt-note" style="border-left-color:${trackCol}">${trackLine}</div>`;
  html += top.length ? top.map(oppCard).join('') : `<div class="dt-note">No clean pre-breakout setups passed the screen today — that's normal on some days. Check back, or browse the full ${L('breakout', 'screeners')}.</div>`;
  html += `<div class="dt-dim opp-foot">Scored on accumulation, setup stage, momentum &amp; the model's ${L('conviction', 'results-trained conviction')}, then tilted by how its own recent picks are actually resolving — so the ranking adapts as results come in. Not advice; always confirm and use a ${L('stop', 'stop')}.</div>`;
  container.innerHTML = html;
}

// Dedicated tab: a cap-size toggle (where the big early runs live) + the full list.
const SCOPES = [['large', 'S&P 500'], ['small', 'Small caps'], ['micro', 'Micro caps']];
export function mountOpportunitiesTab(container, onReady) {
  if (!container) return;
  let scope = 'large';
  try { const s = localStorage.getItem('oppScope'); if (s && SCOPES.some(x => x[0] === s)) scope = s; } catch {}
  container.innerHTML = `<div class="opp-scope-row">${SCOPES.map(([v, lbl]) =>
    `<button class="opp-scope-btn ${v === scope ? 'active' : ''}" data-scope="${v}">${lbl}</button>`).join('')}
    <span class="dt-dim opp-scope-hint">· small &amp; micro caps run the hardest</span></div><div id="opp-body" class="opp-wrap"></div>`;
  const body = container.querySelector('#opp-body');
  const run = sc => loadOpportunities(body, sc, 12).then(() => onReady && onReady(body));
  container.querySelectorAll('.opp-scope-btn').forEach(b => b.addEventListener('click', () => {
    scope = b.dataset.scope;
    try { localStorage.setItem('oppScope', scope); } catch {}
    container.querySelectorAll('.opp-scope-btn').forEach(x => x.classList.toggle('active', x === b));
    run(scope);
  }));
  run(scope);
}
