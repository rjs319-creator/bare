// 🧬 BIOTECH RADAR — early-run-up biotech screener with a catalyst-aware /100 score.
//
// THESIS: biotech moves on binary CATALYSTS (FDA/PDUFA, trial readouts, M&A), not on
// fundamentals — most names are pre-revenue, so P/E is meaningless. This screener hunts
// names that have JUST started running (early, not yet parabolic) across micro/small/large
// caps, scores each 0–100 with a biotech-specific model, and an AI investigator (Haiku 4.5
// + web_search — the only model reliable inside the 60s serverless wall) finds WHY it's
// running, or labels it Unknown. Benchmarked vs XBI (equal-weight biotech ETF), the honest
// peer index for a biotech runner.
//
// The scoring reflects hard-won biotech-trading judgment (a Fable-5 design pass):
//   • Catalyst credit is EVIDENCE-GRADED (a dated PR = full credit; an inferred/sector
//     reason = half) so one noisy AI extraction can't dominate the score.
//   • Financing is NOT uniformly negative — a pending shelf/ATM into strength is a trap
//     (they'll sell your breakout); a completed, priced raise clears the overhang.
//   • Earliness is ADR-normalized (a +15% move on a 3%-ADR name is an event; on a 12%-ADR
//     microcap it's noise) — same vol-normalization lesson as Coil Radar.
//   • It actively REJECTS names engineered to be sold into: serial spike-faders, dilution
//     risk, sub-$1 delisting candidates, illiquid halt-prone names all take penalties.
//   • "Unknown" is split: Stealth (multi-day accumulation, newsless → possible leak) scores
//     decently; Noise (one-day microcap spike) scores near zero.
//
// FUTURE (documented, not in v1 — each needs per-name feed calls that risk the 50s wall):
//   EDGAR S-3/424B5/ATM dilution-ammo check, FMP cash-runway + shares-outstanding growth,
//   Finnhub insider cluster-buy, an accruing PDUFA/readout calendar, a static medical-
//   conference (JPM/AACR/ASCO/ASH) window flag, and an intra-biotech sympathy read-through.
//   The AI prompt already asks for dilution/runway signals so v1 captures much of this free.

const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 50000;
const MAX_INVESTIGATE = 8;            // top mechanically-ranked runners sent to the investigator

// Detection thresholds — an early biotech runner: a real multi-day up move on elevated
// volume, tradeable, not a sub-$1 delisting candidate, not already up hundreds of percent.
const MIN_PCT5D = 5;
const MIN_RELVOL = 1.3;
const MIN_DOLLAR_VOL = 1_000_000;
const MIN_PRICE = 1.0;
const MAX_PCT5D = 200;                // already parabolic → not "just starting"

// Catalyst taxonomy. Phase/evidence-aware: hard binary catalysts on top, process/hype low,
// dilution a trap. STEALTH/NOISE are the two halves of "no public catalyst found".
const CATALYST_CLASSES = ['FDA', 'DATA', 'MA', 'PARTNER', 'ANALYST', 'SYMPATHY', 'FINANCING', 'STEALTH', 'NOISE'];
// Base catalyst points (of 35) before the evidence multiplier and cap/dilution adjustments.
const CATALYST_BASE = {
  FDA: 35, MA: 34, DATA: 32, SYMPATHY: 18, PARTNER: 22, ANALYST: 14, STEALTH: 18, FINANCING: 6, NOISE: 4,
};
const EVIDENCE_MULT = { Verified: 1.0, Inferred: 0.55, None: 0.35 };

// ── Feature extraction from daily candles ──────────────────────────────────
function sma(candles, period, endIdx) {
  if (endIdx - period + 1 < 0) return null;
  let s = 0;
  for (let k = endIdx - period + 1; k <= endIdx; k++) s += candles[k].close;
  return s / period;
}

