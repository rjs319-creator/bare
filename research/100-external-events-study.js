'use strict';
// Step 100 — EXTERNAL-EVENT FAMILY, the ONE preregistered pass.
//   node research/100-external-events-study.js            # study (pull first: research/99-external-events-pull.js)
//   node research/100-external-events-study.js --dry      # counts only, no registry write
//
// Frozen by research/PREREGISTRATION-EXTERNAL-EVENTS-2026-09.md (sealed b43f45a). Every
// parameter below mirrors that document; changing any of them is a new hypothesis.
// Development cells are printed BEFORE the sealed holdout; the verdict rule is mechanical.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const ES = require('../lib/evidence-stats');
const { OUT: PULL_DIR } = require('./99-external-events-pull');

const FAMILY = 'external-events-2026-09';
const SEAL = 'b43f45a';
const OUT_DIR = path.join(K.DATA_DIR, 'evidence', 'external-events');
const CORP_DIR = path.join(K.DATA_DIR, 'corpactions');

const FROZEN = Object.freeze({
  family: FAMILY, seal: SEAL,
  horizons: [5, 21, 63],
  universe: { minAdv: 2e6, maxNames: 12000 },
  eligibility: { minPriorBars: 60, minClose: 2, minAdv: 2e6 },
  cooldownSessions: 63,
  placeboShift: 126,
  dev: { from: '2021-08-02', to: '2024-12-31' },
  holdout: { from: '2025-01-02', to: '2026-03-31' },
  fdrAlpha: 0.10,
  gates: { minEvents: 50, minDates: 20, minT: 2.0, minPositiveBlocks: 3, maxTop1Share: 0.5 },
  hypotheses: {
    'activist-13d-initial': { variants: ['A', 'B'], primary: { variant: 'A', H: 21 } },
    'buyback-authorization-8k': { variants: ['A', 'B'], primary: { variant: 'B', H: 21 } },
    'dividend-initiation': { variants: ['A'], primary: { variant: 'A', H: 63 } },
    'analyst-upgrade-cluster': { variants: ['A', 'B'], primary: { variant: 'A', H: 5 } },
  },
  dividend: { gapDays: 1095 },
  upgrade: { windowSessions: 3, minBrokersA: 2, minBrokersB: 3 },
  smallMicroAdvMax: 2e7,
});

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const listJson = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

// ── Calendar helpers ────────────────────────────────────────────────────────
function makeCalendar(spy) {
  const dates = spy.map((b) => b.date);
  // last session ≤ calendar date (binary search)
  const decisionDateFor = (cal) => {
    let lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid] <= cal) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 ? dates[ans] : null;
  };
  const sessionIndex = new Map(dates.map((d, i) => [d, i]));
  return { dates, decisionDateFor, sessionIndex };
}

