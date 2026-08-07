'use strict';
// CATALYST CONTEXT — what happened, how recently, how material, and whether it is actually
// NEW. A same-session explosion almost always has a reason; a stock up 40% with no
// identifiable catalyst is a different (and usually worse) animal than one up 40% on a
// pivotal trial readout.
//
// RELATIONSHIP TO lib/gapgo.js `classifyGapCause`: that function answers a narrow question
// (which of five gap causes best explains an overnight gap) and feeds the multi-day pcarry
// model. This module answers the same-session question — tier, freshness, materiality,
// novelty, source quality — and REUSES classifyGapCause as one of its inputs so the two
// never drift apart on the shared classes.
//
// NO LLM. Section 23 of the spec is explicit and so is the app's own rule: nothing in the
// live market-scoring path may call a language model. This is deterministic regex + arithmetic
// on provider-supplied headlines and timestamps, which also makes it unit-testable and free.

const { CATALYST_VERSION } = require('./lowfloat-config');

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// ── Tiered classifiers. First match in this order wins the TYPE; the tier follows the type.
// Ordering encodes materiality: a pivotal FDA decision outranks a conference presentation
// even when both appear in the same news window.
const CLASSIFIERS = Object.freeze([
  // TIER 1 — events that re-price a company
  // NB: these alternatives are word STEMS ("approv" must match "approval"/"approved"), so the
  // group carries no trailing \b — a trailing boundary would reject the very suffixes the
  // stems exist to catch.
  { type: 'FDA_APPROVAL', tier: 1, rx: /\b(FDA (approv|clearance|authoriz)|approved by the FDA|PDUFA|marketing authoriz|CE mark|breakthrough therapy designation)/i },
  { type: 'PIVOTAL_CLINICAL', tier: 1, rx: /\b(phase 3|phase III|pivotal (trial|study)|met (the )?primary endpoint|topline results|statistically significant.{0,25}endpoint)\b/i },
  { type: 'ACQUISITION', tier: 1, rx: /\b(to be acquired|definitive (merger|acquisition) agreement|agrees to acquire|all[- ]cash (merger|transaction)|takeover (bid|offer)|tender offer)\b/i },
  { type: 'MAJOR_CONTRACT', tier: 1, rx: /\b(\$\s?\d+(\.\d+)?\s?(billion|B)\b.{0,40}(contract|order|award)|awarded a .{0,25}(contract|order)|multi[- ]year (contract|agreement) (worth|valued))\b/i },
  { type: 'GUIDANCE_RAISE', tier: 1, rx: /\b(raises? (full[- ]year |FY ?\d* )?(guidance|outlook|forecast)|boosts? outlook|beats? and raises)\b/i },
  { type: 'REGULATORY_OUTCOME', tier: 1, rx: /\b(court (rules|ruling)|patent (upheld|granted|victory)|wins? (appeal|lawsuit|arbitration)|regulatory approval)\b/i },
  // TIER 2 — meaningful company-specific developments
  { type: 'PARTNERSHIP', tier: 2, rx: /\b(strategic (partnership|alliance|collaboration)|partners? with|joint venture|licensing agreement)\b/i },
  { type: 'TRIAL_UPDATE', tier: 2, rx: /\b(phase 1|phase 2|phase I\b|phase II\b|interim (results|analysis)|enrollment (complete|initiated)|IND clearance|orphan drug designation|fast track)\b/i },
  { type: 'EARNINGS', tier: 2, rx: /\b(quarterly results|Q[1-4] (results|earnings)|reports? (fourth|third|second|first) quarter|earnings (beat|miss)|EPS of)\b/i },
  { type: 'CONTRACT', tier: 2, rx: /\b(contract|purchase order|awarded|selected by|wins? .{0,20}(deal|order))\b/i },
  { type: 'ANALYST_ACTION', tier: 2, rx: /\b(upgrade[sd]? to (buy|overweight|outperform)|initiat(es|ed) (coverage )?(with|at) (buy|overweight)|price target (raised|hiked))\b/i },
  { type: 'INSIDER_BUYING', tier: 2, rx: /\b(insider (buying|purchase)|CEO (buys|purchases)|director (buys|purchases) .{0,20}shares)\b/i },
  // TIER 3 — weak, context-only
  { type: 'CONFERENCE', tier: 3, rx: /\b(to present at|presentation at|investor (day|conference)|webcast|poster (presentation|session))\b/i },
  { type: 'SECTOR_SYMPATHY', tier: 3, rx: /\b(sector (rally|move)|peers? (rally|surge)|sympathy (play|move)|industry[- ]wide)\b/i },
  { type: 'PRODUCT_UPDATE', tier: 3, rx: /\b(launches?|unveils?|introduces?|announces? the availability)\b/i },
  // TIER 4 — dilution and noise. Present as a catalyst CLASS so it is visible, but it never
  // earns catalyst credit (the scorer treats tier 4 as zero and supply-risk penalizes it).
  { type: 'DILUTIVE_FINANCING', tier: 4, rx: /\b(offering|private placement|at[- ]the[- ]market|registered direct|convertible note|shelf registration|capital raise)\b/i },
  { type: 'SOCIAL_ATTENTION', tier: 4, rx: /\b(trending on|reddit|wallstreetbets|social media buzz|retail traders?)\b/i },
]);

