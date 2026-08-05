'use strict';
// Step 70 — GAP-CONTINUATION × CONGESTION (exploratory, registered 2026-08-05).
//   node research/70-gapgo-congestion.js           (offline — reads caches)
//
// The ONE preregistered exploratory pass for hypothesis `gapgo-congestion-interaction`
// (family intraday-gap): is the frozen exp08 ORB continuation trade's realized R
// higher on congested announcement days? Runs on the COMMITTED 19,326-event
// survivorship-corrected set (research/data/gap-events.json) — no event
// re-generation, no re-cuts. Congestion = same-day announcer counts across the
// full research earnings cache (the amended denominator recorded on
// announcement-congestion), via research/68's exported builder.
//
// FROZEN VERDICT (registry entry is the authority): congested-minus-quiet mean-R
// spread POSITIVE with pooled-SE t ≥ 2, AND spread sign consistent in ≥2 of 3
// macro regimes. Per-trade cost drag is identical across terciles (same frozen
// trade structure), so it CANCELS in the spread — reported as such.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EL = require('../lib/research/evidence-log');
const REG = require('../lib/research/hypothesis-registry');
const { buildCongestionCounts } = require('./68-announcement-congestion');

const DATA = path.join(__dirname, 'data');
const HYP_ID = 'gapgo-congestion-interaction';

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const r4 = (x) => (x == null ? null : +x.toFixed(4));
const statsOf = (a) => (a.length > 5
  ? { n: a.length, meanR: r4(mean(a)), t: r4(mean(a) / (sd(a) / Math.sqrt(a.length))), se: sd(a) / Math.sqrt(a.length), winRate: r4(a.filter((x) => x > 0).length / a.length) }
  : { n: a.length, meanR: null, t: null, se: null, winRate: null });

function main() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);

  const events = JSON.parse(fs.readFileSync(path.join(DATA, 'gap-events.json'), 'utf8'))
    .filter((e) => Number.isFinite(e.R) && e.date);
  const cal = buildCongestionCounts();
  const withC = events.map((e) => ({ ...e, congestion: cal.counts[e.date] || 0 }));

  // Terciles over the EVENT SET's congestion values (frozen).
  const cs = withC.map((e) => e.congestion).sort((a, b) => a - b);
  const t1 = cs[Math.floor(cs.length / 3)], t2 = cs[Math.floor((2 * cs.length) / 3)];
  const tercileOf = (c) => (c <= t1 ? 'quiet' : c <= t2 ? 'mid' : 'congested');
  const groups = { quiet: [], mid: [], congested: [] };
  for (const e of withC) groups[tercileOf(e.congestion)].push(e);

  const summary = { tercileBounds: [t1, t2], overall: {}, byRegime: {} };
  for (const [name, evs] of Object.entries(groups)) {
    summary.overall[name] = statsOf(evs.map((e) => e.R));
    console.log(`${name}: ${JSON.stringify(summary.overall[name])}`);
  }
  const c = summary.overall.congested, q = summary.overall.quiet;
  summary.spread = r4(c.meanR - q.meanR);
  summary.spreadT = r4((c.meanR - q.meanR) / Math.sqrt(c.se ** 2 + q.se ** 2));
  console.log(`spread (congested − quiet): ${summary.spread} R, t ${summary.spreadT}  [per-trade cost drag cancels in the spread — identical frozen trade structure]`);

  let regimesPositive = 0, regimesWithData = 0;
  for (const reg of ['on', 'neu', 'off']) {
    const gq = statsOf(groups.quiet.filter((e) => e.reg === reg).map((e) => e.R));
    const gc = statsOf(groups.congested.filter((e) => e.reg === reg).map((e) => e.R));
    const spread = (gq.meanR != null && gc.meanR != null) ? r4(gc.meanR - gq.meanR) : null;
    summary.byRegime[reg] = { quiet: gq, congested: gc, spread };
    if (spread != null) { regimesWithData++; if (spread > 0) regimesPositive++; }
    console.log(`  regime ${reg}: quiet ${gq.meanR} (n ${gq.n}) | congested ${gc.meanR} (n ${gc.n}) | spread ${spread}`);
  }

  const verdict = (summary.spread > 0 && summary.spreadT >= 2 && regimesPositive >= 2) ? 'pass-provisional' : 'not-confirmed';
  console.log(`FROZEN CRITERION → spread ${summary.spread} t ${summary.spreadT}, positive regimes ${regimesPositive}/${regimesWithData} ⇒ VERDICT ${verdict.toUpperCase()}`);

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
    datasetHash: `gap-events-congestion:${crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex').slice(0, 16)}`,
    periodStart: '2021-01-01', periodEnd: '2026-06-30',
    horizon: 'orb-3d',
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex').slice(0, 16),
    metrics: { events: withC.length, ...summary },
    verdict,
    mode: 'exploratory',
    generatedAt: new Date().toISOString(),
    note: `The ONE registered exploratory pass on the committed gap-event set (window now SPENT for ${HYP_ID}). Congestion terciles over event-set announcer counts; regime consistency is the frozen guard for the earnings-season confound. A pass changes nothing live directly — it would only justify a SHADOW congestion feature in the gapgo scorer, itself gated by governance.`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
  EL.appendEvidence(deps, rec.record).then((r) => console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/${HYP_ID}/`));
}

if (require.main === module) main();
module.exports = { HYP_ID };
