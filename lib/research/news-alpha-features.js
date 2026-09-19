'use strict';

// Research-only features for the news composite tournament.  All timestamps and
// price bars passed here must be available by the decision cutoff.
const DAY = 86400000;
const HALF_LIFE_SESSIONS = 3;
const IMPROVED_HALF_LIFE_SESSIONS = 5;

const POSITIVE = Object.freeze([
  [/raises? (?:its )?(?:full[- ]year )?guidance|guidance (?:raised|increase)/i, 3],
  [/beats? (?:analyst )?(?:estimates|expectations)|tops? estimates/i, 2.5],
  [/fda (?:approval|approves?|clearance)|approved by the fda/i, 3],
  [/(?:wins?|lands?|awarded|secures?) .{0,35}(?:contract|award|order)/i, 2.5],
  [/(?:upgrade[ds]?|initiated) .{0,30}(?:buy|outperform|overweight)/i, 2],
  [/(?:price target|target price) (?:raised|increased|boosted)/i, 1.5],
  [/record (?:revenue|sales|earnings|profit|orders|backlog)/i, 2],
  [/(?:share )?buyback|repurchase authorization/i, 2],
  [/(?:strategic )?(?:partnership|collaboration)|commercial agreement/i, 1.25],
  [/(?:launch(?:es|ed)?|expands?|approval|breakthrough|milestone)/i, 0.75],
  [/(?:strong|accelerating|robust) demand|revenue growth|profit growth/i, 1.25],
]);

const NEGATIVE = Object.freeze([
  [/(?:public|registered|secondary|at-the-market|stock) offering|dilution|dilutive/i, 3],
  [/cuts? (?:its )?(?:full[- ]year )?guidance|guidance (?:cut|lowered|reduced)/i, 3],
  [/(?:misses?|below) (?:analyst )?(?:estimates|expectations)/i, 2.5],
  [/downgrade[ds]?|price target (?:cut|lowered)/i, 2],
  [/lawsuit|investigation|subpoena|fraud/i, 2],
  [/bankrupt|chapter 11|going concern|default/i, 4],
  [/recall|clinical hold|trial failure|failed trial/i, 3],
  [/layoffs?|job cuts?|declining revenue|revenue decline/i, 1.25],
  [/acquisition|merger|buyout|takeover/i, 1],
]);

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, n = 4) => Number.isFinite(x) ? +x.toFixed(n) : null;

function positiveTone(article) {
  const text = `${article && article.title || ''} ${article && article.text || ''}`.slice(0, 1200);
  let pos = 0, neg = 0;
  for (const [re, w] of POSITIVE) if (re.test(text)) pos += w;
  for (const [re, w] of NEGATIVE) if (re.test(text)) neg += w;
  if (pos <= neg || pos < 0.75) return 0;
  return round(clamp((pos - neg) / (pos + neg + 2), 0, 1), 4);
}

function sourceTimestamp(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function dateOf(ms) { return new Date(ms).toISOString().slice(0, 10); }

function indexOnOrBefore(candles, date) {
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].date <= date) return i;
  return -1;
}

function excessReaction({ stock, benchmark, articleDate, decisionDate }) {
  const si = indexOnOrBefore(stock, decisionDate), bi = indexOnOrBefore(benchmark, decisionDate);
  const sa = indexOnOrBefore(stock, articleDate), ba = indexOnOrBefore(benchmark, articleDate);
  if (si < 0 || bi < 0 || sa < 1 || ba < 1) return null;
  const sr = stock[si].close / stock[sa - 1].close - 1;
  const br = benchmark[bi].close / benchmark[ba - 1].close - 1;
  return Number.isFinite(sr) && Number.isFinite(br) ? sr - br : null;
}

function sessionAge(candles, articleDate, decisionDate) {
  const a = indexOnOrBefore(candles, articleDate), d = indexOnOrBefore(candles, decisionDate);
  return a >= 0 && d >= a ? d - a : null;
}