// Source quality. Primary = the company or a regulator; wire = a major newswire; aggregator =
// everything else. Materiality claims from an aggregator are discounted.
const PRIMARY_SOURCES = /\b(businesswire|business wire|globenewswire|globe newswire|pr newswire|prnewswire|accesswire|sec\.gov|fda\.gov|company press release)\b/i;
const WIRE_SOURCES = /\b(reuters|bloomberg|dow jones|associated press|\bap\b|marketwatch|barron|wsj|wall street journal|cnbc)\b/i;

const TIER_LABEL = Object.freeze({
  1: 'Tier 1 — re-pricing event',
  2: 'Tier 2 — meaningful development',
  3: 'Tier 3 — context only',
  4: 'Tier 4 — no credit (dilutive or attention-only)',
});

function toMs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const p = Date.parse(raw);
  return Number.isFinite(p) ? p : null;
}

function sourceQuality(row) {
  const s = `${(row && row.publisher) || ''} ${(row && row.site) || ''} ${(row && row.url) || ''} ${(row && row.source) || ''}`;
  if (PRIMARY_SOURCES.test(s)) return 'PRIMARY';
  if (WIRE_SOURCES.test(s)) return 'WIRE';
  return 'AGGREGATOR';
}

// Classify ONE headline. Returns null when nothing matches.
function classifyHeadline(row) {
  const text = `${(row && row.title) || ''} ${(row && row.text) || ''}`;
  if (!text.trim()) return null;
  for (const c of CLASSIFIERS) {
    if (c.rx.test(text)) return { catalystType: c.type, catalystTier: c.tier };
  }
  return null;
}

// Surprise magnitude for the classes where a number is extractable from the headline. Returns
// a 0-1 scale or null. Deliberately conservative: an unparseable headline is null, not 0.5.
function extractSurpriseMagnitude(text, type) {
  if (!text) return null;
  if (type === 'GUIDANCE_RAISE' || type === 'EARNINGS') {
    const m = text.match(/\b(beats?|tops?|exceeds?)\b.{0,30}?by\s+(\d+(?:\.\d+)?)\s?%/i);
    if (m) return Math.min(1, parseFloat(m[2]) / 50);
    if (/\b(beat|tops|exceeds)\b/i.test(text)) return 0.4;
    return null;
  }
  if (type === 'MAJOR_CONTRACT' || type === 'CONTRACT') {
    const m = text.match(/\$\s?(\d+(?:\.\d+)?)\s?(billion|million|B|M)\b/i);
    if (!m) return null;
    const v = parseFloat(m[1]) * (/^(b|billion)$/i.test(m[2]) ? 1000 : 1);   // $ millions
    return Math.min(1, v / 500);
  }
  return null;
}

// Clinical stage where the headline reveals it (drives materiality inside the biotech tiers).
function extractClinicalStage(text) {
  if (!text) return null;
  if (/\b(phase 3|phase III|pivotal|registrational)\b/i.test(text)) return 'PHASE_3';
  if (/\b(phase 2|phase II)\b/i.test(text)) return 'PHASE_2';
  if (/\b(phase 1|phase I)\b/i.test(text)) return 'PHASE_1';
  if (/\b(preclinical|IND)\b/i.test(text)) return 'PRECLINICAL';
  if (/\b(FDA approv|PDUFA|NDA\b|BLA\b|marketing authoriz)/i.test(text)) return 'REGULATORY';
  return null;
}