// ── Event builders (each returns [{sym, calDate, variants:Set, meta}]) ──────
const TICKER_RE = /\(([A-Z][A-Z0-9.\-]{0,7})\)\s+\(CIK/;
function tickerOf(displayName) {
  const m = TICKER_RE.exec(String(displayName || ''));
  return m ? m[1].replace(/\./g, '-') : null;
}

function eftsHits(key) {
  const dir = path.join(PULL_DIR, `efts-${key}`);
  const seen = new Set();
  const out = [];
  let capped = 0;
  for (const f of listJson(dir)) {
    const doc = readJson(path.join(dir, f));
    if (doc.capped) capped++;
    for (const h of doc.hits || []) {
      if (!h.adsh || seen.has(h.adsh)) continue;
      seen.add(h.adsh);
      out.push(h);
    }
  }
  return { hits: out, months: listJson(dir).length, cappedMonths: capped };
}

// Initial 13D under BOTH labels: legacy "SC 13D" and the structured "SCHEDULE 13D" the SEC
// switched to in December 2024 (r1 missed every holdout filing because of the rename).
const INITIAL_13D_FORMS = new Set(['SC 13D', 'SCHEDULE 13D']);
function build13D(attr) {
  const legacy = eftsHits('13d'), renamed = eftsHits('13d-schedule');
  const seen = new Set();
  const hits = [...legacy.hits, ...renamed.hits].filter((h) => (seen.has(h.adsh) ? false : (seen.add(h.adsh), true)));
  attr.months13d = legacy.months; attr.months13dSchedule = renamed.months; attr.cappedMonths13d = legacy.cappedMonths + renamed.cappedMonths; attr.hits13d = hits.length;
  const events = [];
  let amendments = 0, noTicker = 0;
  for (const h of hits) {
    if (!INITIAL_13D_FORMS.has(h.form)) { amendments++; continue; }
    const sym = tickerOf((h.display_names || [])[0]);
    if (!sym) { noTicker++; continue; }
    events.push({ sym, calDate: h.file_date, variants: new Set(['A']), meta: { adsh: h.adsh } });
  }
  attr.amendmentsExcluded13d = amendments; attr.noTicker13d = noTicker;
  return events;
}

function buildBuyback(attr) {
  const { hits, months, cappedMonths } = eftsHits('buyback');
  attr.monthsBuyback = months; attr.cappedMonthsBuyback = cappedMonths; attr.hitsBuyback = hits.length;
  const events = [];
  let notForm = 0, noTicker = 0;
  for (const h of hits) {
    if (h.form !== '8-K') { notForm++; continue; }
    const sym = tickerOf((h.display_names || [])[0]);
    if (!sym) { noTicker++; continue; }
    const items = (h.items || []).map(String);
    const standalone = items.includes('8.01') && !items.includes('2.02');
    events.push({ sym, calDate: h.file_date, variants: new Set(standalone ? ['A', 'B'] : ['A']), meta: { adsh: h.adsh, items } });
  }
  attr.notPlain8K = notForm; attr.noTickerBuyback = noTicker;
  return events;
}

function buildDividendInitiations(attr) {
  const events = [];
  let files = 0, badDeclaration = 0;
  for (const f of listJson(CORP_DIR)) {
    let doc; try { doc = readJson(path.join(CORP_DIR, f)); } catch { continue; }
    files++;
    const divs = (doc.dividends || []).filter((d) => d && d.date && Number(d.dividend) > 0).sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < divs.length; i++) {
      const d = divs[i];
      const prev = i > 0 ? divs[i - 1] : null;
      const gapDays = prev ? (Date.parse(d.date) - Date.parse(prev.date)) / 86400000 : Infinity;
      if (gapDays < FROZEN.dividend.gapDays) continue;
      if (!d.declarationDate || d.declarationDate > d.date) { badDeclaration++; continue; }
      events.push({ sym: String(doc.sym || f.replace(/\.json$/, '')).toUpperCase(), calDate: d.declarationDate, variants: new Set(['A']), meta: { exDate: d.date, dividend: d.dividend, first: !prev } });
    }
  }
  attr.corpactionFiles = files; attr.badDeclarationDate = badDeclaration;
  return events;
}

function buildUpgradeClusters(cal, attr) {
  const dir = path.join(PULL_DIR, 'grades');
  const events = [];
  let files = 0, upgrades = 0;
  for (const f of listJson(dir)) {
    let doc; try { doc = readJson(path.join(dir, f)); } catch { continue; }
    files++;
    const ups = (doc.rows || [])
      .filter((r) => String(r.action || '').toLowerCase() === 'upgrade' && r.date && r.gradingCompany)
      .map((r) => ({ date: r.date, broker: String(r.gradingCompany).trim().toLowerCase(), sess: cal.sessionIndex.get(cal.decisionDateFor(r.date)) }))
      .filter((r) => Number.isFinite(r.sess))
      .sort((a, b) => a.sess - b.sess);
    upgrades += ups.length;
    // One event per (name, session) carrying the LARGEST distinct-broker count reached in the
    // trailing window that session. r1 emitted one row per upgrade and let the 63-session
    // cooldown keep the first (2-broker) row, so variant B (≥3) was structurally empty.
    const bySession = new Map();
    for (let i = 0; i < ups.length; i++) {
      const brokers = new Set();
      for (let j = i; j >= 0 && ups[i].sess - ups[j].sess <= FROZEN.upgrade.windowSessions; j--) brokers.add(ups[j].broker);
      const prev = bySession.get(ups[i].sess);
      if (!prev || brokers.size > prev.n) bySession.set(ups[i].sess, { date: ups[i].date, n: brokers.size });
    }
    for (const { date, n } of bySession.values()) {
      if (n < FROZEN.upgrade.minBrokersA) continue;
      const variants = new Set(['A']);
      if (n >= FROZEN.upgrade.minBrokersB) variants.add('B');
      events.push({ sym: doc.sym, calDate: date, variants, meta: { brokers: n } });
    }
  }
  attr.gradeFiles = files; attr.upgradeRows = upgrades;
  return events;
}

// ── Scoring (shared) ────────────────────────────────────────────────────────
function advAsOf(candles, i, lookback = 60) {
  let s = 0, c = 0;
  for (let k = Math.max(0, i - lookback + 1); k <= i; k++) { s += (candles[k].close || 0) * (candles[k].volume || 0); c++; }
  return c ? s / c : 0;
}