function newsImpactFeature({ articles = [], stock = [], benchmark = [], decisionDate, cutoffHourUtc = 20 }) {
  const cutoffMs = Date.parse(`${decisionDate}T${String(cutoffHourUtc).padStart(2, '0')}:00:00Z`);
  const seen = new Set(), scored = [];
  for (const article of articles) {
    const ts = sourceTimestamp(article && (article.d || article.publishedAt || article.publishedDate));
    if (ts == null || ts > cutoffMs) continue;
    const key = String(article.title || '').toLowerCase().replace(/\W+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const tone = positiveTone(article); if (!(tone > 0)) continue;
    const articleDate = dateOf(ts);
    const reaction = excessReaction({ stock, benchmark, articleDate, decisionDate });
    const age = sessionAge(stock, articleDate, decisionDate);
    if (reaction == null || age == null || age > 10) continue;
    const decay = Math.exp(-Math.LN2 * age / HALF_LIFE_SESSIONS);
    // Association, not causal attribution: daily bars cannot isolate the part of an
    // intraday move that preceded publication. Negative/no reaction contributes zero.
    const reactionStrength = Math.tanh(Math.max(0, reaction) / 0.08);
    const impact = tone * reactionStrength * decay;
    scored.push({ title: article.title || '', publishedAt: new Date(ts).toISOString(), tone,
      excessReaction: round(reaction, 5), ageSessions: age, decay: round(decay), impact: round(impact) });
  }
  scored.sort((a, b) => b.impact - a.impact || a.publishedAt.localeCompare(b.publishedAt));
  if (!scored.length) return { score: 0, positiveArticles: 0, strongest: null };
  const max = scored[0].impact, avg = scored.reduce((s, x) => s + x.impact, 0) / scored.length;
  return { score: round(100 * (0.7 * max + 0.3 * avg), 2), positiveArticles: scored.length, strongest: scored[0] };
}

function dollarAmount(text) {
  const m = String(text || '').match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*(billion|million|bn|mm|m|b)\b/i);
  if (!m) return null;
  const n = Number(m[1]), u = m[2].toLowerCase();
  if (!Number.isFinite(n)) return null;
  return n * ((u === 'billion' || u === 'bn' || u === 'b') ? 1e9 : 1e6);
}

// Magnitude of NEW economic information, not merely positive wording. Exact event
// dollars are normalized to TTM revenue when both are knowable at the cutoff.
function materialityScore(article, { ttmRevenue = null } = {}) {
  const text = `${article && article.title || ''} ${article && article.text || ''}`.slice(0, 1600);
  if (!(positiveTone(article) > 0)) return 0;
  let base = 0.2;
  if (/raises? .{0,30}guidance|guidance .{0,20}(?:raised|increased)/i.test(text)) base = .9;
  else if (/fda (?:approval|approves?|clearance)|approved by the fda/i.test(text)) base = .9;
  else if (/beats? .{0,20}(?:estimates|expectations)|tops? estimates/i.test(text)) base = .75;
  else if (/(?:wins?|lands?|awarded|secures?) .{0,45}(?:contract|award|order)/i.test(text)) base = .55;
  else if (/record (?:revenue|sales|earnings|profit|orders|backlog)/i.test(text)) base = .55;
  else if (/(?:share )?buyback|repurchase authorization/i.test(text)) base = .45;
  else if (/(?:upgrade[ds]?|initiated) .{0,30}(?:buy|outperform|overweight)/i.test(text)) base = .35;
  const amount = dollarAmount(text);
  if (amount && Number.isFinite(ttmRevenue) && ttmRevenue > 0) {
    const ratio = amount / ttmRevenue;
    // 1% of sales is relevant, 5% substantial, 10%+ highly material.
    base = Math.max(base, clamp(ratio / .10, 0, 1));
  }
  return round(clamp(base, 0, 1));
}

function underreactionCurve(excessMove) {
  if (!Number.isFinite(excessMove) || excessMove <= -.02) return 0;
  if (excessMove <= .02) return round(.2 + .4 * ((excessMove + .02) / .04));
  if (excessMove <= .08) return round(.6 + .4 * ((excessMove - .02) / .06));
  if (excessMove <= .15) return round(1 - .65 * ((excessMove - .08) / .07));
  return round(.35 * Math.exp(-(excessMove - .15) / .08));
}

