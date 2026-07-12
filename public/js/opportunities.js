// ⭐ OPPORTUNITIES — the app's answer to "what should I buy before it runs up?"
// Ranks the breakout screener's PRE-breakout names (quiet accumulation + tight
// setups, not yet extended) into one clear, conviction-ranked list with a plain-
// English thesis (for novices), entry/stop/target (for action), an expandable
// expert detail, and tap-to-learn on every term. Regime-gated — stands down when
// the backdrop is hostile (the project's one validated lever).
import { esc } from './format.js';
import { canonTheme, rankThemes, leadingThemeSet } from './themes.js';

const L = (term, txt) => `<span class="learn-term" data-learn="${term}">${txt}</span>`;

// Map the signals onto an "opportunity to buy early" score (0-100).
const GHOST_VAL = { GHOST: 95, STALKING: 78, WATCH: 55, PASS: 35 };   // accumulation strength
const STAGE_VAL = { Setup: 100, Early: 82, Breakout: 60 };            // earlier = more "before the run"
const STAGE_LABEL = { Setup: '🎯 Coiled setup', Early: '🌱 Early base', Breakout: '🚀 Breaking out' };
const GHOST_LABEL = { GHOST: 'heavy accumulation', STALKING: 'quiet accumulation', WATCH: 'early interest' };

