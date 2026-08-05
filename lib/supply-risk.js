'use strict';
// SUPPLY / DILUTION RISK — the odds that new shares are about to meet the demand driving a
// move. This is the single biggest reason a low-float ignition reverses: the company sells
// into it.
//
// DESIGN DECISION (from the spec): high dilution risk does NOT remove a name from Explosion
// Discovery. A stock with an active at-the-market program can still be the day's biggest
// mover — refusing to see it would defeat the recall objective. What high supply risk does
// is (a) penalize TRADE QUALITY, (b) raise a visible warning, and (c) block LIVE
// actionability unless a template has specifically been validated on this group.
//
// DATA HONESTY: the app has no filings-index entitlement, so this classifier reads COMPANY
// NEWS HEADLINES plus the price/volume record (reverse splits are visible as a clean
// multiplicative jump with no volume confirmation). That is genuinely weaker than parsing
// 424B5/S-3/8-K filings, and every result carries `basis` saying so. When there is no news at
// all the answer is UNKNOWN — not LOW. "We didn't find an offering" and "there is no
// offering" are different claims and only one of them is supportable here.

const { SUPPLY_RISK_VERSION } = require('./lowfloat-config');

// ── Headline classifiers, ordered by severity. Each carries the evidence class it proves.
const PATTERNS = Object.freeze([
  // WEIGHTS: a single piece of evidence at or above RISK_BANDS.HIGH (55) is enough to call
  // the name HIGH on its own. That is deliberate for the three classes that directly mean
  // "the company is selling shares into your rally" — a live offering, a live ATM, or a
  // priced underwritten deal. Everything else needs corroboration to reach HIGH.
  { key: 'REGISTERED_DIRECT', weight: 60, rx: /\b(registered direct|private placement|PIPE financing|securities purchase agreement)\b/i },
  { key: 'UNDERWRITTEN_OFFERING', weight: 60, rx: /\b(underwritten (public )?offering|public offering of (common stock|shares)|pricing of .{0,30}offering|prices? \$[\d.]+ ?(million|m)\b.{0,30}offering)/i },
  { key: 'ATM_PROGRAM', weight: 55, rx: /\b(at[- ]the[- ]market( (offering|program|facility|sales agreement))?|ATM (offering|program|facility))\b/i },
  { key: 'SHELF_REGISTRATION', weight: 18, rx: /\b(shelf registration|S-3 (registration|shelf)|mixed shelf|universal shelf|registration statement (became|declared) effective)\b/i },
  { key: 'CONVERTIBLE_DEBT', weight: 30, rx: /\bconvertible (note|debenture|senior note|preferred|bond)s?\b/i },
  { key: 'WARRANT_ISSUANCE', weight: 25, rx: /\b(warrant (exercise|inducement|repricing)|accompanying warrants|issuance of warrants)\b/i },
  { key: 'REVERSE_SPLIT', weight: 30, rx: /\breverse (stock )?split\b/i },
  { key: 'SHARE_ISSUANCE', weight: 22, rx: /\b(issuance of .{0,20}(million )?shares|share issuance|equity (financing|raise)|capital raise)\b/i },
  { key: 'LOCKUP_EXPIRATION', weight: 20, rx: /\block[- ]?up (expir|releas|agreement ends)/i },
  { key: 'GOING_CONCERN', weight: 35, rx: /\bgoing concern\b|\bsubstantial doubt\b/i },
  { key: 'BANKRUPTCY', weight: 45, rx: /\b(chapter 11|chapter 7|bankruptcy|receivership|liquidation)\b/i },
  { key: 'MERGER_CONSIDERATION', weight: 15, rx: /\b(definitive merger agreement|to be acquired|acquisition of .{0,30}by|all[- ]cash (merger|transaction))\b/i },
  { key: 'DELISTING_NOTICE', weight: 30, rx: /\b(deficiency (letter|notice)|delisting|minimum bid price|compliance notice)\b/i },
]);

// Recency weighting: a financing announced this week is materially more dangerous than one
// from four months ago. Older than MAX_LOOKBACK_DAYS is not counted at all.
const RECENT_DAYS = 21;
const MAX_LOOKBACK_DAYS = 120;
const DAY_MS = 86_400_000;

