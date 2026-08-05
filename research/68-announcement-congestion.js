'use strict';
// Step 68 — ANNOUNCEMENT CONGESTION (exploratory, registered 2026-08-05).
//   node research/68-announcement-congestion.js        (offline — reads caches)
//
// The ONE preregistered exploratory pass for hypothesis `announcement-congestion`
// (family event-drift): is SUE post-earnings drift STRONGER on congested
// reporting days (many same-day announcers → rationed attention → underreaction)
// than on quiet days? The unconditional SUE-PEAD already failed on this window
// (lib/pead.js runSurprisePEAD, NOT-CONFIRMED) — this asks only whether
// congestion MODULATES it, so the honest prior is low.
//
// RECORDED DESIGN AMENDMENT (2026-08-05, made BEFORE any outcome was computed):
// the registration named the live FMP earnings-calendar as the congestion
// denominator, but that endpoint rejects historical `from` dates on the current
// plan (probed: everything ≤ ~2025-08 is tier-blocked; the first run threw on
// chunk 1 before computing anything). Substituted denominator: same-day
// announcer counts across the FULL research/data/earnings/ cache (3,438
// symbols, the step-24 SUE cache, dense 2021-2026) — i.e. congestion measured
// over the investable panel universe rather than every OTC microcap, which is
// arguably the correct attention-competition population anyway. Same-source
// substitution, frozen before any drift number existed.
//
// FROZEN DESIGN (the registry entry is the authority):
//   * events: paired-estimate SUE per symbol (mirrors lib/pead.js — PIT trailing
//     σ over ≤12 prior surprises excluding the event, ≥4 prior points, winsor ±8),
//     scopes large + small (lib/universe lists, 150 names each), events 2021-07..2026-03.
//   * congestion: same-day announcer count across the full earnings cache,
//     split into WITHIN-SCOPE terciles.
//   * drift: SPY-excess close-after-announcement → +21/+63 sessions, from the
//     research price caches (never live quotes).
//   * primary: 63s congested-minus-quiet LS spread, positive in BOTH scopes AND
//     spread t ≥ 2 in at least one — anything else is NOT-CONFIRMED.
// The window is SPENT for this hypothesis when the run completes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EL = require('../lib/research/evidence-log');
const REG = require('../lib/research/hypothesis-registry');
const { LARGE, SMALL_CAPS } = require('../lib/universe');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const EARN_DIR = path.join(DATA, 'earnings');
const HYP_ID = 'announcement-congestion';
const HOLDS = [21, 63];
const FROM = '2021-01-01', TO = '2026-06-30';
const EVENT_FROM = '2021-07-07';               // first date with cache bars for entries
const EVENT_TO = '2026-03-31';                 // leaves ≥63 sessions of bars for exits
const LIMIT_PER_SCOPE = 150;
const MIN_PRIOR = 4, WINSOR = 8;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const r4 = (x) => (x == null ? null : +x.toFixed(4));

const readEarnings = (sym) => {
  try { return JSON.parse(fs.readFileSync(path.join(EARN_DIR, `${sym}.json`), 'utf8')); } catch { return null; }
};

// Same-day announcer counts across the FULL earnings cache (3,438 symbols —
// the amended congestion denominator, see the header). Symbol-date deduped;
// any announcement row competes for attention whether or not estimates pair.
function buildCongestionCounts() {
  const counts = {};
  const seen = new Set();
  let files = 0;
  for (const f of fs.readdirSync(EARN_DIR)) {
    if (!f.endsWith('.json')) continue;
    files++;
    let rows;
    try { rows = JSON.parse(fs.readFileSync(path.join(EARN_DIR, f), 'utf8')); } catch { continue; }
    for (const r of rows || []) {
      const d = String(r.date || '').slice(0, 10);
      const sym = String(r.symbol || f.replace(/\.json$/, ''));
      if (!d || d < FROM || d > TO) continue;
      const k = `${sym}|${d}`;
      if (seen.has(k)) continue;
      seen.add(k);
      counts[d] = (counts[d] || 0) + 1;
    }
  }
  return { from: FROM, to: TO, files, counts };
}

