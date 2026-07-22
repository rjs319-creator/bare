'use strict';
// TRADE-LIFECYCLE PARSER — deterministic structured reading of a social post.
//
// Replaces the unsafe keyword-direction heuristic (calls⇒bullish, puts⇒bearish,
// sold/trimmed⇒bearish). Those are wrong: a SOLD PUT is bullish (income/entry), a BOUGHT
// PUT is bearish, "sold" can be closing a short (bullish) or taking profit on a long, and
// "trimmed" is a position update — NOT a new bearish prediction.
//
// Each post is parsed into a lifecycle EVENT plus any explicitly-stated fields. Crucially,
// only ENTRY/ADD/WATCH events create or refresh a directional thesis. EXIT/TRIM/STOP/TARGET/
// RECAP/COMMENTARY are position updates or retrospectives and must NEVER be turned into new
// directional predictions.
//
// Deterministic and pure. An optional bounded LLM semantic layer (lib/alerts-fable) resolves
// genuinely ambiguous language, but this parser is the always-available fallback.

const EVENTS = [
  'ENTRY_LONG', 'ENTRY_SHORT', 'ADD_LONG', 'ADD_SHORT', 'TRIM_LONG', 'TRIM_SHORT',
  'EXIT_LONG', 'EXIT_SHORT', 'STOP_HIT', 'TARGET_HIT', 'WATCH', 'RECAP', 'COMMENTARY', 'UNCLEAR',
];

// Events that ESTABLISH or refresh a directional thesis (may seed/extend an episode).
const THESIS_EVENTS = new Set(['ENTRY_LONG', 'ENTRY_SHORT', 'ADD_LONG', 'ADD_SHORT', 'WATCH']);

const TICKER_RE = /\$([A-Z]{1,5})\b/g;
const rx = (p, f = 'i') => new RegExp(p, f);

// ── Negation guard ───────────────────────────────────────────────────────────
// True if the token is negated within a short left window ("not buying", "no puts",
// "avoid shorting", "isn't a short"). Deliberately conservative — on a hit we downgrade
// certainty and let the event fall to WATCH/UNCLEAR rather than assert a wrong direction.
const NEG_RE = /\b(not|no|never|avoid|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|won'?t|without|stop(?:ped)? being)\b/i;
function negatedNear(text, idx, window = 24) {
  const left = text.slice(Math.max(0, idx - window), idx);
  return NEG_RE.test(left);
}

// ── Option semantics (buy/sell × call/put → underlying exposure) ──────────────
//   buy call  → long        sell call → short (covered-call income / bearish-neutral)
//   buy put   → short       sell put  → long  (cash-secured put / bullish income)
// The verb (open/close, buy/sell) flips the naive call/put reading — this is the whole point.
function optionExposure(action, optType) {
  if (!optType) return null;
  const selling = action === 'sell';
  if (optType === 'call') return selling ? 'short' : 'long';
  if (optType === 'put') return selling ? 'long' : 'short';
  return null;
}

const num = s => { const n = parseFloat(s); return Number.isFinite(n) && n > 0 && n < 1e6 ? +n.toFixed(2) : null; };

function extractOption(text) {
  // "$300c", "300 puts", "45C 6/21", "calls", "puts"
  const m = text.match(/\$?(\d{1,5}(?:\.\d{1,2})?)\s?(c|p|calls?|puts?)\b/i) || text.match(/\b(calls?|puts?)\b/i);
  if (!m) return null;
  const raw = (m[2] || m[1] || '').toLowerCase();
  const type = /^c/.test(raw) ? 'call' : /^p/.test(raw) ? 'put' : null;
  if (!type) return null;
  const strike = m[2] ? num(m[1]) : null;
  const exp = text.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/) || text.match(/\b(\d{1,2}\/\d{1,2})\b/);
  return { type, strike, expiry: exp ? exp[1] : null };
}

function extractLevels(text) {
  const grab = re => { const m = text.match(re); return m ? num(m[1]) : null; };
  const levels = {
    target: grab(/(?:target|tgt|\bpt\b|price target|goal|looking for)\s*[:=]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)/i),
    stop: grab(/(?:stop(?:\s?loss)?|\bsl\b|risk to|cut below)\s*[:=]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)/i),
    entry: grab(/(?:entry|enter|in at|got in|bought|adding|added|filled|avg)\s*[:=]?\s*\$?(\d{1,5}(?:\.\d{1,2})?)/i),
  };
  return (levels.target != null || levels.stop != null || levels.entry != null) ? levels : null;
}

function extractTimeframe(text) {
  if (/\b(day ?trade|scalp|0dte|intraday|eod|by close|today only)\b/i.test(text)) return 'day';
  if (/\b(swing|this week|next few days|few days|short[- ]?term|multi[- ]?day|overnight)\b/i.test(text)) return 'swing';
  if (/\b(long[- ]?term|invest(?:ing|ment)?|leaps?|months?|years?|position trade)\b/i.test(text)) return 'position';
  return null;
}