const RISK_BANDS = Object.freeze({ HIGH: 55, MODERATE: 25 });

// Reverse-split price signature: a clean multiplicative jump in the close with volume that
// did NOT confirm it. Real 3-10× moves trade many multiples of average volume; a ratio
// rescale trades normal volume. Mirrors the split-artifact guard in lib/daytrade.js.
const SPLIT_JUMP_MIN = 1.8;
const SPLIT_MAX_RELVOL = 2.0;

function newsAgeDays(row, now) {
  const raw = row && (row.datetime ?? row.publishedDate ?? row.date);
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return (new Date(now).getTime() - ms) / DAY_MS;
}

// Pure: scan headlines for supply-risk evidence. Returns matched evidence with ages.
function scanHeadlines(newsRows, { now = new Date() } = {}) {
  const evidence = [];
  for (const row of newsRows || []) {
    const text = `${(row && row.title) || ''} ${(row && row.text) || ''}`;
    if (!text.trim()) continue;
    const ageDays = newsAgeDays(row, now);
    if (ageDays != null && ageDays > MAX_LOOKBACK_DAYS) continue;
    for (const p of PATTERNS) {
      if (!p.rx.test(text)) continue;
      evidence.push({
        key: p.key,
        weight: p.weight,
        headline: String((row && row.title) || '').slice(0, 180),
        ageDays: ageDays == null ? null : +ageDays.toFixed(1),
        recent: ageDays != null && ageDays <= RECENT_DAYS,
        sourceDate: row && (row.datetime ?? row.publishedDate ?? row.date) ? String(row.datetime ?? row.publishedDate ?? row.date) : null,
      });
    }
  }
  return evidence;
}

// Pure: detect a recent reverse split from daily candles. Returns null when the candles
// cannot support the inference (too short, or the jump was volume-confirmed = a real move).
function detectReverseSplit(candles, { lookback = 60 } = {}) {
  if (!Array.isArray(candles) || candles.length < 25) return null;
  const start = Math.max(21, candles.length - lookback);
  for (let i = candles.length - 1; i >= start; i--) {
    const c = candles[i], prev = candles[i - 1];
    if (!c || !prev || !(prev.close > 0) || !(c.close > 0)) continue;
    const ratio = c.close / prev.close;
    if (ratio < SPLIT_JUMP_MIN) continue;
    let avg = 0, n = 0;
    for (let k = Math.max(0, i - 20); k < i; k++) { avg += (candles[k].volume || 0); n++; }
    avg = n ? avg / n : 0;
    const relVol = avg > 0 ? (c.volume || 0) / avg : 0;
    if (relVol < SPLIT_MAX_RELVOL) {
      return {
        detected: true,
        date: c.date || null,
        impliedRatio: +ratio.toFixed(2),
        relVolOnJump: +relVol.toFixed(2),
        basis: 'price-jump-without-volume-confirmation (inferred, not a filing)',
      };
    }
  }
  return null;
}