// Count prior spike-and-fade episodes (a >SPIKE% 5-day run that gave back most of it within
// ~a month) — the promotional-vehicle fingerprint. Serial spikers round-trip every runner.
function countSpikeFades(candles) {
  const SPIKE = 50, GIVEBACK = 0.6, WINDOW = 21;
  const n = candles.length;
  let count = 0, lastEnd = -WINDOW;
  for (let i = 5; i < n - 1; i++) {
    if (i < lastEnd + 5) continue;                    // don't double-count overlapping spikes
    const base = candles[i - 5].close;
    if (!(base > 0)) continue;
    const runPct = (candles[i].close - base) / base * 100;
    if (runPct < SPIKE) continue;
    const peak = candles[i].close;
    let trough = peak;
    for (let k = i + 1; k <= Math.min(n - 1, i + WINDOW); k++) trough = Math.min(trough, candles[k].close);
    if ((peak - trough) / (peak - base) >= GIVEBACK) { count++; lastEnd = i; }
  }
  return count;
}

// Everything the scorer needs beyond dayMetrics. Null if not enough history.
function biotechFeatures(candles) {
  const n = candles ? candles.length : 0;
  if (n < 30) return null;
  const i = n - 1;
  const last = candles[i].close;
  if (!(last > 0)) return null;

  const sma20 = sma(candles, 20, i), sma50 = sma(candles, 50, i), sma200 = n >= 200 ? sma(candles, 200, i) : null;
  const sma20Prev = sma(candles, 20, i - 3);
  const base20 = candles[i - 20] ? candles[i - 20].close : null;
  const pct20d = base20 > 0 ? (last - base20) / base20 * 100 : null;

  // ADR (avg daily range %) over the prior 20 sessions — the move's natural scale.
  let adrSum = 0, k = 0;
  for (let j = i - 20; j < i; j++) { const b = candles[j]; if (b && b.close > 0) { adrSum += (b.high - b.low) / b.close * 100; k++; } }
  const adr = k ? adrSum / k : null;
  // Today's move in ADR units (overextension); >3 ADR = blow-off / fade risk.
  const prev = candles[i - 1].close;
  const pctChange = prev > 0 ? (last - prev) / prev * 100 : 0;
  const extADR = adr && adr > 0 ? Math.max(0, Math.min(8, pctChange / adr)) : 1;

  // Run maturity: how young is the reclaim? Count of consecutive recent sessions the close
  // has held ABOVE the 20-SMA (a fresh reclaim = early = low; a long-extended run = late).
  // Capped at 15. runAge 0 means today is the first day back above.
  let runAge = 0;
  for (let j = i; j >= Math.max(0, i - 15); j--) {
    const s = sma(candles, 20, j);
    if (s == null || candles[j].close <= s) break;
    runAge = i - j;
  }
  // 5-day move in ADR-days consumed — "am I early or late" in one number.
  let pct5d = null;
  if (candles[i - 5]) { const b5 = candles[i - 5].close; if (b5 > 0) pct5d = (last - b5) / b5 * 100; }
  const adrDaysConsumed = adr && adr > 0 && pct5d != null ? +(pct5d / adr).toFixed(2) : null;

  let hh5 = 0; for (let j = i - 4; j <= i; j++) if (candles[j] && candles[j].high > hh5) hh5 = candles[j].high;
  const nearHigh5 = hh5 > 0 ? Math.max(0.7, Math.min(1, last / hh5)) : 0.9;

  return {
    last, sma20, sma50, sma200, pct20d, adr: adr != null ? +adr.toFixed(2) : null,
    extADR: +extADR.toFixed(2), runAge, adrDaysConsumed, nearHigh5: +nearHigh5.toFixed(3),
    aboveSma20: sma20 != null && last > sma20, aboveSma50: sma50 != null && last > sma50,
    aboveSma200: sma200 != null && last > sma200,
    sma20Rising: sma20 != null && sma20Prev != null && sma20 > sma20Prev,
    spikeFades: countSpikeFades(candles),
    lowPriced: last < 2,
  };
}