// Build a per-(section|tier) reliability map from the live scoreboard, and a
// confidence-aware weight: the app literally uses its own realized results to tilt
// the ranking. Small samples → neutral (we don't over-trust a handful of picks).
export function buildReliability(groups) {
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

export function rankOpportunities(results, reliability = {}, healthFactor = 1, leadSet = new Set(), themeMom = {}) {
  return (results || [])
    .filter(c => c.levels && c.ghost && c.status && c.levels.entry > 0)
    .map(c => {
      const g = GHOST_VAL[c.ghost.tier] ?? 40;
      const stage = STAGE_VAL[c.status] ?? 60;
      const q = c.quant?.score ?? 0;
      const narr = Math.min((c.narrativeStrength ?? 0) * 10, 100);
      const conv = c.conviction?.score ?? 70;                  // the LEARNED conviction (recalibrated from resolved picks)
      const theme = canonTheme(c.theme, c.narrative, c.sector);
      const inLeadingTheme = leadSet.has(theme);
      // A name early in a HOT theme that hasn't run itself yet = the laggard play.
      const laggard = inLeadingTheme && (c.status === 'Setup' || c.status === 'Early') && (c.factors?.mom21 ?? 99) < 20;
      const themeBoost = inLeadingTheme ? (laggard ? 12 : 7) : 0;     // theme tailwind
      const sm = smartMoney(c);                                        // growth accel + insider + catalyst
      const ss = setupSignals(c);                                      // O'Neil/Minervini pre-breakout signals
      const base = 0.28 * q + 0.26 * g + 0.18 * stage + 0.12 * narr + 0.16 * conv + themeBoost + sm.boost + ss.boost;
      const rec = reliability[`Ghost|${c.ghost.tier}`];
      const opp = Math.round(base * relWeight(rec) * healthFactor);   // tilt by the model's live record + tier track record
      // Relative strength vs its OWN theme — leader or catch-up laggard.
      const tMom = themeMom[theme], myMom = c.factors?.mom63;
      let rsTheme = null;
      if (tMom != null && myMom != null && inLeadingTheme) rsTheme = myMom >= tMom * 1.1 ? 'leads' : myMom <= tMom * 0.6 ? 'lags' : null;
      const badges = [...ss.badges, ...sm.badges].slice(0, 5);         // institutional + smart-money, capped for a clean card
      return { ...c, opp, rec, theme: c.theme, canonTheme: theme, inLeadingTheme, laggard, smBadges: badges, rsTheme };
    })
    .sort((a, b) => b.opp - a.opp);
}

// Smart-money + fundamental-acceleration signals (the Python screener's growth
// filters, done with 2nd-derivative accel + insider flow + catalyst proximity).
function smartMoney(c) {
  const f = c.fundamentals || {}, ins = c.insider || {};
  const out = { boost: 0, badges: [] };
  // Growth quality & acceleration — the real pre-run-up fundamental tell.
  if ((f.revGrowth ?? 0) >= 25 || (f.revAccel ?? 0) > 5) out.boost += 4;
  if ((f.epsAccel ?? 0) > 10) out.boost += 3;
  if (f.marginExpanding) out.boost += 2;
  if (f.revGrowth != null) out.badges.push(`<span class="opp-sig sig-growth">📈 rev ${f.revGrowth > 0 ? '+' : ''}${Math.round(f.revGrowth)}%${(f.revAccel ?? 0) > 3 ? ' accel↑' : ''}</span>`);
  // Insider BUYING (rare, high-signal) — execs putting money in before the move.
  const net = ins.net?.value ?? 0;
  if (net > 100000) { out.boost += 5; out.badges.push(`<span class="opp-sig sig-insider">🟢 ${L('selflearning', 'insiders buying')}</span>`); }
  // Catalyst proximity — accumulating into an earnings catalyst.
  const days = f.earningsInDays;
  if (days != null && days >= 0 && days <= 35) out.badges.push(`<span class="opp-sig sig-cat">⏰ earnings in ${days}d</span>`);
  return out;
}

// Institutional setup-quality signals (O'Neil pocket pivot, Minervini VCP/VDU,
// RS-line new high, distance to 52w high) — the methodology elite growth funds use
// to catch a name in the last quiet moment BEFORE it breaks. All from c.metrics.
function setupSignals(c) {
  const m = c.metrics || {};
  const out = { boost: 0, badges: [] };
  if (m.pocketPivot) { out.boost += 4; out.badges.push(`<span class="opp-sig sig-pp">🟢 pocket pivot</span>`); }
  if (m.rsNewHigh) { out.boost += 3; out.badges.push(`<span class="opp-sig sig-rs2">💪 RS-line new high</span>`); }
  if (m.pctFrom52wHigh != null && m.pctFrom52wHigh <= 8) { out.boost += 3; out.badges.push(`<span class="opp-sig sig-hi">🎯 ${Math.round(m.pctFrom52wHigh)}% from 52w high</span>`); }
  if ((m.vcpContractions ?? 0) >= 2) { out.boost += 2; out.badges.push(`<span class="opp-sig sig-vcp">📐 VCP ×${m.vcpContractions}</span>`); }
  if (m.vdu || (m.volSurge != null && m.volSurge < 0.7)) out.badges.push(`<span class="opp-sig sig-vdu">🤫 volume dry-up</span>`);
  if ((m.accumRatio ?? 0) >= 1.5) out.badges.push(`<span class="opp-sig sig-acc">📊 accum ${m.accumRatio}×</span>`);
  return out;
}

export function conviction(opp) {
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
  const lag = c.laggard ? ` <b style="color:#f0a832">🔥 Laggard play:</b> its theme is running hard while this name hasn't — a potential catch-up.` : '';
  return `Smart money is showing ${L('accumulation', acc)} while price holds ${stage} — a name being bought ${L('ghost', 'before the obvious move')}. ${mom} (${c.quant?.score ?? '—'}/100).${lag}`;
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

// Volatility-adjusted position size — the desk-grade "risk a fixed % of account"
// rule: a tighter stop lets you hold MORE shares for the same dollar risk.
function sizing(lv) {
  if (!(lv.entry > 0) || !(lv.stop > 0) || lv.stop >= lv.entry) return '';
  const perShare = lv.entry - lv.stop;
  const rp = (perShare / lv.entry) * 100;
  const weight = Math.min(25, Math.max(2, Math.round(100 / rp)));         // 1% account risk → this % position, capped
  const shPer1k = Math.floor(1000 / perShare);
  return `<div class="opp-size">🎯 ${L('sizing', 'Size')}: stop <b>${rp.toFixed(1)}%</b> away → at 1% account risk, ≈<b>${weight}%</b> position (≈${shPer1k} sh per $1k risked).</div>`;
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

// The card BODY (badges → expert detail), shared by the Opportunities strip and the
// ⚡ Quick Hit shortlist so both render an identical thesis/levels/sizing block.
// WHY NOW verdict badge — the one-word, honest read composed server-side
// (api/screener → lib/whynow, the SAME logic the lookup modal uses). On curated
// card lists the baseline read is homogeneous, so the badge shows ONLY the two
// reads that carry information: a genuine standout (🔥 Prime — a confirmed
// breakout or top-quintile conviction) and a warning (⚠️ Caution — a risk-off /
// against read). Plain constructive, single-signal watch, and quiet all show
// nothing. Shared across every screener-driven card.
const WN_BADGE = {
  standout: { cls: 'wn-b-constructive', icon: '🔥', label: 'Prime' },
  caution:  { cls: 'wn-b-caution',      icon: '⚠️', label: 'Caution' },
};
export function whyNowBadge(c) {
  const w = c && c.whynow;
  if (!w) return '';
  const kind = w.level === 'caution' ? 'caution'
    : (w.level === 'constructive' && w.standout) ? 'standout'
    : null;                                   // watch / plain constructive / quiet → suppressed
  const b = kind && WN_BADGE[kind];
  if (!b) return '';
  return `<span class="wn-badge ${b.cls}" title="WHY NOW — ${esc(w.headline || '')}">${b.icon} ${b.label}</span>`;
}

export function oppCardInner(c) {
  return `<div class="opp-badges">${whyNowBadge(c)}<span class="opp-badge">${STAGE_LABEL[c.status] || c.status}</span>`
    + `<span class="opp-badge ghost-${(c.ghost.tier || '').toLowerCase()}">${L('ghost', c.ghost.tier)}</span>`
    + (c.conviction?.sleeveA ? `<span class="opp-badge opp-sleevea expert-only" title="Top-quintile by the results-trained conviction model">🏅 ${L('conviction', 'top-quintile')}</span>` : '')
    + (c.inLeadingTheme ? `<span class="opp-badge opp-theme-lead" title="In a leading theme">🔥 ${esc(c.canonTheme)}</span>` : `<span class="dt-dim">${esc(c.canonTheme || c.sector || '')}</span>`)
    + `</div>`
    + `<div class="opp-thesis">${thesis(c)}</div>`
    + proximity(c)
    + levelsRow(c.levels)
    + sizing(c.levels)
    + ((c.smBadges && c.smBadges.length) || c.rsTheme ? `<div class="opp-sigs expert-only">`
        + (c.rsTheme === 'leads' ? `<span class="opp-sig sig-rs-lead">⚡ ${L('relStrength', 'leads its theme')}</span>` : c.rsTheme === 'lags' ? `<span class="opp-sig sig-rs-lag">🐢 ${L('relStrength', 'lags its theme — catch-up')}</span>` : '')
        + (c.smBadges || []).join('') + `</div>` : '')
    + expertDetail(c);
}

function oppCard(c) {
  const cv = conviction(c.opp);
  return `<div class="opp-card" data-go="screener" data-opp="${esc(c.ticker)}">`
    + `<div class="opp-head">`
    + `<div class="opp-id"><span class="opp-tk" data-live="${esc(c.ticker)}">${esc(c.ticker)}</span> <span class="opp-co">${esc(c.company || '')}</span></div>`
    + `<div class="opp-conv" style="color:${cv.col}" title="${cv.label}">${cv.stars}</div></div>`
    + oppCardInner(c)
    + `</div>`;
}

// The 5 AI-reasoning screeners → their ACTIONABLE ("good class") picks, flattened for the
// Opportunities strip. Each maps to {src, ticker, note, score}. Cross-cutting: these names
// often aren't in the breakout pool, so they're shown as their own AI-signals section.
export const AI_SRC = {
  rt: ['🔗', 'Read-Through', 'readthrough'], an: ['🕵️', 'Stealth', 'anomaly'],
  sw: ['🌊', 'Second Wave', 'secondwave'], ca: ['🌐', 'Cross-Asset', 'crossasset'],
  ts: ['🎚️', 'Tone Shift', 'toneshift'],
};
export function collectAiSignals(c) {
  const out = [];
  const add = (src, ticker, note, score) => { if (ticker) out.push({ src, ticker: String(ticker).toUpperCase(), note: String(note || '').slice(0, 140), score: score || 0 }); };
  (c.rt && c.rt.items || []).filter(i => i.moved && i.moved.alreadyMoved === false).forEach(i => add('rt', i.beneficiary_ticker, `reads through from $${i.trigger_ticker} — ${i.mechanism || i.thesis || ''}`, i.directness));
  (c.an && c.an.items || []).filter(i => i.classification === 'ACCUMULATION').forEach(i => add('an', i.ticker, i.thesis || 'moving on volume, no catalyst found', i.confidence));
  (c.sw && c.sw.items || []).filter(i => i.classification === 'PRIMED').forEach(i => add('sw', i.ticker, i.catalyst || i.thesis || '', i.virality));
  (c.ca && c.ca.items || []).filter(i => i.classification === 'LEAD').forEach(i => add('ca', i.ticker, i.lead_asset || '', i.confidence));
  (c.ts && c.ts.items || []).filter(i => i.shift === 'BRIGHTENING').forEach(i => add('ts', i.ticker, i.change || '', i.confidence));
  return out.sort((a, b) => b.score - a.score);
}

export async function loadOpportunities(container, scope = 'large', limit = 6) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Finding the best setups to buy before they run…</p></div>`;
  let d, sb, drift, rt, an, sw, ca, ts;
  const j = op => fetch('/api/tracker?op=' + op).then(r => r.json()).catch(() => null);
  try {
    [d, sb, drift, rt, an, sw, ca, ts] = await Promise.all([
      fetch('/api/screener?scope=' + scope).then(r => r.json()),
      j('scoreboard'), j('drift'),
      j('readthrough'), j('anomaly'), j('secondwave'), j('crossasset'), j('toneshift'),
    ]);
  } catch { d = null; }
  if (!d) { container.innerHTML = `<div class="dt-note">Couldn't load opportunities right now.</div>`; return; }
  const regime = d.regime || {};
  const riskOff = regime.bearish === true || regime.riskOn === false;
  const reliability = buildReliability(sb && sb.groups);
  const health = modelHealth(drift);
  const themesRanked = rankThemes(d.results);
  const { set: leadSet, list: leadingThemes } = leadingThemeSet(themesRanked, 4);
  const themeMom = Object.fromEntries(themesRanked.map(t => [t.theme, t.mom63]));
  const ranked = rankOpportunities(d.results, reliability, health.factor, leadSet, themeMom);
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
  // 🔥 Leading themes strip — buy the laggard inside a running theme.
  if (leadingThemes.length) {
    html += `<div class="opp-themes"><span class="opp-themes-h">🔥 Leading themes</span>`
      + leadingThemes.map(t => `<span class="opp-theme-chip" title="${t.n} names · 3mo median ${t.mom63}%">${esc(t.theme)} <span class="opp-theme-mom">+${Math.round(t.mom63)}%</span></span>`).join('')
      + `<span class="dt-dim opp-themes-hint">· ⭐ below favors early names <b>in</b> these themes that haven't run yet</span></div>`;
  }
  html += `<div class="dt-note" style="border-left-color:${trackCol}">${trackLine}</div>`;
  html += top.length ? top.map(oppCard).join('') : `<div class="dt-note">No clean pre-breakout setups passed the screen today — that's normal on some days. Check back, or browse the full ${L('breakout', 'candidate screens')}.</div>`;

  // 🤖 AI Screeners strip — the actionable picks from the 5 AI-reasoning screeners (each a
  // different, non-price angle). Cross-cutting, so shown as their own section; every one is
  // a LEAD to forward-track, not a green light. Deduped by ticker (same name can appear
  // under two screeners = stronger).
  const ai = collectAiSignals({ rt, an, sw, ca, ts });
  if (ai.length) {
    const byTk = new Map();
    ai.forEach(s => { const cur = byTk.get(s.ticker) || { ticker: s.ticker, srcs: [], note: s.note, score: s.score }; cur.srcs.push(s.src); if (s.score > cur.score) { cur.score = s.score; cur.note = s.note; } byTk.set(s.ticker, cur); });
    const rows = [...byTk.values()].sort((a, b) => (b.srcs.length - a.srcs.length) || (b.score - a.score)).slice(0, 12);
    html += `<div class="rot-head" style="margin-top:16px">🤖 AI Screeners <span class="dt-dim">· cross-cutting signals from the 5 AI models — non-price angles, forward-tracked (not green lights)</span></div>`;
    html += `<div class="opp-ai">` + rows.map(r => {
      const badges = r.srcs.map(s => { const [e, lbl, tab] = AI_SRC[s]; return `<span class="opp-ai-src" data-go="${tab}" title="${esc(lbl)} — open tab">${e} ${esc(lbl)}</span>`; }).join('');
      return `<div class="opp-ai-row"><span class="opp-ai-tk">$${esc(r.ticker)}</span><span class="opp-ai-badges">${badges}</span><span class="opp-ai-note">${esc(r.note)}</span></div>`;
    }).join('') + `</div>`;
  }
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
