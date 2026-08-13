// ⭐ OPPORTUNITIES — the app's answer to "what should I buy before it runs up?"
// Ranks the breakout screener's PRE-breakout names (quiet accumulation + tight
// setups, not yet extended) into one clear, conviction-ranked list with a plain-
// English thesis (for novices), entry/stop/target (for action), an expandable
// expert detail, and tap-to-learn on every term. Regime-gated — stands down when
// the backdrop is hostile (the project's one validated lever).
import { esc } from './format.js';
import { fetchJSON } from './fetch-json.js';
import { canonTheme, rankThemes, leadingThemeSet } from './themes.js';

const L = (term, txt) => `<span class="learn-term" data-learn="${term}">${txt}</span>`;

// Map the signals onto an "opportunity to buy early" score (0-100).
const GHOST_VAL = { GHOST: 95, STALKING: 78, WATCH: 55, PASS: 35 };   // accumulation strength
const STAGE_VAL = { Setup: 100, Early: 82, Breakout: 60 };            // earlier = more "before the run"
const STAGE_LABEL = { Setup: '🎯 Coiled setup', Early: '🌱 Early base', Breakout: '🚀 Breaking out' };
const GHOST_LABEL = { GHOST: 'heavy accumulation', STALKING: 'quiet accumulation', WATCH: 'early interest' };

