// FADE ENGINE v2 — the self-improving layer over the inverted-V SHORT.
// Upgrades over v1:
//   • CONTINUOUS-ALPHA posterior (not binary beat/miss). Each resolved trade
//     contributes its market-neutral short alpha (%); we keep decayed sufficient
//     statistics (W, Σx, Σx²) per stock and shrink the stock mean toward its group
//     mean toward the global mean (Normal-Normal / James-Stein). This gives an
//     EXPECTED RETURN per name, P(edge>0), and proper conviction — far more
//     information than a hit-rate.
//   • HIERARCHICAL GROUP POOLING by SECTOR × BETA-BUCKET. A brand-new name with no
//     history inherits its group's prior immediately (cold-start fix) instead of
//     the bland global mean — the engine already learned defensives/low-beta fade
//     better, so a new REIT should start there.
//   • Recency DECAY (continuous adaptation) + CUSUM drift auto-suspend, as v1.
// Plain JSON state → serialize()/load() round-trips to Blob.

const GLOBAL_PRIOR = {
  decay: 0.985,        // recency forgetting per update cycle (eff. memory ~1/(1-d))
  kStock: 10,          // pseudo-obs: stock shrinks to its group mean
  kGroup: 8,           // pseudo-obs: group shrinks to the global mean
  driftThreshold: 4,   // CUSUM trip → auto-suspend
  cusumSlack: 0.5,     // only standardized misses beyond this accumulate
  minWeff: 5,          // effective obs needed for a high-conviction call
  clipPct: 25,         // winsorize per-trade alpha to ±25% (fat-tail robustness)
  defaultSigmaPct: 8,  // fallback per-trade alpha sd before data exists
  assumedCostPct: 0.32,// realistic round-trip cost (borrow+txn) for the net estimate
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const betaBucket = b => (b == null ? 'mid' : b < 0.85 ? 'low' : b > 1.2 ? 'high' : 'mid');
const groupKey = (sector, beta) => `${sector || '?'}|${betaBucket(beta)}`;

// Standard normal CDF (Abramowitz-Stegun 26.2.17).
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

const newAcc = () => ({ W: 0, Sx: 0, Sxx: 0, Wpos: 0 });
const decayAcc = (a, d) => { a.W *= d; a.Sx *= d; a.Sxx *= d; a.Wpos *= d; };
const addAcc = (a, x) => { a.W += 1; a.Sx += x; a.Sxx += x * x; a.Wpos += x > 0 ? 1 : 0; };
const accMean = a => (a.W > 0 ? a.Sx / a.W : 0);
const accBeat = a => (a.W > 0 ? a.Wpos / a.W : 0.5);
const accVar = (a, dflt) => (a.W > 1 ? Math.max(1e-4, a.Sxx / a.W - accMean(a) ** 2) : dflt * dflt);
const shrink = (x, prior, n, k) => (n * x + k * prior) / (n + k);

function emptyState() {
  return { global: newAcc(), groups: {}, stocks: {}, updatedAt: null, cfg: { ...GLOBAL_PRIOR } };
}

function load(json) {
  // v1 state had global.{a,b}; v2 uses global.{W,...}. Old shape → fresh (re-seed).
  if (!json || !json.global || json.global.W == null) return emptyState();
  return { global: json.global, groups: json.groups || {}, stocks: json.stocks || {}, updatedAt: json.updatedAt || null, cfg: { ...GLOBAL_PRIOR, ...(json.cfg || {}) } };
}
const serialize = s => ({ global: s.global, groups: s.groups, stocks: s.stocks, updatedAt: s.updatedAt, cfg: s.cfg });

// Posterior view for one stock, pooled stock→group→global. hint supplies sector/beta
// for cold-start names that have no stored state yet.
function posterior(state, ticker, hint = {}) {
  const cfg = state.cfg;
  const Gm = accMean(state.global), Gbeat = accBeat(state.global);
  const sigmaPool = Math.sqrt(accVar(state.global, cfg.defaultSigmaPct));
  const st = state.stocks[ticker];
  const gk = (st && st.group) || groupKey(hint.sector, hint.beta);
  const grp = state.groups[gk] || newAcc();
  const gMean = shrink(accMean(grp), Gm, grp.W, cfg.kGroup);
  const gBeat = shrink(accBeat(grp), Gbeat, grp.W, cfg.kGroup);
  const sAcc = st || newAcc();
  const expAlpha = shrink(accMean(sAcc), gMean, sAcc.W, cfg.kStock);
  const beatRate = shrink(accBeat(sAcc), gBeat, sAcc.W, cfg.kStock);
  const postSd = Math.sqrt((sigmaPool * sigmaPool) / (sAcc.W + cfg.kStock));
  const pPos = normCdf(expAlpha / (postSd || 1e-6));
  return {
    ticker, group: gk,
    expAlpha: +expAlpha.toFixed(3), postSd: +postSd.toFixed(3), pPos: +pPos.toFixed(3),
    beatRate: +beatRate.toFixed(3), wEff: +sAcc.W.toFixed(1), n: (st && st.n) || 0,
    drifted: (st && st.cusum) <= -cfg.driftThreshold,
  };
}

// Fold in resolved outcomes: [{ ticker, alpha(%), sector, beta }]. Decay everything,
// then conjugate-update stock + group + global, then CUSUM drift on the stock.
function update(state, outcomes) {
  const cfg = state.cfg, d = cfg.decay;
  decayAcc(state.global, d);
  for (const g in state.groups) decayAcc(state.groups[g], d);
  for (const t in state.stocks) decayAcc(state.stocks[t], d);
  const Gm0 = accMean(state.global), sg0 = Math.sqrt(accVar(state.global, cfg.defaultSigmaPct)) || cfg.defaultSigmaPct;
  for (const o of outcomes) {
    const x = clamp(o.alpha, -cfg.clipPct, cfg.clipPct);
    let st = state.stocks[o.ticker];
    const gk = groupKey(o.sector != null ? o.sector : st && st.sector, o.beta != null ? o.beta : st && st.beta);
    if (!st) st = state.stocks[o.ticker] = { ...newAcc(), n: 0, cusum: 0, group: gk, beta: o.beta, sector: o.sector };
    st.group = gk; if (o.beta != null) st.beta = o.beta; if (o.sector != null) st.sector = o.sector; st.n++;
    addAcc(st, x);
    addAcc(state.groups[gk] || (state.groups[gk] = newAcc()), x);
    addAcc(state.global, x);
    const z = (x - Gm0) / sg0;                                  // standardized vs global mean
    st.cusum = Math.min(0, (st.cusum || 0) + z + cfg.cusumSlack);
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

// Live recommendation: regime gate + drift gate + conviction tiers on EXPECTED
// ALPHA and P(edge>0). sizePct is conviction-proportional (capped) — deliberately
// NOT raw single-trade Kelly (which over-levers in a multi-position book).
function recommend(state, { ticker, regime, signal, sector, beta }) {
  const cfg = state.cfg, base = { ticker, regime, signal: signal || null };
  if (regime === 'risk-off') return { ...base, action: 'SKIP', conviction: 0, sizePct: 0, reason: 'Risk-off regime — the fade reverses here (gated out).' };
  const p = posterior(state, ticker, { sector, beta });
  if (p.drifted) return { ...base, ...p, action: 'SKIP', conviction: 0, sizePct: 0, reason: 'Edge drift — this name stopped reverting; suspended until it recovers.' };

  let action, reason;
  if (p.expAlpha >= 0.6 && p.pPos >= 0.65 && p.wEff >= cfg.minWeff) { action = 'SHORT'; reason = 'Strong expected fade edge with confident, well-sampled history.'; }
  else if (p.expAlpha >= 0.25 && p.pPos >= 0.55) { action = 'SHORT_LIGHT'; reason = 'Positive expected fade edge — size down.'; }
  else if (p.expAlpha > 0 && p.pPos >= 0.5) { action = 'WATCH'; reason = 'Marginal expected edge — watch only.'; }
  else { action = 'SKIP'; reason = 'Expected edge ≤ 0 for this name.'; }

  let sizePct = clamp(p.expAlpha * 2, 0, 5);                   // +1% exp alpha → 2% weight, capped 5%
  if (regime === 'risk-on') sizePct *= 0.5;                    // weaker regime
  return {
    ...base, ...p, action,
    conviction: p.pPos, sizePct: +sizePct.toFixed(2),
    netExpAlpha: +(p.expAlpha - cfg.assumedCostPct).toFixed(2),  // after assumed round-trip cost
    reason,
  };
}

// Trailing-W beta of a stock vs SPY using the last bars (returns aligned by date).
function betaVsSpy(candles, spyClose, W = 252) {
  const n = candles.length, lo = Math.max(1, n - W), sr = [], mr = [];
  for (let j = lo; j < n; j++) {
    const sp = spyClose[candles[j].date], sp1 = spyClose[candles[j - 1].date]; if (sp == null || sp1 == null) continue;
    sr.push(candles[j].close / candles[j - 1].close - 1); mr.push(sp / sp1 - 1);
  }
  const m = sr.length; if (m < 30) return 1;
  const mm = mr.reduce((a, x) => a + x, 0) / m, ms = sr.reduce((a, x) => a + x, 0) / m;
  let cov = 0, varm = 0; for (let j = 0; j < m; j++) { cov += (sr[j] - ms) * (mr[j] - mm); varm += (mr[j] - mm) ** 2; }
  return varm > 0 ? +(cov / varm).toFixed(2) : 1;
}

const summary = state => ({
  meanAlpha: +accMean(state.global).toFixed(3), beatRate: +accBeat(state.global).toFixed(3),
  effObs: +state.global.W.toFixed(0), stocks: Object.keys(state.stocks).length, groups: Object.keys(state.groups).length,
});

module.exports = { GLOBAL_PRIOR, emptyState, load, serialize, posterior, update, recommend, betaVsSpy, summary, groupKey, betaBucket };
