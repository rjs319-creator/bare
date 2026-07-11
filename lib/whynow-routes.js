const { internalHeaders } = require('./auth');
// 🔍 WHY NOW route — op=whynow&ticker=XYZ.
//
// Composes the per-ticker intelligence layer for the lookup modal from signals the
// app ALREADY computes: it self-fetches the (CDN-cached) screener for each scope —
// the exact same data every card shows — locates the ticker, and reads its Apex
// breakout tier, Ghost accumulation, conviction sleeve, insider flag and macro
// regime off that candidate. It then joins the second-order read-through cache and
// the Scoreboard track-record summary, and hands the extracted facts to the pure
// composer (lib/whynow). If the ticker isn't in any screen, we return an honest
// "no active signals" — we never compute a speculative score on demand.
const { readJSON } = require('./store');
const apex = require('./apex');
const { composeWhyNow } = require('./whynow');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SCOPES = ['large', 'small', 'micro'];
const RT_CACHE_KEY = 'readthrough/latest.json';
const SB_SUMMARY_KEY = 'scoreboard/summary.json';   // lightweight track-record cache written by runScoreboard

async function getJSON(path) {
  const r = await fetch('https://' + HOST + path, { headers: internalHeaders() });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

// Find the ticker's candidate object across the scoped screener responses. Prefer a
// full breakout-candidate `results` row (carries pct/status/fundamentals so Apex can
// score it); fall back to a `ghostTop` accumulation row (carries ghost + insider).
function locate(screens, ticker) {
  let cand = null, ghostRow = null, regimeObj = null, macro = null, ghostLabels = null;
  for (const s of screens) {
    if (!s) continue;
    if (regimeObj == null && s.regime) regimeObj = s.regime;             // large scope carries the market read
    if (macro == null && s.ghost && s.ghost.macro) macro = s.ghost.macro;
    if (ghostLabels == null && s.ghost && s.ghost.pillarLabels) ghostLabels = s.ghost.pillarLabels;
    if (!cand && Array.isArray(s.results)) {
      const hit = s.results.find(c => (c.ticker || '').toUpperCase() === ticker);
      if (hit) cand = hit;
    }
    if (!ghostRow && Array.isArray(s.ghostTop)) {
      const hit = s.ghostTop.find(c => (c.ticker || '').toUpperCase() === ticker);
      if (hit) ghostRow = hit;
    }
  }
  return { cand, ghostRow, regimeObj, macro, ghostLabels };
}

// Scoreboard groups → { 'section:tier': group } for the composer's track-record join.
function trackMap(summary) {
  const out = {};
  for (const g of (summary && summary.groups) || []) {
    if (g && g.section && g.tier != null) out[`${g.section}:${g.tier}`] = g;
  }
  return out;
}

async function runWhyNow(req, res) {
  const ticker = (req.query.ticker || '').toUpperCase().trim();
  if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ ok: false, error: 'missing or invalid ticker' });
  }

  // Gather everything in parallel; each source degrades to null on its own.
  const [screens, rtCache, sbSummary] = await Promise.all([
    Promise.all(SCOPES.map(s => getJSON('/api/screener?scope=' + s).catch(() => null))),
    readJSON(RT_CACHE_KEY, null).catch(() => null),
    readJSON(SB_SUMMARY_KEY, null).catch(() => null),
  ]);

  const { cand, ghostRow, regimeObj, macro, ghostLabels } = locate(screens, ticker);

  // Apex breakout tier — only when we have a full candidate to score. Keep the full
  // pillar set (even for a null tier) so the breakdown can show the composite.
  let apexHit = null, apexPillars = null, apexScore = null;
  if (cand) {
    const rg = apex.rawRegime(regimeObj);
    const scored = apex.scoreCandidate(cand, rg, null);
    apexPillars = scored.pillars; apexScore = scored.score;
    if (scored.tier) apexHit = { tier: scored.tier, score: scored.score, pillars: scored.pillars };
  }

  // Ghost accumulation — from the candidate if present, else the accumulation row.
  const ghostSrc = (cand && cand.ghost) || (ghostRow && ghostRow.ghost) || null;
  const ghostHit = ghostSrc ? { tier: ghostSrc.tier, score: ghostSrc.score, strongPillars: ghostSrc.strongPillars || [] } : null;

  const insider = (cand && cand.insider) || (ghostRow && ghostRow.insider) || null;
  const conviction = (cand && cand.conviction) || null;

  // Second-order read-through: is this name a surfaced beneficiary in the latest graph?
  const readThrough = (rtCache && Array.isArray(rtCache.items) ? rtCache.items : [])
    .filter(it => (it.beneficiary_ticker || '').toUpperCase() === ticker);

  const payload = composeWhyNow({
    ticker, apex: apexHit, ghost: ghostHit, conviction, insider, readThrough, macro,
    trackByKey: trackMap(sbSummary),
  });

  // Short CDN cache: repeated lookups of the same ticker are cheap; underlying data
  // refreshes on the daily warm cron.
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  // Pillar-level detail for the collapsible breakdown (raw scores, no verdict spin).
  const breakdown = {
    apex: apexPillars ? { score: apexScore, tier: apexHit ? apexHit.tier : null, pillars: apexPillars, labels: apex.PILLAR_LABEL } : null,
    ghost: ghostSrc ? { score: ghostSrc.score, tier: ghostSrc.tier, pillars: ghostSrc.pillars || null, strongPillars: ghostSrc.strongPillars || [], labels: ghostLabels } : null,
    conviction: conviction || null,
  };

  return res.json({
    ok: true,
    inUniverse: !!(cand || ghostRow),
    company: (cand && cand.company) || (ghostRow && ghostRow.company) || null,
    trackAsOf: sbSummary && sbSummary.generatedAt ? sbSummary.generatedAt : null,
    breakdown,
    ...payload,
  });
}

module.exports = { runWhyNow, locate, trackMap };
