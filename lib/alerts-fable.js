// FABLE-5 REVIEW LAYER over the mechanical trade-alert ranker (lib/alerts.js).
// The base ranker is pure regex/keyword: it mislabels negation ("not buying puts"),
// sarcasm and questions on DIRECTION, and its "conviction" is emoji/ALLCAPS counting
// (a 🚀🚀 pump scores high; a reasoned thesis scores low). This module adds one
// BOUNDED, PARAMETRIC Fable-5 call that reads the actual post text and returns, per
// ticker: a corrected direction, a genuine confidence (is the thesis right?) and
// credibility (is the source real vs a pump?), a pump-risk flag, and a synthesized
// thesis. Everything is FALSIFIABLE: we stamp Fable's direction on the graded log so
// the A/B report (fableEdgeReport) can prove — before we trust it — whether Fable's
// read beats the mechanical read on forward returns. Only then does it drive ranking.
//
// Design mirrors lib/readthrough.js: single parametric call, maxRetries:0 (the SDK
// retries on timeout by default → 2-3x budget → blows the 60s function wall),
// tool-use structured output, graceful null on any failure (tab falls back to the
// mechanical ranking, never breaks).

const MODEL = 'claude-fable-5';
const MAX_ASSESS = 15;            // top-N ranked alerts sent per call (bounds tokens + latency)
const CALL_TIMEOUT_MS = 50000;    // under the 60s wall with maxRetries:0
const MAX_TOKENS = 6000;          // ~15 assessments of thinking + the tool call

// Promotion gate (Phase 2 of "both, gated"): Fable only takes over ranking/filtering
// once its directional read has BEATEN the mechanical read on enough graded calls.
// Conservative on purpose — consistent with the app's refuse-to-flatter-small-samples
// culture (see analyzeEdge / predict-feedback-loop).
const PROMOTE_MIN_GRADED = 40;    // min paired graded calls before promotion is even possible
const PROMOTE_MARGIN = 0.05;      // Fable hit-rate must beat mechanical by >= 5 points…
const WILSON_Z = 1.645;           // …and its 90% Wilson lower bound must clear the mechanical point estimate

const DIRECTIONS = ['bullish', 'bearish', 'neutral'];
const PUMP_LEVELS = ['low', 'medium', 'high'];
const PUMP_PENALTY = { low: 0, medium: 12, high: 30 };

// Structured-output tool — forces a per-ticker judgment, not prose.
const ALERTS_FABLE_TOOL = {
  name: 'submit_alert_reviews',
  description: 'Return a reasoned review of each social trade alert: the true direction (handling negation/sarcasm), how confident the trade thesis is, how credible the source is vs a pump, and a one-line synthesized thesis.',
  input_schema: {
    type: 'object',
    properties: {
      assessments: {
        type: 'array',
        description: 'One review per ticker provided. Judge from the post text, not the mechanical label — override the direction when the text actually implies the opposite.',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string', description: 'the US ticker being reviewed (must be one of the provided tickers)' },
            direction: { type: 'string', enum: DIRECTIONS, description: 'the TRUE directional call implied by the text. Handle negation ("not buying puts" is not bearish), sarcasm, and questions. Use neutral for chatter/no real call.' },
            confidence: { type: 'integer', description: '0-100. How likely the directional call is CORRECT given the stated thesis quality, specificity (levels, catalyst) and coherence — NOT how loud the post is.' },
            credibility: { type: 'integer', description: '0-100. How GENUINE the source posts look: real analysis + specific levels/catalyst = high; vague hype, engagement-bait, or promotion = low.' },
            pump_risk: { type: 'string', enum: PUMP_LEVELS, description: 'risk this is a coordinated/paid pump or ramp: low = credible independent call, high = classic pump language (guaranteed, to the moon, low-float ramp, "get in now").' },
            catalyst: { type: 'string', description: 'the REAL reason behind the call in a few words (earnings, FDA, squeeze, breakout, M&A, technical, none). Empty if none stated.' },
            thesis: { type: 'string', description: 'one-sentence synthesis of what the posts are actually claiming and why.' },
            caution: { type: 'string', description: 'honest one-line flag if this looks weak/pumpy/contradictory; empty if clean.' },
          },
          required: ['ticker', 'direction', 'confidence', 'credibility', 'pump_risk', 'thesis'],
        },
      },
      notes: { type: 'string', description: 'brief meta-note on overall feed quality or any ticker with no real signal' },
    },
    required: ['assessments'],
  },
};