// ── Score components (each returns points; see weights in the header) ───────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Momentum & earliness (0–25). Rewards a real ADR-normalized move that is still YOUNG;
// penalizes blow-off overextension and serial spike-faders. Regime-gated (Fable A15):
// smallcap biotech momentum only pays with XBI healthy — in risk-off we haircut it.
function scoreMomentum(m, f, ctx = {}) {
  if (!f) return 0;
  // ADR-days consumed: peak reward ~1.5–3 (a fresh event move), decaying past 4 (late/extended).
  const adc = f.adrDaysConsumed != null ? f.adrDaysConsumed : (m.pct5d || 0) / 6;
  let move = adc <= 3 ? (adc / 3) * 14 : clamp(14 - (adc - 3) * 3, 2, 14);
  const freshness = f.runAge <= 3 ? 7 : f.runAge <= 6 ? 4 : 1;          // young reclaim = early
  let pts = move + freshness + (f.aboveSma20 ? 2 : 0) + (f.aboveSma50 ? 2 : 0);
  if (f.extADR >= 4) pts -= (f.extADR - 4) * 3;                          // blow-off fade risk
  if (f.spikeFades >= 2) pts -= 5;                                       // promotional vehicle
  if (ctx.regime === 'risk-off') pts *= 0.6;                            // XBI risk-off gate
  return clamp(+pts.toFixed(1), 0, 25);
}

// Relative strength vs the biotech benchmark (0–15). Beating XBI (not just being up with the
// group) is what separates a real leader from beta in a biotech-led tape.
function scoreRelStrength(m, etfPct5d) {
  const excess = (m.pct5d || 0) - (etfPct5d || 0);
  return clamp(+(7.5 + excess * 0.5).toFixed(1), 0, 15);                 // +15% excess → cap
}

// Volume / accumulation (0–15). Elevated relative volume + a cluster of unusual-volume days
// (real participation, not a single freak print).
function scoreVolume(m) {
  const rv = clamp(((m.relVol || 1) - 1) / 2, 0, 1) * 10;                // 1×→0, 3×→10
  const hv = clamp((m.highVolDays5 || 0), 0, 5);                        // up to 5 pts
  return clamp(+(rv + hv).toFixed(1), 0, 15);
}

// Technical structure (0–10). Above rising SMAs + near the recent high = a clean advancing
// base rather than a dead-cat bounce.
function scoreTechnical(m, f) {
  if (!f) return 0;
  let pts = (f.aboveSma20 ? 2.5 : 0) + (f.aboveSma50 ? 2 : 0) + (f.aboveSma200 ? 1.5 : 0)
    + (f.sma20Rising ? 2 : 0) + (f.nearHigh5 >= 0.95 ? 2 : f.nearHigh5 >= 0.9 ? 1 : 0);
  return clamp(+pts.toFixed(1), 0, 10);
}

// Catalyst (0–35). From the AI: base points by class × evidence multiplier, with biotech
// judgment layered in — analyst calls are near-worthless in microcaps, and financing is a
// trap only when the raise is PENDING (shelf/ATM), not when it's a completed priced deal.
function scoreCatalyst(ai, capTier) {
  if (!ai || !ai.classification) return null;                           // not investigated yet
  let base = CATALYST_BASE[ai.classification] != null ? CATALYST_BASE[ai.classification] : 8;
  if (ai.classification === 'ANALYST' && capTier === 'micro') base *= 0.5;
  if (ai.classification === 'FINANCING' && ai.dilution_risk === 'High') base = 3;   // pending shelf/ATM
  if (ai.classification === 'FINANCING' && (ai.dilution_risk === 'Low' || ai.dilution_risk === 'None')) base = 14; // priced deal cleared overhang
  const mult = EVIDENCE_MULT[ai.evidence] != null ? EVIDENCE_MULT[ai.evidence] : 0.5;
  return clamp(+(base * mult).toFixed(1), 0, 35);
}

// Trap penalties (subtracted from the total). These are the "engineered to be sold into"
// tells — the biggest source of biotech screening losses is not missing runners, it's
// buying the ones set up to dump on you.
function trapPenalty(f, ai) {
  let pen = 0;
  if (ai && ai.dilution_risk === 'High') pen += 15;                      // pending offering into strength
  if (f && f.spikeFades >= 2) pen += 8;                                  // serial round-tripper
  if (f && f.lowPriced) pen += 6;                                        // sub-$2 delisting / reverse-split risk
  return pen;
}