// Paired-estimate SUE events for one symbol (mirrors lib/pead.js runSurprisePEAD).
function sueEvents(sym, rows) {
  const paired = (rows || [])
    .map((r) => ({ date: String(r.date || '').slice(0, 10), act: r.epsActual ?? r.eps, est: r.epsEstimated ?? r.epsEstimate }))
    .filter((r) => r.date && Number.isFinite(r.act) && Number.isFinite(r.est))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = [];
  for (let i = 0; i < paired.length; i++) {
    const prior = paired.slice(Math.max(0, i - 12), i).map((p) => p.act - p.est);
    if (prior.length < MIN_PRIOR) continue;
    const s = sd(prior);
    if (!(s > 0)) continue;
    const sue = Math.max(-WINSOR, Math.min(WINSOR, (paired[i].act - paired[i].est) / s));
    if (paired[i].date >= EVENT_FROM && paired[i].date <= EVENT_TO) out.push({ symbol: sym, date: paired[i].date, sue });
  }
  return out;
}

function loadBars(sym) {
  try { return pit.priceSeries(JSON.parse(fs.readFileSync(path.join(pit.CACHE, `${sym}.json`), 'utf8')).price); } catch { return null; }
}

// SPY-excess drift, close AFTER the announcement date → +h sessions.
function excessAt(bars, spy, dateMs, h) {
  let idx = -1; for (let k = 0; k < bars.length; k++) { if (bars[k].ms <= dateMs) idx = k; else break; }
  const e0 = idx + 1, e1 = idx + 1 + h;
  if (idx < 0 || e1 >= bars.length) return null;
  let s0 = -1; for (let k = 0; k < spy.length; k++) { if (spy[k].ms <= bars[e0].ms) s0 = k; else break; }
  const s1 = s0 + h;
  if (s0 < 0 || s1 >= spy.length) return null;
  const r = bars[e1].close / bars[e0].close - 1;
  const m = spy[s1].close / spy[s0].close - 1;
  return (r - m) * 100;
}

// Long-short: top-vs-bottom SUE quintile per-event excess legs. `se` feeds the
// congested-minus-quiet spread t (two independent samples, pooled SE).
function longShort(events, h) {
  const ranked = [...events].filter((e) => e.ex[h] != null).sort((a, b) => a.sue - b.sue);
  const q = Math.max(1, Math.floor(ranked.length / 5));
  const bottom = ranked.slice(0, q).map((e) => -e.ex[h]);          // short leg contributes −excess
  const top = ranked.slice(-q).map((e) => e.ex[h]);
  const legs = [...top, ...bottom];
  if (legs.length < 6) return { n: legs.length, meanPct: null, t: null, se: null, topN: top.length };
  return { n: legs.length, meanPct: r4(mean(legs)), t: r4(tOf(legs)), se: sd(legs) / Math.sqrt(legs.length), topN: top.length };
}