// Pure: fold evidence into the supply-risk assessment.
function assessSupplyRisk({ evidence = [], reverseSplit = null, newsAvailable = true, floatPctOfOutstanding = null } = {}) {
  const sourceDates = [];
  let score = 0;
  const has = key => evidence.some(e => e.key === key);

  for (const e of evidence) {
    // Recent evidence counts at full weight; older at half. Repeated mentions of the SAME
    // class do not stack (one offering announced by five outlets is one offering).
    const seenBefore = sourceDates.some(d => d.key === e.key);
    if (!seenBefore) {
      score += e.recent ? e.weight : e.weight * 0.5;
      sourceDates.push({ key: e.key, date: e.sourceDate, ageDays: e.ageDays });
    }
  }
  if (reverseSplit && reverseSplit.detected) {
    if (!has('REVERSE_SPLIT')) score += 20;
    sourceDates.push({ key: 'REVERSE_SPLIT_INFERRED', date: reverseSplit.date, ageDays: null });
  }
  // A tiny public float relative to shares outstanding means most of the company is NOT yet
  // in the market — a structural overhang independent of any announcement.
  if (Number.isFinite(floatPctOfOutstanding) && floatPctOfOutstanding > 0 && floatPctOfOutstanding < 20) {
    score += 10;
    sourceDates.push({ key: 'LOW_FLOAT_PCT_OF_OUTSTANDING', date: null, ageDays: null });
  }

  let dilutionRisk;
  if (!newsAvailable && !reverseSplit) dilutionRisk = 'UNKNOWN';
  else if (score >= RISK_BANDS.HIGH) dilutionRisk = 'HIGH';
  else if (score >= RISK_BANDS.MODERATE) dilutionRisk = 'MODERATE';
  else if (evidence.length === 0 && !reverseSplit) dilutionRisk = newsAvailable ? 'LOW' : 'UNKNOWN';
  else dilutionRisk = 'LOW';

  return {
    schema: SUPPLY_RISK_VERSION,
    dilutionRisk,
    riskScore: Math.min(100, Math.round(score)),
    activeOfferingRisk: has('REGISTERED_DIRECT') || has('UNDERWRITTEN_OFFERING') || has('SHARE_ISSUANCE'),
    atmRisk: has('ATM_PROGRAM'),
    shelfRisk: has('SHELF_REGISTRATION'),
    convertibleRisk: has('CONVERTIBLE_DEBT'),
    warrantOverhang: has('WARRANT_ISSUANCE'),
    lockupExpiration: has('LOCKUP_EXPIRATION'),
    reverseSplitRecent: has('REVERSE_SPLIT') || !!(reverseSplit && reverseSplit.detected),
    mergerConsideration: has('MERGER_CONSIDERATION'),
    goingConcern: has('GOING_CONCERN') || has('BANKRUPTCY'),
    delistingRisk: has('DELISTING_NOTICE'),
    evidence: evidence.slice(0, 8),
    reverseSplit,
    sourceDates,
    basis: newsAvailable
      ? 'headline classification + price-record inference — NOT a filings-index parse. Absence of evidence is not evidence of absence.'
      : 'no news was available for this name — risk is UNKNOWN, not low.',
    newsAvailable,
  };
}

// Network wrapper: fetch recent company news and assess. Failures degrade to UNKNOWN with
// the reason recorded; they never throw into the scan.
async function fetchSupplyRisk(ticker, { now = new Date(), candles = null, floatPctOfOutstanding = null, lookbackDays = 90 } = {}) {
  const { fetchCompanyNews } = require('./fundamentals');
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(new Date(now).getTime() - lookbackDays * DAY_MS).toISOString().slice(0, 10);
  let news = [], newsAvailable = true, fetchError = null;
  try {
    news = await fetchCompanyNews(ticker, from, to);
    if (!Array.isArray(news) || !news.length) { news = []; newsAvailable = false; }
  } catch (e) {
    news = []; newsAvailable = false; fetchError = String((e && e.message) || e);
  }
  const evidence = scanHeadlines(news, { now });
  const reverseSplit = detectReverseSplit(candles);
  const out = assessSupplyRisk({ evidence, reverseSplit, newsAvailable, floatPctOfOutstanding });
  return { ...out, ticker: String(ticker || '').toUpperCase(), fetchError, newsCount: news.length };
}

// The UNKNOWN default a caller uses when supply risk was not evaluated at all (budget,
// deadline, flag off). Explicit, so a missing assessment can never read as "safe".
function unknownSupplyRisk(ticker = null) {
  return {
    schema: SUPPLY_RISK_VERSION, ticker, dilutionRisk: 'UNKNOWN', riskScore: null,
    activeOfferingRisk: false, atmRisk: false, shelfRisk: false, convertibleRisk: false,
    warrantOverhang: false, lockupExpiration: false, reverseSplitRecent: false,
    mergerConsideration: false, goingConcern: false, delistingRisk: false,
    evidence: [], reverseSplit: null, sourceDates: [],
    basis: 'not evaluated this cycle', newsAvailable: false,
  };
}

module.exports = {
  PATTERNS, RISK_BANDS, RECENT_DAYS, MAX_LOOKBACK_DAYS,
  scanHeadlines, detectReverseSplit, assessSupplyRisk, fetchSupplyRisk, unknownSupplyRisk,
  newsAgeDays, SUPPLY_RISK_VERSION,
};