const CATALYST_TAGS = [
  ['earnings', /\b(earnings|eps|guidance|beat|results|report(?:s|ing|ed)?|\ber\b|print)\b/i],
  ['fda', /\b(fda|pdufa|approval|phase\s?[123]|trial|clinical|readout|topline)\b/i],
  ['breakout', /\b(break\s?out|breaking out|new high|all[- ]?time high|\bath\b|52[- ]?w(?:eek)?\s?high|cup and handle)\b/i],
  ['squeeze', /\b(squeeze|gamma|short interest|low float|\bftd\b|short\s?seller)\b/i],
  ['m&a', /\b(merger|acquisition|buyout|takeover|acquir(?:e|ed|es)|\bdeal\b|rumou?r)\b/i],
  ['analyst', /\b(upgrade|downgrade|price target|\bpt\b|initiat(?:e|ed|ion)|reiterat|overweight|outperform)\b/i],
  ['insider', /\b(insider|buyback|repurchase|form\s?4)\b/i],
  ['technical', /\b(support|resistance|trend(?:line)?|\bmacd\b|\brsi\b|\bvwap\b|moving average|\bfib\b|flag|wedge|pullback)\b/i],
];
function extractCatalysts(text) {
  const out = [];
  for (const [tag, re] of CATALYST_TAGS) if (re.test(text)) out.push(tag);
  return out;
}

// A conditional trigger: "if it breaks 50", "over 100", "above 4.20", "on a hold of".
function extractConditional(text) {
  const m = text.match(/\b(?:if|once|when|over|above|below|under|break(?:s)?(?:\s+above)?|hold(?:s)?(?:\s+above)?)\s+\$?(\d{1,5}(?:\.\d{1,2})?)/i);
  return m ? { level: num(m[1]), raw: m[0].slice(0, 40) } : null;
}

// ── Verb detection ───────────────────────────────────────────────────────────
const VERBS = {
  targetHit: /\b(target hit|hit (?:my |the )?target|tp\s?hit|took profit at target|price target hit)\b/i,
  stopHit: /\b(stopped out|stop(?:\s|-)?hit|hit (?:my |the )?stop|got stopped)\b/i,
  exit: /\b(sold all|closed|closing|exit(?:ed|ing)?|out of|took (?:the )?profit|booked|flat(?:tened)?|dumped|full exit)\b/i,
  trim: /\b(trim(?:med|ming)?|sold half|sold some|scal(?:ed|ing) out|took some off|reduc(?:ed|ing)|lighten(?:ed|ing)?)\b/i,
  add: /\b(add(?:ed|ing)?|adding more|loading (?:up|more)|building|scaling in|averaging)\b/i,
  buy: /\b(bought|buying|long(?:ing)?|entered|enter(?:ing)?|starter|opened|grabb?(?:ed|ing)|in at|got in|accumulat)\b/i,
  sellShort: /\b(short(?:ing|ed)?|sell short|puts? on)\b/i,
  sell: /\b(sold|selling|sell)\b/i,
  watch: /\b(watch(?:ing|list)?|eye(?:ing)?|radar|on watch|keep an eye|stalking|setup forming)\b/i,
  recap: /\b(recap|up \d+%|down \d+%|nice (?:trade|call|move)|great call|called it|paid|winner|\bgg\b|that trade)\b/i,
};

/**
 * Parse ONE textual segment (the neighborhood around a single ticker) into a lifecycle
 * event + directional exposure. Pure. Returns { event, direction, isNewThesis, uncertainty }.
 * direction is the POSITION side ('long'|'short'|null); for non-thesis events it labels the
 * position being acted on and is NOT a new prediction (isNewThesis=false).
 */
