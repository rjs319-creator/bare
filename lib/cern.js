/**
 * CERN — CAUSAL EVENT-RESPONSE NETWORK  v1.0  (CommonJS port for this app)
 * ═══════════════════════════════════════════
 * The Forced-Flow Engine with self-learning built into its bones. Faithful port
 * of the spec: learns the market's RESPONSE KERNEL per forced-flow event type —
 *   R = κ_k · (D · U · m(regime)) + ε
 * Bayesian hierarchical with partial pooling; counterfactual logging; Thompson
 * sampling; CUSUM drift; residual mining. The moat is the dataset, not the code —
 * persist EVERYTHING. State is JSON-serializable.
 */

// ───────────────────────── math helpers ─────────────────────────
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const last = (a, n = 1) => a[a.length - n];
const DAY = 86400000;

/** Standard normal CDF (Abramowitz-Stegun) */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 +
          t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
/** Sample N(mu, sd) — Box-Muller */
function sampleNormal(mu, sd) {
  const u1 = Math.random() || 1e-9, u2 = Math.random();
  return mu + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ═══════════════════ EVENT TYPES & PRIORS ═══════════════════
const EVENT_TYPES = {
  INDEX_DELETE:    { horizon: 40, priorKappa: 0.70 }, // deletion reversal
  INDEX_ADD_FADE:  { horizon: 30, priorKappa: 0.45 }, // post-add giveback (short)
  // logOnly: lockup sellers (insiders/VCs) are the most INFORMED sellers, which
  // violates CERN's uninformed-flow premise (U). Post-lockup drift is persistently
  // negative, not mean-reverting — so we keep logging it for the counterfactual
  // archive (the moat) but never take a real position on it.
  LOCKUP_EXPIRY:   { horizon: 40, priorKappa: 0.55, logOnly: true },
  TAX_LOSS:        { horizon: 45, priorKappa: 0.65 }, // Nov-Dec losers, Jan bounce
  FIRE_SALE:       { horizon: 50, priorKappa: 0.75 }, // fund-outflow forced sells
  MARGIN_SPIRAL:   { horizon: 25, priorKappa: 0.60 }, // detected, not calendared
  FORCED_DOWNGRADE: { horizon: 45, priorKappa: 0.65 },
};
const GLOBAL_PRIOR = { mu: 0.62, tau: 0.18 }; // pooling distribution for κ
const PRIOR_OBS_SD = 0.45;                    // initial per-type κ sd

// ═══════════════════════ THE ENGINE ═══════════════════════

class CERN {
  constructor(state = null) { this.s = state ?? CERN.freshState(); }

  static freshState() {
    const types = {};
    for (const [k, cfg] of Object.entries(EVENT_TYPES)) {
      types[k] = {
        cfg,
        mu: cfg.priorKappa, sd: PRIOR_OBS_SD,
        sigma2: 0.02, n: 0,
        cusumPos: 0, cusumNeg: 0, drifted: false,
        traded: { n: 0, sum: 0, sumSq: 0 },
      };
    }
    return {
      version: 1,
      types,
      global: { mu: GLOBAL_PRIOR.mu, tau: GLOBAL_PRIOR.tau },
      ledger: [],          // active events (pending or open)
      archive: [],         // resolved events — THE MOAT. Never delete.
      candidates: [],      // residual-mined candidate event types
      explorationBudget: 3, // max simultaneous paper-probe positions
      changeLog: [],
    };
  }

  // ─────────────── INGESTION: feeding the ledger ───────────────
  addEvent(ev) {
    if (!this.s.types[ev.type]) return false;
    const dupe = this.s.ledger.some(e =>
      e.symbol === ev.symbol && e.type === ev.type &&
      Math.abs(e.dateMs - ev.dateMs) < 20 * DAY);
    if (dupe) return false;
    this.s.ledger.push({
      id: `${ev.type}:${ev.symbol}:${ev.dateMs}`,
      ...ev, status: 'PENDING',          // PENDING → SIGNALED → RESOLVED
      signal: null, resolution: null,
    });
    return true;
  }

  detectEvents(symbol, bars, { beta = 1, nowMs = Date.now() } = {}) {
    if (bars.length < 30) return;
    const v20 = mean(bars.slice(-23, -3).map(b => b.volume));
    const last3 = bars.slice(-3);
    const heavyDown = last3.every(b => b.close < b.open && b.volume > 1.5 * v20);
    const drop3 = last(bars).close / bars[bars.length - 4].close - 1;
    if (heavyDown && drop3 <= -0.12 && beta >= 1.2) {
      this.addEvent({ type: 'MARGIN_SPIRAL', symbol, dateMs: nowMs,
        estFlowShares: 3 * v20, direction: -1, meta: { drop3 } });
    }
    const month = new Date(nowMs).getMonth(); // 10 = Nov
    if ((month === 10 || (month === 11 && new Date(nowMs).getDate() <= 20))) {
      const ytdIdx = Math.max(bars.length - 252, 0);
      const ytd = last(bars).close / bars[ytdIdx].close - 1;
      if (ytd <= -0.30)
        this.addEvent({ type: 'TAX_LOSS', symbol, dateMs: nowMs,
          estFlowShares: 5 * v20, direction: -1, meta: { ytd } });
    }
  }

  // ─────────────── DAILY TICK ───────────────
  dailyTick(dataFor, marketCtx = {}, nowMs = Date.now()) {
    const regime = marketCtx.regime ?? 'neutral';
    const costBps = marketCtx.costBps ?? 30;
    const decisions = [], alerts = [];

    // 1) advance every active event: pressure → completion → maybe SIGNAL
    for (const ev of this.s.ledger) {
      if (ev.status !== 'PENDING') continue;
      const d = dataFor(ev.symbol);
      if (!d?.bars || d.bars.length < 30) continue;

      const m = this._measure(ev, d, regime);
      if (!m) continue;
      Object.assign(ev, { measured: m });

      if (m.pressureDays < 0.5) continue;
      if (m.U < 0.6) continue;
      if (m.completion < 0.8 || !m.absorptionBar) continue;

      const t = this.s.types[ev.type];
      const x = m.D * m.U * this._regimeMult(regime);
      const predMu = t.mu * x;
      const predSd = Math.sqrt(x * x * t.sd * t.sd + t.sigma2);
      const cost = 2 * costBps / 1e4;
      const pProfit = 1 - normCdf((cost - predMu) / predSd);

      const kelly = clamp((predMu - cost) / (predSd * predSd), 0, 4);
      const size = clamp(0.25 * kelly * 0.01, 0, 0.05); // fraction of capital

      const logOnly = !!t.cfg.logOnly;
      const trade = !logOnly && pProfit >= 0.65 && !t.drifted &&
                    this._shipGatePassed(t) && size > 0.002;

      ev.status = 'SIGNALED';
      ev.signal = {
        dateMs: nowMs, entryPrice: last(d.bars).close,
        x, predMu, predSd, pProfit, regime,
        side: ev.direction === -1 ? 'long' : 'short',
        stop: ev.direction === -1
          ? m.eventLow - 1.0 * m.atr14 : m.eventHigh + 1.0 * m.atr14,
        target: last(d.bars).close * (1 + (ev.direction === -1 ? 1 : -1) * predMu),
        horizon: t.cfg.horizon,
        action: trade ? 'TRADE'
              : (!logOnly && this._thompsonProbe(ev.type)) ? 'PROBE' : 'LOG_ONLY',
        size: trade ? size : 0,
      };
      decisions.push({ id: ev.id, symbol: ev.symbol, type: ev.type,
                       ...ev.signal });
    }

    // 2) resolve matured signals → ALL learning flows from here
    const resolved = this._resolveMatured(dataFor, nowMs);

    // 3) housekeeping: expire stale pendings (>90d), prune, mine residuals
    this.s.ledger = this.s.ledger.filter(ev =>
      ev.status !== 'PENDING' || nowMs - ev.dateMs < 90 * DAY);
    const mined = this._mineResiduals();
    if (mined.length) alerts.push(...mined.map(c =>
      ({ kind: 'CANDIDATE_EVENT_TYPE', ...c })));
    for (const [k, t] of Object.entries(this.s.types))
      if (t.drifted) alerts.push({ kind: 'DRIFT', type: k,
        note: 'response kernel shifted — sizing auto-suppressed' });

    return { decisions, resolved, alerts,
             thompson: this._thompsonRanking(),
             posteriors: this._posteriorSummary() };
  }

  // ─────────────── measurement: D, U, completion, absorption ───────────────
  _measure(ev, d, regime) {
    const { bars, sectorBars } = d;
    const evIdx = this._barIndexAt(bars, ev.dateMs);
    if (evIdx == null || bars.length - evIdx < 2) return null;
    const since = bars.slice(evIdx);
    const px = last(bars).close;

    const stockMove = px / since[0].close - 1;
    let sectorMove = 0;
    if (sectorBars?.length >= since.length)
      sectorMove = last(sectorBars).close /
                   sectorBars[sectorBars.length - since.length].close - 1;
    // Peer-relative dislocation magnitude in the thesis direction. For a long
    // (dir -1) reversion event the stock should have fallen vs its sector
    // (sectorMove > stockMove); for a short (dir +1) fade it should have run up.
    const D = Math.max((sectorMove - stockMove) * -ev.direction, 0);

    const adv = mean(bars.slice(-40, -1).map(b => b.volume));
    const pressureDays = ev.estFlowShares / (adv || 1);
    const cumVol = since.reduce((s, b) => s + b.volume, 0);
    const baselineVol = adv * since.length;
    const abnormalVol = Math.max(cumVol - baselineVol, 0);
    const completion = clamp(abnormalVol / (ev.estFlowShares || 1), 0, 2);

    const b = last(bars);
    const range = b.high - b.low || 1e-9;
    const clv = ((b.close - b.low) - (b.high - b.close)) / range;
    const absorptionBar = ev.direction === -1
      ? clv >= 0.5 && b.volume >= adv
      : clv <= -0.5 && b.volume >= adv;

    let U = 1.0;
    const attZ = d.attentionZ ?? 0;
    U *= clamp(1 - Math.max(attZ - 0.5, 0) / 3, 0.2, 1);
    if (d.estimateRevisions === (ev.direction === -1 ? 'down' : 'up')) U *= 0.4;
    if (d.daysToEarnings != null && d.daysToEarnings <= 7) U *= 0.3;

    return {
      D, U, pressureDays, completion, absorptionBar,
      atr14: mean(bars.slice(-14).map(x => x.high - x.low)),
      eventLow: Math.min(...since.map(x => x.low)),
      eventHigh: Math.max(...since.map(x => x.high)),
    };
  }

  _regimeMult(r) { return r === 'risk-on' ? 1.1 : r === 'risk-off' ? 0.7 : 1; }

  _barIndexAt(bars, dateMs) {
    if (!bars[0]?.dateMs) return Math.max(bars.length - 15, 0); // fallback
    for (let i = bars.length - 1; i >= 0; i--)
      if (bars[i].dateMs <= dateMs) return i;
    return null;
  }

  // ─────────────── RESOLUTION → BAYESIAN LEARNING ───────────────
  _resolveMatured(dataFor, nowMs) {
    let count = 0;
    for (const ev of this.s.ledger) {
      if (ev.status !== 'SIGNALED') continue;
      const t = this.s.types[ev.type];
      const ageDays = (nowMs - ev.signal.dateMs) / DAY;
      if (ageDays < t.cfg.horizon * 1.45) continue; // ~trading→calendar days

      const d = dataFor(ev.symbol);
      if (!d?.bars) continue;
      const px = last(d.bars).close;
      const dir = ev.signal.side === 'long' ? 1 : -1;
      const R = (px / ev.signal.entryPrice - 1) * dir; // realized response
      ev.resolution = { dateMs: nowMs, R };
      ev.status = 'RESOLVED';
      count++;

      // ── conjugate update of κ_k from (x, R):  R = κ·x + ε ──
      const x = ev.signal.x;
      if (x > 0.005) {
        const prec = 1 / (t.sd * t.sd);
        const obsPrec = (x * x) / t.sigma2;
        const newPrec = prec + obsPrec;
        t.mu = (prec * t.mu + (x * R / t.sigma2)) / newPrec;
        t.sd = Math.sqrt(1 / newPrec);
        const resid = R - t.mu * x;
        t.sigma2 = 0.95 * t.sigma2 + 0.05 * resid * resid; // EWMA noise
        t.n += 1;

        const z = resid / Math.sqrt(t.sigma2);
        t.cusumPos = Math.max(0, t.cusumPos + z - 0.5);
        t.cusumNeg = Math.max(0, t.cusumNeg - z - 0.5);
        if (t.cusumPos > 4 || t.cusumNeg > 4) {
          t.drifted = true;
          t.sd = Math.min(t.sd * 3, PRIOR_OBS_SD);
          t.cusumPos = t.cusumNeg = 0;
          this.s.changeLog.push({ t: nowMs, type: 'DRIFT', eventType: ev.type });
        } else if (t.drifted && t.n % 5 === 0 && t.sd < 0.2) {
          t.drifted = false; // evidence re-tightened — sizing resumes
        }

        this._poolGlobal();
      }

      if (ev.signal.action === 'TRADE') {
        const cost = 0.006; // 2×30bps round trip
        const net = R - cost;
        t.traded.n += 1; t.traded.sum += net; t.traded.sumSq += net * net;
      }

      // ── the moat: archive EVERYTHING, traded or not ──
      this.s.archive.push(JSON.parse(JSON.stringify(ev)));
    }
    this.s.ledger = this.s.ledger.filter(ev => ev.status !== 'RESOLVED');
    return count;
  }

  _poolGlobal() {
    const types = Object.values(this.s.types).filter(t => t.n > 0);
    if (!types.length) return;
    let wSum = 0, mSum = 0;
    for (const t of types) { const w = 1 / (t.sd * t.sd); wSum += w; mSum += w * t.mu; }
    this.s.global.mu = mSum / wSum;
    const tau2 = this.s.global.tau ** 2;
    for (const t of Object.values(this.s.types)) {
      const pT = 1 / (t.sd * t.sd), pG = 1 / tau2;
      const blend = t.n / (t.n + 8);            // 8 ≈ pooling prior weight
      const pooledMu = (pT * t.mu + pG * this.s.global.mu) / (pT + pG);
      t.mu = blend * t.mu + (1 - blend) * pooledMu;
    }
  }

  // ─────────────── THOMPSON SAMPLING (exploration) ───────────────
  _thompsonRanking() {
    return Object.entries(this.s.types)
      .map(([k, t]) => ({ type: k, sample: sampleNormal(t.mu, t.sd),
                          mu: t.mu, sd: t.sd, n: t.n }))
      .sort((a, b) => b.sample - a.sample);
  }
  _thompsonProbe(eventType) {
    const open = this.s.ledger.filter(e =>
      e.status === 'SIGNALED' && e.signal?.action === 'PROBE').length;
    if (open >= this.s.explorationBudget) return false;
    const rank = this._thompsonRanking().findIndex(r => r.type === eventType);
    return rank <= 2; // sampled into the top 3 → worth a paper probe
  }

  // ─────────────── RESIDUAL MINING (self-expansion) ───────────────
  _mineResiduals() {
    const big = this.s.archive.slice(-200).filter(ev => {
      const t = this.s.types[ev.type];
      if (!ev.signal || !ev.resolution) return false;
      const resid = ev.resolution.R - t.mu * ev.signal.x;
      return Math.abs(resid) / Math.sqrt(t.sigma2) > 2;
    });
    const groups = {};
    for (const ev of big) {
      const key = [ev.signal.regime, ev.signal.side,
                   ev.meta?.sector ?? '?'].join('|');
      (groups[key] ??= []).push(ev);
    }
    const found = [];
    for (const [key, evs] of Object.entries(groups)) {
      if (evs.length < 4) continue;
      const sameSign = evs.every(e => Math.sign(e.resolution.R) ===
                                      Math.sign(evs[0].resolution.R));
      if (sameSign && !this.s.candidates.some(c => c.key === key)) {
        const c = { key, n: evs.length,
                    note: 'recurring unexplained response — name it, confirm ' +
                          'it, and it joins the hierarchy with pooled priors' };
        this.s.candidates.push(c);
        found.push(c);
      }
    }
    return found;
  }

  // ─────────────── ship gate & reporting ───────────────
  _shipGatePassed(t) {
    if (t.traded.n < 5) return true; // bootstrap: tiny size allowed (caps apply)
    const m = t.traded.sum / t.traded.n;
    const sd = Math.sqrt(Math.max(t.traded.sumSq / t.traded.n - m * m, 1e-9));
    const tStat = m / (sd / Math.sqrt(t.traded.n));
    return t.traded.n < 15 ? m > -0.01      // grace period: not bleeding
         : tStat >= (t.traded.n >= 60 ? 2 : 0.5); // full gate at n≥60
  }

  _posteriorSummary() {
    const out = {};
    for (const [k, t] of Object.entries(this.s.types))
      out[k] = { kappa: +t.mu.toFixed(3), sd: +t.sd.toFixed(3), n: t.n,
                 sigma: +Math.sqrt(t.sigma2).toFixed(3),
                 drifted: t.drifted,
                 tradedN: t.traded.n,
                 tradedAvg: t.traded.n
                   ? +(t.traded.sum / t.traded.n).toFixed(4) : null };
    return out;
  }

  serialize() { return JSON.stringify(this.s); }
  static load(json) { return new CERN(typeof json === 'string' ? JSON.parse(json) : json); }
}

module.exports = { CERN, EVENT_TYPES };