// ── Prompt ────────────────────────────────────────────────────────────────
const CATALYST_LABEL = { earnings: 'earnings', fda: 'FDA/trial', breakout: 'breakout', squeeze: 'squeeze', 'm&a': 'M&A', analyst: 'analyst', insider: 'insider', technical: 'technical' };

function alertLine(a) {
  const cats = (a.catalysts || []).map(c => CATALYST_LABEL[c] || c).join('/') || 'none';
  const src = `${a.independentSources || 1} indep source(s), ${a.distinctAccounts || 1} acct(s)`;
  const coord = a.coordinated ? ' [FLAGGED coordinated]' : '';
  const text = String(a.sampleText || '').replace(/\s+/g, ' ').slice(0, 220);
  return `- $${a.ticker}: mechanical=${a.direction}, ${src}, tagged-catalysts=${cats}${coord}\n    post: "${text}"`;
}

function buildAssessPrompt(alerts) {
  const lines = alerts.map(alertLine).join('\n');
  return `You are a skeptical trading-desk analyst reviewing social-media trade alerts. Each was ranked by a crude keyword bot that CANNOT read context — it miscounts negation, sarcasm and questions, and it treats emoji/CAPS as conviction. Re-judge each from the actual post text.

ALERTS:
${lines}

For EACH ticker, decide:
1. direction — the true call the text implies. "not buying puts here", "puts got crushed", "who's still short?" are NOT bearish. A rhetorical question is usually neutral. Override the mechanical label when the text disagrees.
2. confidence (0-100) — is the call likely RIGHT? Reward a specific, coherent thesis with a named catalyst and price levels; punish vague hype. Loudness is not confidence.
3. credibility (0-100) — does the source look genuine (real analysis) or promotional (engagement-bait, "guaranteed", ramp language)?
4. pump_risk — low/medium/high for coordinated/paid-pump characteristics.
5. catalyst — the real WHY in a few words. thesis — one honest sentence. caution — flag anything weak/pumpy.

Be conservative: a low confidence/credibility with an honest caution beats a flattering guess. You MUST call submit_alert_reviews — do not answer in plain text.`;
}

// ── Parse / clamp ─────────────────────────────────────────────────────────
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/** Sanitize the model output into a { TICKER: assessment } map. Pure. */
function parseAssessments(input, validTickers) {
  const valid = validTickers ? new Set(validTickers.map(t => String(t).toUpperCase())) : null;
  const raw = (input && Array.isArray(input.assessments)) ? input.assessments : [];
  const out = {};
  for (const a of raw) {
    if (!a || !a.ticker) continue;
    const tk = clip(a.ticker, 8).toUpperCase().replace(/[^A-Z.^-]/g, '');
    if (!tk || (valid && !valid.has(tk)) || out[tk]) continue;
    out[tk] = {
      direction: DIRECTIONS.includes(a.direction) ? a.direction : 'neutral',
      confidence: clampInt(a.confidence, 0, 100, 0),
      credibility: clampInt(a.credibility, 0, 100, 0),
      pumpRisk: PUMP_LEVELS.includes(a.pump_risk) ? a.pump_risk : 'medium',
      catalyst: clip(a.catalyst, 60),
      thesis: clip(a.thesis, 400),
      caution: a.caution ? clip(a.caution, 240) : null,
    };
  }
  return { assessments: out, notes: clip(input && input.notes, 600) };
}

// ── Bounded Fable call ────────────────────────────────────────────────────
/**
 * One bounded Fable-5 review of the top ranked alerts. Returns the parsed
 * { assessments, notes } or null on any failure (no key, timeout, no tool call).
 */
async function assessAlerts(topAlerts, timeoutMs = CALL_TIMEOUT_MS) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const alerts = (topAlerts || []).filter(a => a && a.ticker).slice(0, MAX_ASSESS);
  if (!alerts.length) return { assessments: {}, notes: '' };
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [ALERTS_FABLE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_alert_reviews' },
      messages: [{ role: 'user', content: buildAssessPrompt(alerts) }],
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_alert_reviews');
    if (!tool) return null;
    return parseAssessments(tool.input, alerts.map(a => a.ticker));
  } catch {
    return null;   // graceful — caller keeps the mechanical ranking
  }
}

// ── Merge onto ranked items ───────────────────────────────────────────────
/** Fable-derived 0-100 quality score used for reordering when promoted. Pure. */
function qualityScore(ai, mechScore) {
  const base = 0.5 * ai.confidence + 0.3 * ai.credibility + 0.2 * (Math.max(1, Math.min(5, mechScore || 1)) * 20);
  return Math.max(0, Math.min(100, Math.round(base - (PUMP_PENALTY[ai.pumpRisk] || 0))));
}