// Build a per-(section|tier|scope) reliability map from the live scoreboard.
// Scoreboard groups are keyed section:tier:SCOPE — collapsing to section|tier let a
// micro-scope record overwrite (last-wins) the large-cap one and tilt the wrong cards
// (RT-07). The key now carries scope; the map is DISPLAY-ONLY (track-record line on
// the card) and no longer tilts the rank (RT-01).
export const relKey = (section, tier, scope) => `${section}|${tier}|${scope || ''}`;
export function buildReliability(groups) {
  const map = {};
  (groups || []).forEach(g => {
    const h = g.horizons || {};
    const best = h['1m'] || h['1w'] || h['3m'] || null;
    map[relKey(g.section, g.tier, g.scope)] = best ? { avg: best.avg, winRate: best.winRate, n: best.n } : { n: 0 };
  });
  return map;
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

// GOVERNANCE (graduation-league RT-01): this rank was weighted 0.26 by Ghost's tier,
// 0.16 by the conviction sleeve, tilted by a per-Ghost-tier reliability weight and
// scaled by the Apex drift healthFactor. Ghost, conviction and Apex are all registry
// SHADOW strategies with zero cleared weight (conviction's registry entry says
// outright that no user-facing rank may consume it), so every one of those terms was
// a zero-weight strategy reordering a user-facing buy list. The rank below is
// invariant to shadow-strategy inputs: quant + stage + narrative + non-strategy
// signals only. Ghost/conviction remain visible as labeled annotations; their terms
// return only via a registry promotion, never a client edit.
export function rankOpportunities(results, reliability = {}, healthFactor = 1, leadSet = new Set(), themeMom = {}) {
  return (results || [])
    .filter(c => c.levels && c.status && c.levels.entry > 0)
    .map(c => {
      const stage = STAGE_VAL[c.status] ?? 60;
      const q = c.quant?.score ?? 0;
      const narr = Math.min((c.narrativeStrength ?? 0) * 10, 100);
      const theme = canonTheme(c.theme, c.narrative, c.sector);
      const inLeadingTheme = leadSet.has(theme);
      // A name early in a HOT theme that hasn't run itself yet = the laggard play.
      const laggard = inLeadingTheme && (c.status === 'Setup' || c.status === 'Early') && (c.factors?.mom21 ?? 99) < 20;
      const themeBoost = inLeadingTheme ? (laggard ? 12 : 7) : 0;     // theme tailwind
      const sm = smartMoney(c);                                        // growth accel + insider + catalyst
      const ss = setupSignals(c);                                      // O'Neil/Minervini pre-breakout signals
      // Weights renormalized from the pre-RT-01 non-shadow terms (0.28q/0.18stage/0.12narr).
      const base = 0.48 * q + 0.31 * stage + 0.21 * narr + themeBoost + sm.boost + ss.boost;
      const rec = c.ghost ? reliability[relKey('Ghost', c.ghost.tier, c.scope)] : null;   // display-only track record, scope-matched
      const opp = Math.round(base);
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
  const acc = GHOST_LABEL[c.ghost?.tier] || 'building interest';
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
  if (pct > 1) return `<div class="opp-prox prox-coiled">🟢 <b>${pct.toFixed(1)}% below the breakout trigger</b> ($${esc(entry)}) — setup still forming.</div>`;
  if (pct >= -1) return `<div class="opp-prox prox-now">⚡ <b>Right at the trigger</b> ($${esc(entry)}) — breaking now; volume confirms or denies.</div>`;
  return `<div class="opp-prox prox-ext">🟡 <b>${Math.abs(pct).toFixed(1)}% past the trigger</b> — already moving; extended vs the level.</div>`;
}

// Risk geometry only — NO suggested position size. The screener behind these cards is
// paper/research under governance (no cleared sizing weight), so publishing a "% position"
// here would be an unsupported recommendation. Stop distance is a fact about the setup;
// a size is a claim about edge, and that claim has not been earned.
function sizing(lv) {
  if (!(lv.entry > 0) || !(lv.stop > 0) || lv.stop >= lv.entry) return '';
  const rp = ((lv.entry - lv.stop) / lv.entry) * 100;
  return `<div class="opp-size">🎯 ${L('sizing', 'Risk')}: stop <b>${rp.toFixed(1)}%</b> below entry · <span class="opp-sizenote">not sized — research signal (no governance clearance)</span></div>`;
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
  const strong = c.ghost?.strongPillars != null ? `${c.ghost.strongPillars}/6 ${L('accumulation', 'accumulation pillars')} strong` : '';
  return `<div class="opp-expert expert-only">`
    + `<div>${L('score', 'Quant')} ${c.quant?.score ?? '—'}/100 · ${L('accumulation', 'GAI')} ${c.ghost?.score ?? '—'}/100 · ${strong}</div>`
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

// Evidence-based track line (#3): the realized forward record of THIS setup class from
// the live Scoreboard (c.rec = reliability[Ghost|tier]). Never fabricates — shows an
// explicit "insufficient data" state below the 8-pick trust floor.
function oppTrack(c) {
  const r = c.rec;
  if (!r || (r.n || 0) < 8) return `<div class="opp-track dt-dim">📊 Track record: insufficient data yet${r && r.n ? ` (n=${r.n})` : ''}</div>`;
  const col = (r.avg ?? 0) >= 0 ? 'opp-pos' : 'opp-neg';
  const winTxt = r.winRate != null ? `${r.winRate}% win` : '';
  const avgTxt = r.avg != null ? `${r.avg > 0 ? '+' : ''}${r.avg}% avg` : '';
  return `<div class="opp-track ${col}">📊 This setup class: ${[winTxt, avgTxt].filter(Boolean).join(' · ')} (1m) · n=${r.n} `
    + `<span class="dt-dim">— realized forward return, not a forecast</span></div>`;
}

export function oppCardInner(c) {
  return `<div class="opp-badges">${whyNowBadge(c)}<span class="opp-badge">${STAGE_LABEL[c.status] || c.status}</span>`
    // Ghost is a labeled shadow-strategy ANNOTATION (it neither gates admission nor
    // weighs the rank — RT-01). The conviction sleeveA badge is gone entirely: the
    // registry forbids any user-facing badge consuming the frozen shadow benchmark.
    + (c.ghost ? `<span class="opp-badge ghost-${(c.ghost.tier || '').toLowerCase()}" title="Ghost accumulation read — registry shadow (zero weight): shown as context, does not affect this ranking">${L('ghost', c.ghost.tier)}</span>` : '')
    + (c.inLeadingTheme ? `<span class="opp-badge opp-theme-lead" title="In a leading theme">🔥 ${esc(c.canonTheme)}</span>` : `<span class="dt-dim">${esc(c.canonTheme || c.sector || '')}</span>`)
    + `</div>`
    + `<div class="opp-thesis">${thesis(c)}</div>`
    + proximity(c)
    + levelsRow(c.levels)
    + sizing(c.levels)
    + oppTrack(c)
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
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Ranking research candidates — quiet accumulation + early bases…</p></div>`;
  let d, sb, drift, rt, an, sw, ca, ts;
  const j = op => fetchJSON('/api/tracker?op=' + op).catch(() => null);
  try {
    [d, sb, drift, rt, an, sw, ca, ts] = await Promise.all([
      fetchJSON('/api/screener?scope=' + scope),
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

  // Model-health line — DIAGNOSTIC ONLY. The Apex drift read comes from a registry-
  // shadow model, so it no longer scales or reorders this list (RT-01); it is shown
  // as context the same way the regime banner is.
  let trackLine, trackCol;
  if (health.state === 'building') {
    const logged = (sb && sb.totalPicks) || 0;
    trackLine = `📊 Track-record context: ${logged} picks logged, ${health.n} resolved so far. Shown for context — it does not change this ranking.`;
    trackCol = 'var(--cyan)';
  } else if (health.degrading) {
    trackLine = `⚠️ <b>Recent resolved picks from the shadow drift monitor look weak</b> — last ${health.n} resolved won <b>${health.live}%</b> vs a ${health.base}% reference. Context only (it does not change this ranking) — be more selective and lean on the ${L('regime', 'regime')}.`;
    trackCol = 'var(--red)';
  } else if (health.beating) {
    trackLine = `✅ Recent resolved picks from the shadow drift monitor are beating their reference (${health.live}% vs ${health.base}% over ${health.n}). Context only — still confirm and use a ${L('stop', 'stop')}.`;
    trackCol = 'var(--green)';
  } else {
    trackLine = `📊 Recent resolved picks are tracking their reference (${health.live}% over ${health.n} resolved). Context only — it does not change this ranking.`;
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
  html += `<div class="dt-dim opp-foot">Scored on accumulation, setup stage, momentum &amp; the model's ${L('conviction', 'results-trained conviction')}. Per-name order is tilted by each Ghost-tier's own resolved record; the whole list's conviction is then dialed by the model's live results (a uniform scalar — it does not reorder the names). Algorithm-specific, evidence-gated reranking lives in the 📋 Swing Supervisor. Not advice; always confirm and use a ${L('stop', 'stop')}.</div>`;
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