// ── The pure orchestrator ────────────────────────────────────────────────────
// `newsRows` = [{ title, text, datetime|publishedDate, publisher|site|url }].
// `now` anchors freshness. `sessionOpenIso` (optional) lets `isNewToday` distinguish a
// catalyst published DURING this session from one published a week ago.
function buildCatalystContext(newsRows, { now = new Date(), sessionOpenIso = null, priorHeadlines = [] } = {}) {
  const nowMs = new Date(now).getTime();
  const rows = Array.isArray(newsRows) ? newsRows : [];

  const scored = [];
  for (const row of rows) {
    const cls = classifyHeadline(row);
    if (!cls) continue;
    const ms = toMs(row.datetime ?? row.publishedDate ?? row.date);
    const freshnessMinutes = ms == null ? null : Math.max(0, Math.round((nowMs - ms) / MIN_MS));
    const text = `${row.title || ''} ${row.text || ''}`;
    scored.push({
      ...cls,
      title: String(row.title || '').slice(0, 200),
      publishedAt: ms == null ? null : new Date(ms).toISOString(),
      freshnessMinutes,
      sourceQuality: sourceQuality(row),
      surpriseMagnitude: extractSurpriseMagnitude(text, cls.catalystType),
      clinicalStage: extractClinicalStage(text),
      dilutionConnection: cls.catalystTier === 4 && cls.catalystType === 'DILUTIVE_FINANCING',
    });
  }

  if (!scored.length) {
    return {
      schema: CATALYST_VERSION,
      catalystPresent: false, catalystType: 'NONE', catalystTier: 4,
      tierLabel: TIER_LABEL[4], publishedAt: null, freshnessMinutes: null,
      sourceQuality: null, isNewToday: false, isRecycled: false,
      materiality: 0, surpriseMagnitude: null, financialMateriality: null,
      clinicalStage: null, dilutionConnection: false,
      gapCause: 'NONE', evidence: [],
      note: rows.length
        ? 'News was available but nothing matched a material-catalyst class — treat this as an unexplained move.'
        : 'No news was available for this name — catalyst is unknown, and the scorer awards no catalyst credit.',
    };
  }

  // The DRIVING catalyst is the best (lowest) tier; ties break toward the freshest.
  scored.sort((a, b) => (a.catalystTier - b.catalystTier)
    || ((a.freshnessMinutes ?? 1e9) - (b.freshnessMinutes ?? 1e9)));
  const top = scored[0];

  const sessionOpenMs = sessionOpenIso ? Date.parse(sessionOpenIso) : null;
  const publishedMs = top.publishedAt ? Date.parse(top.publishedAt) : null;
  const isNewToday = publishedMs != null && (
    sessionOpenMs != null
      ? publishedMs >= sessionOpenMs - 18 * 3600 * 1000   // includes the overnight/premarket window
      : (nowMs - publishedMs) <= DAY_MS
  );

  // RECYCLED: the same catalyst class already appeared in the prior-day headline set, or the
  // driving headline is materially older than a day while the stock is moving now. A recycled
  // announcement gets a reduced score — the market has already seen it.
  const priorBlob = (priorHeadlines || []).join(' \n ').toLowerCase();
  const titleKey = top.title.toLowerCase().slice(0, 60);
  const isRecycled = (titleKey.length > 15 && priorBlob.includes(titleKey))
    || (top.freshnessMinutes != null && top.freshnessMinutes > 48 * 60);

  return {
    schema: CATALYST_VERSION,
    catalystPresent: true,
    catalystType: top.catalystType,
    catalystTier: top.catalystTier,
    tierLabel: TIER_LABEL[top.catalystTier],
    publishedAt: top.publishedAt,
    freshnessMinutes: top.freshnessMinutes,
    sourceQuality: top.sourceQuality,
    isNewToday,
    isRecycled,
    materiality: materialityScore(top, { isNewToday, isRecycled }),
    surpriseMagnitude: top.surpriseMagnitude,
    financialMateriality: top.surpriseMagnitude,
    clinicalStage: top.clinicalStage,
    dilutionConnection: scored.some(s => s.dilutionConnection),
    gapCause: gapCauseFor(rows),
    evidence: scored.slice(0, 5),
    note: null,
  };
}