function improvedNewsFeature({ articles = [], stock = [], benchmark = [], decisionDate,
  ttmRevenue = null, cutoffHourUtc = 20 } = {}) {
  const cutoffMs = Date.parse(`${decisionDate}T${String(cutoffHourUtc).padStart(2, '0')}:00:00Z`);
  const seen = new Set(), scored = [];
  for (const article of articles) {
    const ts = sourceTimestamp(article && (article.d || article.publishedAt || article.publishedDate));
    if (ts == null || ts > cutoffMs) continue;
    const key = String(article.title || '').toLowerCase().replace(/\W+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const materiality = materialityScore(article, { ttmRevenue }); if (!(materiality > 0)) continue;
    const articleDate = dateOf(ts), reaction = excessReaction({ stock, benchmark, articleDate, decisionDate });
    const age = sessionAge(stock, articleDate, decisionDate);
    if (reaction == null || age == null || age > 15) continue;
    const underreaction = underreactionCurve(reaction);
    const decay = Math.exp(-Math.LN2 * age / IMPROVED_HALF_LIFE_SESSIONS);
    const score = materiality * underreaction * decay;
    scored.push({ title: article.title || '', materiality, excessReaction: round(reaction, 5),
      underreaction, ageSessions: age, decay: round(decay), score: round(score) });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  if (!scored.length) return { score: 0, positiveMaterialArticles: 0, strongest: null, consumedPenalty: 0 };
  const max = scored[0].score, avg = mean(scored.map(x => x.score));
  const maxReaction = Math.max(...scored.map(x => x.excessReaction));
  return { score: round(100 * (.75 * max + .25 * avg), 2), positiveMaterialArticles: scored.length,
    strongest: scored[0], consumedPenalty: round(100 * clamp((maxReaction - .12) / .18, 0, 1), 2) };
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

function newsRiskFlags(articles = [], { decisionDate, cutoffHourUtc = 20 } = {}) {
  const cutoffMs = decisionDate ? Date.parse(`${decisionDate}T${String(cutoffHourUtc).padStart(2, '0')}:00:00Z`) : Infinity;
  const text = articles.filter(a => { const ts = sourceTimestamp(a && (a.d || a.publishedAt || a.publishedDate)); return ts != null && ts <= cutoffMs; })
    .map(a => `${a.title || ''} ${a.text || ''}`).join(' ');
  return {
    offeringOrDilution: /(?:public|registered|secondary|at-the-market|stock) offering|dilution|dilutive/i.test(text),
    guidanceCutOrMiss: /cuts? .{0,30}guidance|guidance .{0,20}(?:cut|lowered|reduced)|misses? .{0,20}(?:estimates|expectations)/i.test(text),
    binaryLegalOrClinical: /lawsuit|investigation|subpoena|clinical hold|trial failure|failed trial/i.test(text),
  };
}

function generateFormulaFamily(n = 100, seed = 20260812) {
  const fixed = [
    { w: [1, 0, 0, 0], x: [0, 0, 0] }, { w: [0, 1, 0, 0], x: [0, 0, 0] },
    { w: [0, 0, 1, 0], x: [0, 0, 0] }, { w: [0, 0, 0, 1], x: [0, 0, 0] },
    { w: [1, 1, 1, 1], x: [0, 0, 0] }, { w: [2, 1, 1, 1], x: [0, 0, 0] },
    { w: [2, 2, 1, 1], x: [.25, 0, 0] }, { w: [2, 1, 2, 1], x: [0, .25, 0] },
    { w: [1, 2, 1, 2], x: [0, 0, .25] }, { w: [2, 2, 2, 2], x: [.2, .2, .2] },
  ];
  let state = seed >>> 0;
  const rnd = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const vals = [-1, -.5, 0, .5, 1, 1.5, 2];
  const ints = [-.35, 0, 0, 0, .2, .35];
  const raw = [...fixed];
  while (raw.length < n) {
    const w = Array.from({ length: 4 }, () => vals[Math.floor(rnd() * vals.length)]);
    if (w.filter(v => v !== 0).length < 2 || w[0] === 0) continue; // every searched composite uses news
    const x = Array.from({ length: 3 }, () => ints[Math.floor(rnd() * ints.length)]);
    const key = JSON.stringify({ w, x }); if (raw.some(s => JSON.stringify(s) === key)) continue;
    raw.push({ w, x });
  }
  return raw.slice(0, n).map((s, i) => {
    const den = s.w.reduce((a, v) => a + Math.abs(v), 0) || 1;
    return { id: `F${String(i + 1).padStart(3, '0')}`, weights: {
      news: round(s.w[0] / den), technical: round(s.w[1] / den), fundamental: round(s.w[2] / den), recent: round(s.w[3] / den),
    }, interactions: { newsTechnical: s.x[0], newsFundamental: s.x[1], technicalRecent: s.x[2] } };
  });
}

function formulaScore(f, spec) {
  const w = spec.weights, x = spec.interactions;
  return w.news * f.news + w.technical * f.technical + w.fundamental * f.fundamental + w.recent * f.recent
    + x.newsTechnical * f.news * f.technical + x.newsFundamental * f.news * f.fundamental
    + x.technicalRecent * f.technical * f.recent;
}

module.exports = { HALF_LIFE_SESSIONS, IMPROVED_HALF_LIFE_SESSIONS, positiveTone, sourceTimestamp,
  excessReaction, newsImpactFeature, dollarAmount, materialityScore, underreactionCurve,
  improvedNewsFeature, newsRiskFlags, generateFormulaFamily, formulaScore };