function outcomesAt(entry, spy, spyIdx, i, H, cost) {
  const decisionDate = entry.candles[i].date;
  const gross = K.forwardFromNextOpen(entry, decisionDate, H);
  const bench = K.benchmarkForward(spy, spyIdx, decisionDate, H);
  if (gross == null || bench == null) return null;
  return { netx: (gross - cost.base - bench) * 100, netxDoubled: (gross - cost.doubled - bench) * 100, gross: gross * 100 };
}

function scoreEvents(hypId, rawEvents, U, cal, attr) {
  const { dataset, spy, spyIdx } = U;
  const sorted = rawEvents.slice().sort((a, b) => a.calDate.localeCompare(b.calDate) || a.sym.localeCompare(b.sym));
  const lastByName = new Map();
  const rows = [];
  const a = { raw: rawEvents.length, notCached: 0, noDecisionDate: 0, noDecisionBar: 0, tooFewBars: 0, priceFloor: 0, advFloor: 0, cooldown: 0, scored: 0, outsideWindows: 0 };
  for (const ev of sorted) {
    const entry = dataset.get(ev.sym);
    if (!entry) { a.notCached++; continue; }
    const decisionDate = cal.decisionDateFor(ev.calDate);
    if (!decisionDate) { a.noDecisionDate++; continue; }
    const i = entry.idx.get(decisionDate);
    if (i == null) { a.noDecisionBar++; continue; }
    if (i < FROZEN.eligibility.minPriorBars) { a.tooFewBars++; continue; }
    const bar = entry.candles[i];
    if (!(bar.close >= FROZEN.eligibility.minClose)) { a.priceFloor++; continue; }
    const adv = advAsOf(entry.candles, i);
    if (!(adv >= FROZEN.eligibility.minAdv)) { a.advFloor++; continue; }
    const last = lastByName.get(ev.sym);
    if (last != null && i - last < FROZEN.cooldownSessions) { a.cooldown++; continue; }
    lastByName.set(ev.sym, i);
    const split = decisionDate >= FROZEN.dev.from && decisionDate <= FROZEN.dev.to ? 'dev'
      : decisionDate >= FROZEN.holdout.from && decisionDate <= FROZEN.holdout.to ? 'holdout' : null;
    if (!split) { a.outsideWindows++; continue; }
    const cost = K.costFractions(adv);
    const row = { hyp: hypId, sym: ev.sym, date: decisionDate, split, tier: cost.tier, variants: [...ev.variants], meta: ev.meta, out: {}, placebo: {} };
    for (const H of FROZEN.horizons) {
      row.out[H] = outcomesAt(entry, spy, spyIdx, i, H, cost);
      const pi = i - FROZEN.placeboShift;
      row.placebo[H] = pi >= FROZEN.eligibility.minPriorBars ? outcomesAt(entry, spy, spyIdx, pi, H, cost) : null;
    }
    rows.push(row);
    a.scored++;
  }
  attr[hypId] = a;
  return rows;
}

// ── Cell statistics ─────────────────────────────────────────────────────────
function cellStats(rows, H, { pick = (r) => r.out[H] && r.out[H].netx } = {}) {
  const obs = rows.map((r) => ({ date: r.date, value: pick(r) })).filter((o) => Number.isFinite(o.value));
  if (!obs.length) return null;
  const s = K.summarizeByDate(obs, { horizonBars: H });
  if (!s) return null;
  const vals = obs.map((o) => o.value).sort((x, y) => y - x);
  const mean = K.mean(vals);
  const median = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  const k = Math.max(1, Math.ceil(vals.length * 0.01));
  const trimmed = K.mean(vals.slice(k));
  const top1Share = mean > 0 ? (mean - trimmed) / mean : null;
  const t = s.seExact > 0 ? s.avgExact / s.seExact : null;
  return {
    events: obs.length, dates: s.dates, effectiveN: s.effectiveN,
    avg: r4(s.avgExact), se: r4(s.seExact), t: r2(t), p: ES.pValueOf(s),
    ci95: s.ci95, positiveBlocks: s.positiveBlocks, blockMeans: s.blockStability && s.blockStability.means,
    eventMean: r4(mean), eventMedian: r4(median), top1Share: r4(top1Share),
  };
}

function cellId(hyp, variant, H) { return `${hyp}:${variant}@${H}`; }