// Final 0–100 score. `ai` is null for names not yet investigated → catalyst falls back to a
// conservative mechanical baseline (a newsless accumulator gets modest Stealth-style credit).
function scoreBiotech(m, f, ctx = {}) {
  const mom = scoreMomentum(m, f, ctx);
  const rs = scoreRelStrength(m, ctx.etfPct5d);
  const vol = scoreVolume(m);
  const tech = scoreTechnical(m, f);
  const ai = ctx.ai || null;
  const catalyst = ai ? scoreCatalyst(ai, ctx.capTier) : (m.newsless ? 12 : 8);  // provisional pre-AI
  const pen = trapPenalty(f, ai);
  const total = clamp(+(mom + rs + vol + tech + catalyst - pen).toFixed(0), 0, 100);
  return {
    score: total,
    tier: tierFor(total),
    breakdown: { catalyst: +(+(catalyst)).toFixed(1), momentum: mom, relStrength: rs, volume: vol, technical: tech, penalty: pen },
  };
}

function tierFor(score) { return score >= 75 ? 'Hot' : score >= 60 ? 'Emerging' : 'Watch'; }

// Detection predicate over dayMetrics (pure).
function isBiotechRunner(m) {
  return !!m && m.pct5d != null
    && m.pct5d >= MIN_PCT5D && m.pct5d <= MAX_PCT5D
    && m.relVol >= MIN_RELVOL
    && (m.avgDollarVol || 0) >= MIN_DOLLAR_VOL
    && (m.last || 0) >= MIN_PRICE;
}