function classifySegment(seg) {
  const t = String(seg || '');
  const opt = extractOption(t);
  let uncertainty = /[?]|\b(maybe|might|thinking|considering|not sure|idk|possibly)\b/i.test(t) ? 'high' : 'low';

  // Resolution events first (unambiguous, terminal).
  if (VERBS.targetHit.test(t)) return { event: 'TARGET_HIT', direction: null, isNewThesis: false, uncertainty };
  if (VERBS.stopHit.test(t)) return { event: 'STOP_HIT', direction: null, isNewThesis: false, uncertainty };

  // Determine the ACTION verb (buy / sell / add / trim / exit).
  const hasAdd = VERBS.add.test(t);
  const hasTrim = VERBS.trim.test(t);
  const hasExit = VERBS.exit.test(t);
  const hasBuy = VERBS.buy.test(t) && !negatedNear(t, t.search(VERBS.buy));
  const hasSellShort = VERBS.sellShort.test(t) && !negatedNear(t, t.search(VERBS.sellShort));
  const hasSell = VERBS.sell.test(t);

  // Option semantics override naive call/put reading. An option ENTRY requires an AFFIRMATIVE
  // action verb — a negated "not buying puts" must NOT assert a short. Determine buy vs sell.
  if (opt) {
    const affirmativeBuy = hasBuy || hasAdd;
    const affirmativeSell = hasSell || hasSellShort;
    if (affirmativeBuy || affirmativeSell || hasTrim || hasExit) {
      const action = affirmativeSell && !affirmativeBuy ? 'sell' : 'buy';
      const exposure = optionExposure(action, opt.type);
      if (exposure) {
        if (hasTrim) return { event: exposure === 'long' ? 'TRIM_LONG' : 'TRIM_SHORT', direction: exposure, isNewThesis: false, uncertainty };
        if (hasExit && action !== 'sell') return { event: exposure === 'long' ? 'EXIT_LONG' : 'EXIT_SHORT', direction: exposure, isNewThesis: false, uncertainty };
        const evt = hasAdd ? (exposure === 'long' ? 'ADD_LONG' : 'ADD_SHORT') : (exposure === 'long' ? 'ENTRY_LONG' : 'ENTRY_SHORT');
        return { event: evt, direction: exposure, isNewThesis: true, uncertainty };
      }
    }
    // no affirmative action on the option → fall through (don't assert a direction)
  }

  // Equity semantics.
  if (hasTrim) {
    // Trimming/reducing an existing LONG (the common case) — a position update, not bearish.
    const side = hasSellShort ? 'short' : 'long';
    return { event: side === 'long' ? 'TRIM_LONG' : 'TRIM_SHORT', direction: side, isNewThesis: false, uncertainty };
  }
  if (hasExit) {
    const side = hasSellShort ? 'short' : 'long';
    return { event: side === 'long' ? 'EXIT_LONG' : 'EXIT_SHORT', direction: side, isNewThesis: false, uncertainty };
  }
  if (hasSellShort) {
    return { event: hasAdd ? 'ADD_SHORT' : 'ENTRY_SHORT', direction: 'short', isNewThesis: true, uncertainty };
  }
  if (hasBuy) {
    return { event: hasAdd ? 'ADD_LONG' : 'ENTRY_LONG', direction: 'long', isNewThesis: true, uncertainty };
  }
  // Bare "sold" with no short context = closing a long (position update, NOT bearish).
  if (hasSell) {
    return { event: 'EXIT_LONG', direction: 'long', isNewThesis: false, uncertainty };
  }
  if (VERBS.recap.test(t)) return { event: 'RECAP', direction: null, isNewThesis: false, uncertainty };
  if (VERBS.watch.test(t)) {
    // A watch may carry a directional lean from bullish/bearish adjectives, but it is soft.
    const lean = /\b(bull(?:ish)?|break ?out|long|higher|upside|breakout)\b/i.test(t) && !negatedNear(t, t.search(/\bbull|long|break/i))
      ? 'long'
      : /\b(bear(?:ish)?|short|lower|downside|breakdown|puts?)\b/i.test(t) ? 'short' : null;
    return { event: 'WATCH', direction: lean, isNewThesis: !!lean, uncertainty: 'high' };
  }
  // Bare directional adjectives with no verb.
  if (/\b(bull(?:ish)?|higher|upside|long)\b/i.test(t) && !negatedNear(t, t.search(/\bbull|long|higher|upside/i)))
    return { event: 'WATCH', direction: 'long', isNewThesis: true, uncertainty: 'high' };
  if (/\b(bear(?:ish)?|lower|downside|breakdown)\b/i.test(t) && !negatedNear(t, t.search(/\bbear|lower|downside|breakdown/i)))
    return { event: 'WATCH', direction: 'short', isNewThesis: true, uncertainty: 'high' };

  return { event: 'COMMENTARY', direction: null, isNewThesis: false, uncertainty };
}

// Split a post into per-ticker segments (neighborhood around each $TICKER) so a
// multi-ticker post can carry different lifecycle events per name.
function tickerSegments(text) {
  const ms = [...String(text).matchAll(TICKER_RE)];
  if (!ms.length) return [];
  if (ms.length === 1) return [{ ticker: ms[0][1], segment: text }];
  const out = [];
  for (let i = 0; i < ms.length; i++) {
    const a = i > 0 ? Math.floor((ms[i - 1].index + ms[i - 1][0].length + ms[i].index) / 2) : 0;
    const b = i + 1 < ms.length ? Math.floor((ms[i].index + ms[i][0].length + ms[i + 1].index) / 2) : text.length;
    out.push({ ticker: ms[i][1], segment: text.slice(a, b) });
  }
  return out;
}

/**
 * Full deterministic parse of a post. Returns post-level extracted fields plus one lifecycle
 * record per ticker mention. `assetType` is 'option' when option contracts are named, else 'stock'.
 */
function parsePost(text) {
  const t = String(text || '');
  const opt = extractOption(t);
  const perTicker = tickerSegments(t).map(({ ticker, segment }) => {
    const c = classifySegment(segment);
    return { ticker, ...c };
  });
  return {
    event: perTicker[0] ? perTicker[0].event : 'COMMENTARY',
    perTicker,
    assetType: opt ? 'option' : 'stock',
    option: opt,
    levels: extractLevels(t),
    timeframe: extractTimeframe(t),
    catalysts: extractCatalysts(t),
    conditional: extractConditional(t),
  };
}

module.exports = {
  EVENTS, THESIS_EVENTS, optionExposure, classifySegment, tickerSegments, parsePost,
  extractOption, extractLevels, extractTimeframe, extractCatalysts, extractConditional, negatedNear,
};