async function main() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  if (!fs.existsSync(EARN_DIR)) { console.log('BLOCKED: research/data/earnings/ missing (step-24 SUE cache)'); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);

  const cal = buildCongestionCounts();
  const calDays = Object.keys(cal.counts).length;
  console.log(`congestion denominator: ${calDays} announcement days from ${cal.files} cached symbols`);

  const spy = loadBars('SPY');
  if (!spy) { console.log('BLOCKED: SPY cache missing'); process.exitCode = 1; return; }

  const scopes = { large: [...new Set(LARGE)].slice(0, LIMIT_PER_SCOPE), small: [...new Set(SMALL_CAPS)].slice(0, LIMIT_PER_SCOPE) };
  const byScope = {};
  for (const [scope, names] of Object.entries(scopes)) {
    const events = [];
    let fetched = 0, withEst = 0, noBars = 0;
    for (const sym of names) {
      const rows = readEarnings(sym);
      fetched++;
      if (!rows || !rows.length) continue;
      const evs = sueEvents(sym, rows);
      if (evs.length) withEst++;
      if (evs.length) {
        const bars = loadBars(sym);
        if (!bars) { noBars++; continue; }
        for (const e of evs) {
          const dMs = Date.parse(e.date);
          const ex = {};
          for (const h of HOLDS) ex[h] = excessAt(bars, spy, dMs, h);
          const congestion = cal.counts[e.date] || 0;
          if (ex[21] != null || ex[63] != null) events.push({ ...e, ex, congestion });
        }
      }
    }

    // WITHIN-SCOPE congestion terciles (frozen: terciles by event congestion).
    const cs = events.map((e) => e.congestion).sort((a, b) => a - b);
    const t1 = cs[Math.floor(cs.length / 3)], t2 = cs[Math.floor((2 * cs.length) / 3)];
    const tercileOf = (c) => (c <= t1 ? 'quiet' : c <= t2 ? 'mid' : 'congested');
    const groups = { quiet: [], mid: [], congested: [] };
    for (const e of events) groups[tercileOf(e.congestion)].push(e);

    const res = { symbolsFetched: fetched, symbolsWithEstimates: withEst, noBars, events: events.length, tercileBounds: [t1, t2], ls: {} };
    for (const h of HOLDS) {
      res.ls[h] = {
        quiet: longShort(groups.quiet, h),
        mid: longShort(groups.mid, h),
        congested: longShort(groups.congested, h),
      };
      const c = res.ls[h].congested, q = res.ls[h].quiet;
      // Congested-minus-quiet LS spread; t from pooled SEs of the two
      // independent tercile leg samples — the registered primary metric.
      if (c.n >= 20 && q.n >= 20 && c.meanPct != null && q.meanPct != null) {
        res.ls[h].spread = r4(c.meanPct - q.meanPct);
        res.ls[h].spreadT = r4((c.meanPct - q.meanPct) / Math.sqrt(c.se ** 2 + q.se ** 2));
      } else {
        res.ls[h].spread = null;
        res.ls[h].spreadT = null;
      }
    }
    byScope[scope] = res;
    console.log(`[${scope}] events ${events.length} (names w/ estimates ${withEst}/${fetched}), terciles ≤${t1}/${t2}`);
    for (const h of HOLDS) {
      const L = res.ls[h];
      console.log(`  ${h}s LS: quiet ${L.quiet.meanPct}% (t ${L.quiet.t}, n ${L.quiet.n}) | mid ${L.mid.meanPct}% (t ${L.mid.t}, n ${L.mid.n}) | congested ${L.congested.meanPct}% (t ${L.congested.t}, n ${L.congested.n}) | spread ${L.spread}% (t ${L.spreadT})`);
    }
  }

  // FROZEN pass criterion (registry primary metric): the 63-session
  // congested-minus-quiet spread must be POSITIVE in BOTH scopes AND reach
  // t ≥ 2 in at least one. Anything else — including a significant NEGATIVE
  // spread — is not-confirmed.
  const bothPositive63 = Object.values(byScope).every((s) => s.ls[63].spread != null && s.ls[63].spread > 0);
  const spreadSig63 = Object.values(byScope).some((s) => s.ls[63].spreadT != null && s.ls[63].spreadT >= 2);
  const verdict = bothPositive63 && spreadSig63 ? 'pass-provisional' : 'not-confirmed';
  console.log(`FROZEN CRITERION → 63s spread positive in both scopes: ${bothPositive63}, spread t≥2 anywhere: ${spreadSig63} ⇒ VERDICT ${verdict.toUpperCase()}`);

  let codeVersion = 'git:unknown';
  try { codeVersion = `git:${execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()}`; } catch { /* recorded as unknown */ }
  try { if (execSync('git status --porcelain', { cwd: __dirname }).toString().trim().length > 0) codeVersion += '+dirty'; } catch { codeVersion += '+dirty'; }

  const deps = {
    readJSON: async (p, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p.replace(/^research\//, '')), 'utf8')); } catch { return dflt; } },
    writeJSON: async (p, obj) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    },
  };
  const rec = EL.makeEvidenceRecord({
    hypothesisId: HYP_ID,
    datasetHash: `fmp-sue-congestion:${crypto.createHash('sha256').update(JSON.stringify(byScope)).digest('hex').slice(0, 16)}`,
    periodStart: EVENT_FROM, periodEnd: EVENT_TO,
    horizon: '63d',
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify({ cal: calDays, byScope })).digest('hex').slice(0, 16),
    metrics: { byScope, calendarDays: calDays },
    verdict,
    mode: 'exploratory',
    generatedAt: new Date().toISOString(),
    note: `The ONE registered exploratory pass (window now SPENT for ${HYP_ID}). Universe is present-day constituents (survivorship-reduced; both terciles share the bias — the SPLIT is the object). Unconditional SUE-PEAD was already NOT-CONFIRMED on this window; frozen criterion = 63s congested-minus-quiet spread positive in BOTH scopes AND a significant positive congested tercile.`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
  await EL.appendEvidence(deps, rec.record).then((r) => console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/${HYP_ID}/`));
}

if (require.main === module) main();
module.exports = { sueEvents, longShort, buildCongestionCounts, HYP_ID };