// ── AI investigator (Haiku 4.5 + web_search) ───────────────────────────────
const BIOTECH_TOOL = {
  name: 'submit_biotech',
  description: 'For each biotech runner, identify WHY it is moving (or Unknown) after searching news, PRs, and SEC filings.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            classification: { type: 'string', enum: CATALYST_CLASSES, description: 'FDA=approval/PDUFA/regulatory; DATA=clinical trial readout; MA=merger/buyout; PARTNER=licensing/collaboration; ANALYST=rating/PT change; SYMPATHY=moving with a subsector leader; FINANCING=offering/raise/shelf; STEALTH=no public catalyst but multi-day accumulation; NOISE=no catalyst, looks random/illiquid' },
            evidence: { type: 'string', enum: ['Verified', 'Inferred', 'None'], description: 'Verified = a dated press release / filing found; Inferred = sector move or indirect; None = nothing found' },
            catalyst_timing: { type: 'string', enum: ['Behind', 'Ahead', 'NA'], description: 'Behind = reacting to a catalyst ALREADY out (no binary risk); Ahead = running INTO a dated future binary event (PDUFA/readout — holding risks a large gap); NA' },
            reason: { type: 'string', description: 'the specific catalyst + date if known (e.g. "Ph3 topline met primary endpoint, Jul 3"), or "no public catalyst found"' },
            subsector: { type: 'string', description: 'mechanism/subsector: obesity/GLP-1, oncology/ADC, radiopharma, gene therapy, CNS, I-O, vaccines, rare disease, etc. — one short tag' },
            dilution_risk: { type: 'string', enum: ['High', 'Medium', 'Low', 'None'], description: 'High = effective shelf/active ATM or cash runway <~4 quarters (likely to sell into this strength); Low = well-funded or raise already completed' },
            confidence: { type: 'integer', description: '1-5 confidence in the classification' },
            bear_case: { type: 'string', description: 'one line: what kills this trade (e.g. "2-qtr runway + effective shelf — likely raises into strength")' },
            thesis: { type: 'string', description: 'one honest sentence on the setup' },
            caution: { type: 'string', description: 'honest flag (ticker-change/data artifact/halt-prone); empty if none' },
          },
          required: ['ticker', 'classification', 'evidence', 'reason', 'confidence'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

function buildPrompt(cands) {
  const lines = cands.map(c => `- ${c.ticker}: +${c.pct5d}% over ~5 sessions (${c.adrDaysConsumed != null ? c.adrDaysConsumed + ' ADR-days, ' : ''}day ~${c.runAge} of the run), RVOL ${c.relVol}x, today ${c.pctChange > 0 ? '+' : ''}${c.pctChange}%, $${(c.last || 0).toFixed(2)}.${c.newsless ? ' Our news feed found NO recent headline.' : ''}`).join('\n');
  return `You are a biotech-desk analyst. Each of these biotech stocks has just started running. For EACH, use web search to find the SPECIFIC reason it's moving — search news, company press releases, and SEC filings (8-K, S-3/424B5 offerings, 13D):

${lines}

Classify the catalyst using this biotech-aware rubric (be strict — biotech is full of pump fuel):
- FDA (approval / PDUFA action / regulatory) and DATA (Ph2 randomized or Ph3 topline / pivotal readout) and MA (definitive merger/buyout) = the real, high-conviction catalysts.
- PARTNER = licensing/collaboration (higher if disclosed upfront CASH, low if a vague MOU/LOI).
- ANALYST = rating/price-target change (routinely marks local tops in microcaps — rate low there).
- SYMPATHY = moving WITH a subsector leader's news (name the leader in "reason"); these fade unless the read-through is mechanistically real.
- FINANCING = any offering/raise/shelf. Judge dilution_risk carefully: a PENDING effective shelf or active ATM into strength is HIGH risk (they will sell the breakout); a COMPLETED, priced raise is LOW risk (overhang cleared).
- Designations (fast-track/orphan/breakthrough), Ph1/preclinical/poster "data" = process, not evidence → treat as ANALYST-tier or lower, NOT DATA.
- STEALTH = you found NO public catalyst but it's a multi-day accumulation on volume (possible leak/informed buying). NOISE = no catalyst and it looks like a random illiquid microcap spike.
Also judge catalyst_timing (is it REACTING to a catalyst already out, or running INTO a dated future binary event?), dilution_risk (look for effective shelves, ATMs, and cash-runway signals — the #1 biotech trap), a one-line bear_case, and the subsector.
Be HONEST: grade evidence as Verified only if you actually found a dated PR/filing; otherwise Inferred or None. Do NOT manufacture a catalyst. You MUST call submit_biotech; do not answer in plain text.`;
}

function parseResult(input, cands) {
  const allowed = cands ? new Set(cands.map(c => c.ticker)) : null;
  const raw = (input && Array.isArray(input.items)) ? input.items : [];
  const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
  const byTicker = new Map();
  for (const it of raw) {
    if (!it || !it.ticker) continue;
    const tk = clean(it.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || (allowed && !allowed.has(tk)) || byTicker.has(tk)) continue;
    byTicker.set(tk, {
      ticker: tk,
      classification: CATALYST_CLASSES.includes(it.classification) ? it.classification : 'NOISE',
      evidence: ['Verified', 'Inferred', 'None'].includes(it.evidence) ? it.evidence : 'None',
      catalyst_timing: ['Behind', 'Ahead', 'NA'].includes(it.catalyst_timing) ? it.catalyst_timing : 'NA',
      reason: clean(it.reason, 500) || 'no public catalyst found',
      subsector: it.subsector ? clean(it.subsector, 60) : null,
      dilution_risk: ['High', 'Medium', 'Low', 'None'].includes(it.dilution_risk) ? it.dilution_risk : 'Medium',
      confidence: Math.max(1, Math.min(5, parseInt(it.confidence, 10) || 3)),
      bear_case: it.bear_case ? clean(it.bear_case, 300) : null,
      thesis: clean(it.thesis, 400),
      caution: it.caution ? clean(it.caution, 300) : null,
    });
  }
  return { items: [...byTicker.values()], notes: clean(input && input.notes, 600) };
}

async function investigate(cands) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }, BIOTECH_TOOL],
    messages: [{ role: 'user', content: buildPrompt(cands) }],
  }, { timeout: CALL_TIMEOUT_MS });
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_biotech');
  return tool ? tool.input : null;
}

module.exports = {
  BIOTECH_TOOL, biotechFeatures, countSpikeFades, isBiotechRunner,
  scoreBiotech, scoreMomentum, scoreRelStrength, scoreVolume, scoreTechnical, scoreCatalyst, trapPenalty,
  tierFor, buildPrompt, parseResult, investigate,
  MODEL, MAX_INVESTIGATE, CATALYST_CLASSES, CATALYST_BASE, EVIDENCE_MULT,
  MIN_PCT5D, MIN_RELVOL, MIN_DOLLAR_VOL, MIN_PRICE, MAX_PCT5D,
};
