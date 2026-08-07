'use strict';
// SOCIAL ATTENTION & NARRATIVE — tech-command-sentiment-v1.
//
// Reuses the app's archived StockTwits trending history (lib/attention
// classifyAttention) and projects it onto the technology universe with the states
// the spec requires.
//
// WHAT THIS IS AND IS NOT:
//   • ATTENTION is not SENTIMENT. This section measures how much a name is being
//     talked about and how that is changing. It does not claim to know whether the
//     talk is bullish, and "trending" is never reported as "bullish".
//   • COVERAGE IS PARTIAL. The archive records names that appeared on a trending
//     list. A name absent from a day's archive has NO OBSERVATION — it is not zero
//     mentions. Missing coverage produces INSUFFICIENT_COVERAGE, never a low score.
//   • This is not a social firehose. It is one provider's trending list, sampled
//     daily, and it is labeled as such.
//   • Social evidence cannot independently create an actionable trade — weight 0.
//
// Pure: classifier output + price context in, frozen section out.

const SENTIMENT_VERSION = 'tech-command-sentiment-v1';

const STATES = Object.freeze([
  'EARLY_BUILDING', 'STICKY_ATTENTION', 'FLASH_SPIKE', 'SATURATED',
  'COORDINATED', 'DIVERGING_FROM_PRICE', 'INSUFFICIENT_COVERAGE',
]);

const SATURATION_PRESENCE = 8;      // present nearly every day in the window
const COORDINATION_REPEAT = 0.9;    // ≥ this share of readings identical ⇒ mechanical repetition
const DIVERGENCE_PCT = 1.0;         // attention up while price is flat/down by this much

const num = v => (Number.isFinite(v) ? v : null);

/**
 * @param {{attention: object, universe: object, priceContext?: Object<string, object>,
 *          now?: Date, trustworthy?: boolean}} input
 *   attention: lib/attention classifyAttention output { asOf, window, trustworthy, byTicker }
 *   priceContext: { TICKER: { pctChange5d, pctChange1d, relVol } }
 */
function buildSentimentSection({ attention, universe, priceContext = {}, now = new Date() } = {}) {
  const nowIso = new Date(now).toISOString();
  const byTicker = (universe && universe.byTicker) || {};
  const src = (attention && attention.byTicker) || {};
  const windowDays = (attention && attention.window) || 0;
  const trustworthy = !!(attention && attention.trustworthy);

  const rows = Object.entries(src)
    .filter(([t]) => byTicker[t])
    .map(([ticker, a]) => {
      const u = byTicker[ticker];
      const px = priceContext[ticker] || null;
      const presence = num(a.presence) ?? 0;
      const latest = num(a.latestMentions);
      const peak = num(a.peakMentions);
      const velocity = (latest != null && peak > 0) ? +(latest / peak).toFixed(2) : null;
      const persistence = windowDays ? +(presence / windowDays).toFixed(2) : null;
      const repeated = (latest != null && peak != null && latest === peak && presence >= 4);

      let state;
      if (!trustworthy || presence === 0) state = 'INSUFFICIENT_COVERAGE';
      else if (repeated && persistence != null && persistence >= COORDINATION_REPEAT) state = 'COORDINATED';
      else if (presence >= SATURATION_PRESENCE) state = 'SATURATED';
      else if (px && num(px.pctChange5d) != null && a.rising === true && px.pctChange5d <= -DIVERGENCE_PCT) state = 'DIVERGING_FROM_PRICE';
      else if (a.class === 'Sticky') state = 'STICKY_ATTENTION';
      else if (a.class === 'Fast') state = 'FLASH_SPIKE';
      else state = 'EARLY_BUILDING';

      return Object.freeze({
        ticker, company: u.company, subsector: u.subsector, subsectorLabel: u.subsectorLabel,
        state,
        stateExplanation: explain(state),
        // Attention measures — explicitly NOT sentiment.
        attentionPresenceDays: presence,
        windowDays,
        latestMentions: latest,
        peakMentions: peak,
        attentionVelocityVsPeak: velocity,
        persistence,
        rising: a.rising ?? null,
        fadingFromPeak: a.fadingFromPeak ?? null,
        trendRank: num(a.rank),
        firstSeen: a.firstSeen || null,
        lastSeen: a.lastSeen || null,
        // Price cross-check (attention vs response).
        priceChange1d: px ? num(px.pctChange1d) : null,
        priceChange5d: px ? num(px.pctChange5d) : null,
        priceConfirmed: (px && num(px.pctChange5d) != null && a.rising != null)
          ? (a.rising === true && px.pctChange5d > 0) : null,
        // Honesty invariants.
        sentiment: null,
        sentimentNote: 'This source measures ATTENTION only. No bullish/bearish sentiment is inferred from it.',
        weight: 0,
        canOriginate: false,
        researchOnly: true,
        coverage: 'StockTwits trending-list membership, sampled daily. A name absent from a day\'s list has NO observation for that day — that is not zero mentions.',
        asOf: (attention && attention.asOf) || null,
      });
    })
    .sort((a, b) => (b.latestMentions ?? 0) - (a.latestMentions ?? 0));

  const byState = Object.fromEntries(STATES.map(s => [s, rows.filter(r => r.state === s).map(r => r.ticker)]));

  return Object.freeze({
    schema: SENTIMENT_VERSION,
    generatedAt: nowIso,
    asOf: (attention && attention.asOf) || null,
    windowDays,
    trustworthy,
    trustNote: trustworthy ? null : `Fewer than the minimum archived days are available (${windowDays}) — every attention read here is still accruing and should not be leaned on.`,
    rows: Object.freeze(rows),
    byState: Object.freeze(byState),
    counts: Object.freeze({ total: rows.length, ...Object.fromEntries(STATES.map(s => [s, byState[s].length])) }),
    weight: 0,
    firehose: false,
    empty: rows.length === 0,
    emptyReason: rows.length === 0
      ? 'No technology names appear in the archived attention window — this means no coverage, not no interest.'
      : null,
  });
}

function explain(state) {
  switch (state) {
    case 'EARLY_BUILDING': return 'Attention is starting to build but has not persisted long enough to mean anything yet.';
    case 'STICKY_ATTENTION': return 'Attention has persisted across many days rather than spiking once — research evidence only, until validated.';
    case 'FLASH_SPIKE': return 'A short burst of attention. Fast attention is treated as a possible crowding RISK, not as a bullish signal.';
    case 'SATURATED': return 'The name has been on the trending list nearly every day in the window — the crowd already knows. Treat as crowding risk.';
    case 'COORDINATED': return 'Readings look mechanically repetitive across days — possible coordinated or duplicated posting. Discount entirely.';
    case 'DIVERGING_FROM_PRICE': return 'Attention is rising while price is falling — the story and the tape disagree.';
    default: return 'Not enough archived coverage for this name to say anything. Missing mentions are not zero mentions.';
  }
}

module.exports = { SENTIMENT_VERSION, STATES, SATURATION_PRESENCE, COORDINATION_REPEAT, buildSentimentSection, explain };