function computeCells(rowsByHyp) {
  const cells = {};
  for (const [hyp, spec] of Object.entries(FROZEN.hypotheses)) {
    const rows = rowsByHyp[hyp] || [];
    for (const v of spec.variants) {
      const vrows = rows.filter((r) => r.variants.includes(v));
      for (const H of FROZEN.horizons) {
        const id = cellId(hyp, v, H);
        cells[id] = {};
        for (const split of ['dev', 'holdout']) {
          const srows = vrows.filter((r) => r.split === split);
          cells[id][split] = {
            main: cellStats(srows, H),
            doubled: cellStats(srows, H, { pick: (r) => r.out[H] && r.out[H].netxDoubled }),
            placebo: cellStats(srows, H, { pick: (r) => r.placebo[H] && r.placebo[H].netx }),
            byTier: Object.fromEntries(['liquid', 'small', 'micro'].map((t) => [t, (() => { const c = cellStats(srows.filter((r) => r.tier === t), H); return c ? { events: c.events, avg: c.avg, t: c.t } : null; })()])),
          };
        }
      }
    }
  }
  return cells;
}

// Variant B of 13D is defined by the subject's as-of tier (small/micro), not by a flag.
function tag13DVariantB(rows) {
  for (const r of rows) if (r.tier !== 'liquid' && !r.variants.includes('B')) r.variants.push('B');
}

// ── Verdict (§3, mechanical) ────────────────────────────────────────────────
function verdictFor(hyp, cells, fdrById) {
  const p = FROZEN.hypotheses[hyp].primary;
  const id = cellId(hyp, p.variant, p.H);
  const dev = cells[id].dev, ho = cells[id].holdout;
  const g = FROZEN.gates;
  const devEvents = dev.main ? dev.main.events : 0;
  if (devEvents < g.minEvents) return { status: 'inconclusive', primaryCell: id, reason: `only ${devEvents} development events (< ${g.minEvents}) — data wall, not a negative` };
  const f = fdrById[id] || {};
  const devPass = !!(f.survives && dev.main.avg > 0 && dev.main.positiveBlocks >= g.minPositiveBlocks);
  if (!devPass) return { status: 'no-edge', primaryCell: id, reason: `development cell failed: avg ${dev.main.avg}% t ${dev.main.t} q ${r4(f.q)} blocks+ ${dev.main.positiveBlocks}/4`, devPass };
  const h = ho.main;
  const checks = {
    t: !!(h && h.t >= g.minT && h.avg > 0),
    events: !!(h && h.events >= g.minEvents && h.dates >= g.minDates),
    median: !!(h && h.eventMedian > 0),
    top1: !!(h && h.top1Share != null && h.top1Share < g.maxTop1Share),
    doubled: !!(ho.doubled && ho.doubled.avg > 0),
    placebo: !(ho.placebo && ho.placebo.t >= g.minT && ho.placebo.avg > 0),
  };
  const pass = Object.values(checks).every(Boolean);
  return { status: pass ? 'provisional' : 'no-edge', primaryCell: id, devPass, holdoutChecks: checks, reason: pass ? 'primary cell survived development FDR and every sealed-holdout gate' : `holdout failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ')}` };
}

const brief = (c) => (c ? { n: c.events, dates: c.dates, avg: c.avg, t: c.t, p: r4(c.p), median: c.eventMedian, top1: c.top1Share, blocks: c.positiveBlocks } : null);