/**
 * Attach the cached Fable assessment onto each ranked item as `r.ai`. Adds
 * `agrees` (Fable direction matches the mechanical one) and `qualityScore`.
 * Non-destructive: returns new objects. Pure.
 */
function mergeAssessments(ranked, assessDoc) {
  const map = (assessDoc && assessDoc.assessments) || {};
  return (ranked || []).map(r => {
    const a = map[String(r.ticker).toUpperCase()];
    if (!a) return { ...r, ai: null };
    return {
      ...r,
      ai: {
        direction: a.direction,
        confidence: a.confidence,
        credibility: a.credibility,
        pumpRisk: a.pumpRisk,
        catalyst: a.catalyst || null,
        thesis: a.thesis || null,
        caution: a.caution || null,
        agrees: a.direction === r.direction,
        qualityScore: qualityScore(a, r.score),
      },
    };
  });
}

// ── A/B edge report: Fable direction vs mechanical direction ──────────────
function wilsonLower(k, n, z = WILSON_Z) {
  if (!n) return 0;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / d;
  return Math.max(0, c - h);
}
const dirHit = (dir, excess) => dir === 'bullish' ? excess > 0 : dir === 'bearish' ? excess < 0 : null;

/**
 * Paired A/B over graded log entries that carry a Fable direction. Compares the
 * Fable directional call to the mechanical one on the SAME calls, and decides
 * promotion (Fable proven better on enough samples). Pure.
 */
function fableEdgeReport(log) {
  const g = (log || []).filter(e => e && e.graded && e.excess != null && e.aiDirection);
  const paired = g.filter(e => dirHit(e.aiDirection, e.excess) != null && dirHit(e.direction, e.excess) != null);
  const n = paired.length;
  if (n < PROMOTE_MIN_GRADED) {
    return { n, minGraded: PROMOTE_MIN_GRADED, promoted: false, verdict: `TRACKING (${n}/${PROMOTE_MIN_GRADED} paired graded calls)` };
  }
  let fableHits = 0, mechHits = 0, overrides = 0, overrideHits = 0;
  for (const e of paired) {
    const fh = dirHit(e.aiDirection, e.excess), mh = dirHit(e.direction, e.excess);
    if (fh) fableHits++;
    if (mh) mechHits++;
    if (e.aiDirection !== e.direction) { overrides++; if (fh) overrideHits++; }   // did overriding the bot help?
  }
  const fableRate = fableHits / n, mechRate = mechHits / n;
  const fableLower = wilsonLower(fableHits, n);
  const promoted = fableRate - mechRate >= PROMOTE_MARGIN && fableLower > mechRate;
  return {
    n, minGraded: PROMOTE_MIN_GRADED,
    fableHitRatePct: +(100 * fableRate).toFixed(1),
    mechHitRatePct: +(100 * mechRate).toFixed(1),
    fableHitRateLB90: +(100 * fableLower).toFixed(1),
    overrides, overrideHitRatePct: overrides ? +(100 * overrideHits / overrides).toFixed(1) : null,
    promoted,
    verdict: promoted
      ? `PROMOTED: Fable direction beats the keyword bot (${(100 * fableRate).toFixed(1)}% vs ${(100 * mechRate).toFixed(1)}%, n=${n})`
      : `TRACKING: Fable ${(100 * fableRate).toFixed(1)}% vs bot ${(100 * mechRate).toFixed(1)}% — not yet a proven margin (n=${n})`,
  };
}

/**
 * When promoted, reorder by Fable quality and drop the clearly-junk alerts
 * (high pump-risk + low credibility). When not promoted, return input untouched.
 * Pure.
 */
function applyPromotion(rankedWithAi, promoted) {
  if (!promoted) return rankedWithAi;
  return rankedWithAi
    .filter(r => !(r.ai && r.ai.pumpRisk === 'high' && r.ai.credibility < 40))
    .sort((a, b) => {
      const qa = a.ai ? a.ai.qualityScore : -1, qb = b.ai ? b.ai.qualityScore : -1;
      return qb - qa || (b.weightedSignal - a.weightedSignal);
    });
}

module.exports = {
  MODEL, MAX_ASSESS, PROMOTE_MIN_GRADED, PROMOTE_MARGIN,
  ALERTS_FABLE_TOOL, buildAssessPrompt, parseAssessments, assessAlerts,
  qualityScore, mergeAssessments, fableEdgeReport, applyPromotion, wilsonLower,
};