// 0-1 materiality. Tier is the backbone; source quality, freshness and novelty modulate it.
// Tier 4 is pinned to 0 — a dilutive financing or a Reddit mention is never "material" in the
// direction that helps a long.
function materialityScore(top, { isNewToday, isRecycled } = {}) {
  if (top.catalystTier >= 4) return 0;
  const base = { 1: 1.0, 2: 0.6, 3: 0.25 }[top.catalystTier] ?? 0;
  const srcMult = top.sourceQuality === 'PRIMARY' ? 1.0 : top.sourceQuality === 'WIRE' ? 0.9 : 0.7;
  const freshMult = top.freshnessMinutes == null ? 0.7
    : top.freshnessMinutes <= 60 ? 1.0
    : top.freshnessMinutes <= 6 * 60 ? 0.9
    : top.freshnessMinutes <= 24 * 60 ? 0.75
    : 0.45;
  const noveltyMult = isRecycled ? 0.4 : (isNewToday ? 1.0 : 0.7);
  const surpriseBonus = top.surpriseMagnitude != null ? 1 + 0.2 * top.surpriseMagnitude : 1;
  return +Math.max(0, Math.min(1, base * srcMult * freshMult * noveltyMult * surpriseBonus)).toFixed(3);
}

// Bridge to the legacy 5-class gap-cause taxonomy so pcarry and the new stack agree.
function gapCauseFor(rows) {
  try { return require('./gapgo').classifyGapCause(rows); } catch { return 'NONE'; }
}

// ── Cache reassessment ───────────────────────────────────────────────────────
// A cached catalyst context is only ever as fresh as the moment it was fetched.
// `freshnessMinutes` (and the materiality it feeds) must be recomputed against the CURRENT
// clock on every read — a headline cached fresh ten minutes ago is correctly stale an hour
// later, without a refetch. Mirrors lib/float-data.js's `reassess`.
function reassessCatalyst(record, now = new Date()) {
  if (!record || !record.publishedAt) return record;
  const publishedMs = Date.parse(record.publishedAt);
  if (!Number.isFinite(publishedMs)) return record;
  const freshnessMinutes = Math.max(0, Math.round((new Date(now).getTime() - publishedMs) / MIN_MS));
  const materiality = record.catalystTier >= 4
    ? 0
    : materialityScore({ ...record, freshnessMinutes }, { isNewToday: record.isNewToday, isRecycled: record.isRecycled });
  return { ...record, freshnessMinutes, materiality };
}

// Network wrapper. Bounded and failure-tolerant; a fetch failure yields the honest
// "no news available" context rather than throwing into a scan.
async function fetchCatalystContext(ticker, { now = new Date(), sessionOpenIso = null, lookbackDays = 3 } = {}) {
  const { fetchCompanyNewsRich } = require('./fundamentals');
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(new Date(now).getTime() - lookbackDays * DAY_MS).toISOString().slice(0, 10);
  let rows = [];
  try { rows = await fetchCompanyNewsRich(ticker, from, to, 30); } catch { rows = []; }
  const ctx = buildCatalystContext(Array.isArray(rows) ? rows : [], { now, sessionOpenIso });
  return { ...ctx, ticker: String(ticker || '').toUpperCase(), newsCount: Array.isArray(rows) ? rows.length : 0 };
}

// The explicit "not evaluated" context (budget/deadline/flag) — never mistaken for "no catalyst".
function unevaluatedCatalyst(ticker = null) {
  return {
    schema: CATALYST_VERSION, ticker, catalystPresent: false, catalystType: 'NOT_EVALUATED',
    catalystTier: 4, tierLabel: TIER_LABEL[4], publishedAt: null, freshnessMinutes: null,
    sourceQuality: null, isNewToday: false, isRecycled: false, materiality: 0,
    surpriseMagnitude: null, financialMateriality: null, clinicalStage: null,
    dilutionConnection: false, gapCause: 'NONE', evidence: [],
    note: 'Catalyst was not evaluated this cycle (budget or flag) — no catalyst credit awarded.',
  };
}

module.exports = {
  CLASSIFIERS, TIER_LABEL, classifyHeadline, sourceQuality, extractSurpriseMagnitude,
  extractClinicalStage, materialityScore, buildCatalystContext, fetchCatalystContext,
  unevaluatedCatalyst, reassessCatalyst, CATALYST_VERSION,
};