// ── Main ────────────────────────────────────────────────────────────────────
async function study({ dry = false } = {}) {
  const t0 = Date.now();
  const U = K.loadUniverse(FROZEN.universe);
  const cal = makeCalendar(U.spy);
  const attr = { universe: U.attrition };
  const raw = {
    'activist-13d-initial': build13D(attr),
    'buyback-authorization-8k': buildBuyback(attr),
    'dividend-initiation': buildDividendInitiations(attr),
    'analyst-upgrade-cluster': buildUpgradeClusters(cal, attr),
  };
  const rowsByHyp = {};
  for (const [hyp, evs] of Object.entries(raw)) rowsByHyp[hyp] = scoreEvents(hyp, evs, U, cal, attr);
  tag13DVariantB(rowsByHyp['activist-13d-initial']);

  console.log('== attrition ==');
  console.log(JSON.stringify(attr, null, 1));
  if (dry) return;

  const cells = computeCells(rowsByHyp);
  const devIds = Object.keys(cells);
  const fdrRows = K.fdr(devIds.map((id) => ({ id, p: cells[id].dev.main && cells[id].dev.main.p })), { alpha: FROZEN.fdrAlpha });
  const fdrById = Object.fromEntries(fdrRows.map((r) => [r.id, r]));

  console.log('\n== DEVELOPMENT cells (2021-08-02..2024-12-31), FDR across', devIds.length, 'cells ==');
  for (const id of devIds) {
    const c = cells[id].dev, f = fdrById[id] || {};
    console.log(id.padEnd(36), JSON.stringify(brief(c.main)), 'q', r4(f.q), f.survives ? 'SURVIVES' : '', '| placebo', c.placebo ? `${c.placebo.avg} t ${c.placebo.t}` : null);
  }
  const verdicts = Object.fromEntries(Object.keys(FROZEN.hypotheses).map((h) => [h, verdictFor(h, cells, fdrById)]));

  console.log('\n== SEALED HOLDOUT cells (2025-01-02..2026-03-31) — read once ==');
  for (const id of devIds) {
    const c = cells[id].holdout;
    console.log(id.padEnd(36), JSON.stringify(brief(c.main)), '| doubled', c.doubled && c.doubled.avg, '| placebo', c.placebo ? `${c.placebo.avg} t ${c.placebo.t}` : null);
  }
  console.log('\n== VERDICTS ==');
  for (const [h, v] of Object.entries(verdicts)) console.log(h.padEnd(28), v.status.toUpperCase(), '—', v.reason);

  const out = {
    family: FAMILY, seal: SEAL, frozen: FROZEN, generatedAt: new Date().toISOString(), runMs: Date.now() - t0,
    attrition: attr, cells, fdr: fdrRows.map((r) => ({ id: r.id, p: r4(r.p), q: r4(r.q), survives: r.survives })), verdicts,
  };
  const art = K.writeArtifact(OUT_DIR, 'external-events-result.json', out);
  K.writeArtifact(OUT_DIR, 'external-events-rows.json', { rows: Object.values(rowsByHyp).flat().map((r) => ({ hyp: r.hyp, sym: r.sym, date: r.date, split: r.split, tier: r.tier, variants: r.variants, netx21: r.out[21] && r4(r.out[21].netx) })) });
  for (const hyp of Object.keys(FROZEN.hypotheses)) {
    const p = FROZEN.hypotheses[hyp].primary;
    const own = devIds.filter((id) => id.startsWith(`${hyp}:`));
    K.recordExperiment({
      id: `${hyp}-2026-09`, family: FAMILY, seal: SEAL,
      hypothesis: HYPOTHESIS_TEXT[hyp],
      frozenConfig: { shared: { ...FROZEN, hypotheses: undefined }, own: FROZEN.hypotheses[hyp] },
      dataSnapshot: { attrition: attr[hyp], events: (rowsByHyp[hyp] || []).length },
      trialCount: devIds.length,
      results: {
        primary: cellId(hyp, p.variant, p.H),
        dev: Object.fromEntries(own.map((id) => [id, { ...brief(cells[id].dev.main), q: r4((fdrById[id] || {}).q), survives: !!(fdrById[id] || {}).survives, placebo: brief(cells[id].dev.placebo) }])),
        holdout: Object.fromEntries(own.map((id) => [id, { ...brief(cells[id].holdout.main), doubledAvg: cells[id].holdout.doubled && cells[id].holdout.doubled.avg, placebo: brief(cells[id].holdout.placebo) }])),
        verdict: verdicts[hyp],
      },
      artifact: art,
    });
  }
  console.log(`\nartifact ${art.file} sha256 ${art.sha256.slice(0, 16)}; registry appended (${Object.keys(FROZEN.hypotheses).length} records); ${Date.now() - t0}ms`);
}

const HYPOTHESIS_TEXT = {
  'activist-13d-initial': 'An initial Schedule 13D filing (activist ≥5% stake, amendments excluded) is followed by positive cost-net SPY-excess return over the next 21 sessions from the next open.',
  'buyback-authorization-8k': 'A stand-alone 8-K announcing a share/stock repurchase program (item 8.01, not an earnings release) is followed by positive cost-net SPY-excess return over the next 21 sessions from the next open.',
  'dividend-initiation': 'The declaration of a first cash dividend after ≥3 years without one is followed by positive cost-net SPY-excess drift over the next 63 sessions from the next open.',
  'analyst-upgrade-cluster': 'Two or more distinct brokers upgrading the same name within 3 sessions is followed by positive cost-net SPY-excess return over the next 5 sessions from the next open.',
};

if (require.main === module) study({ dry: process.argv.includes('--dry') }).catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
module.exports = { FROZEN, FAMILY, SEAL, INITIAL_13D_FORMS, tickerOf, makeCalendar, cellStats, verdictFor, cellId, HYPOTHESIS_TEXT };
