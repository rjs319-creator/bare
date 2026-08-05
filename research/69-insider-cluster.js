'use strict';
// Step 69 — INSIDER CLUSTER × DRAWDOWN (exploratory, registered 2026-08-05).
//   node research/69-insider-cluster.js --pull     # resumable EDGAR Form-4 pull only
//   node research/69-insider-cluster.js            # study (pull first if data missing)
//
// The ONE preregistered exploratory pass for hypothesis `insider-cluster-drawdown`
// (family alt-signals) — see research/PREREGISTRATION-INSIDER-CLUSTER-2026-08.md.
// ALL parameters are FROZEN there and mirrored here as constants; tuning any of
// them is a new hypothesis.
//
// PIT rule: the event date is the LATEST FILING date of the cluster's members —
// a cluster is only knowable once its last member files (transaction-date
// anchoring would leak the disclosure lag, the congress-trades lesson).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EL = require('../lib/research/evidence-log');
const REG = require('../lib/research/hypothesis-registry');
const { SMALL_CAPS, MICRO_CAPS } = require('../lib/universe');
const { fetchInsiderTransactions } = require('../lib/edgar');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const EDGAR_DIR = path.join(DATA, 'insider-edgar');
const HYP_ID = 'insider-cluster-drawdown';

// FROZEN DESIGN (preregistration §2)
const FILINGS_FROM = '2021-01-01';
const MAX_FILINGS = 150;
const CLUSTER_WINDOW_DAYS = 14;
const MIN_OWNERS = 2;
const MIN_COMBINED_VALUE = 50_000;
const DRAWDOWN_FRAC = 0.70;                     // close ≤ 0.70 × trailing-252-bar max close
const DRAWDOWN_LOOKBACK = 252;
const COOLDOWN_SESSIONS = 21;
const HOLDS = [21, 63];
const PLACEBO_SHIFT_SESSIONS = 126;
const MIN_PRIMARY_EVENTS = 40;                  // fail-closed: fewer ⇒ invalid-data
const EVENT_TO = '2026-03-31';                  // leaves ≥63 sessions of bars for exits

const DAY = 86_400_000;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const r4 = (x) => (x == null ? null : +x.toFixed(4));
const statsOf = (a) => (a.length ? { n: a.length, meanPct: r4(mean(a)), t: r4(tOf(a)), hitRate: r4(a.filter((x) => x > 0).length / a.length) } : { n: 0, meanPct: null, t: null, hitRate: null });

const universe = () => [...new Set([...SMALL_CAPS, ...MICRO_CAPS])].map((t) => String(t).toUpperCase());

// ── resumable EDGAR pull (one JSON per symbol; skip existing) ───────────────
async function pull() {
  fs.mkdirSync(EDGAR_DIR, { recursive: true });
  const names = universe();
  let done = 0, skipped = 0, failed = 0;
  for (const sym of names) {
    const f = path.join(EDGAR_DIR, `${sym}.json`);
    if (fs.existsSync(f)) { skipped++; continue; }
    try {
      const r = await fetchInsiderTransactions(sym, { fromDate: FILINGS_FROM, maxFilings: MAX_FILINGS });
      fs.writeFileSync(f, JSON.stringify({ ...r, pulledAt: new Date().toISOString() }));
      done++;
      if (done % 20 === 0) console.log(`pulled ${done} (skipped ${skipped}, failed ${failed}) — last ${sym}: ${r.txs.length} txs`);
    } catch (e) {
      failed++;
      console.log(`FAILED ${sym}: ${String(e && e.message).slice(0, 80)}`);
    }
  }
  console.log(`pull complete: ${done} fetched, ${skipped} already cached, ${failed} failed, universe ${names.length}`);
}

// ── PURE: cluster construction (locked by test/insider-cluster-prereg.test.js) ──
// txs: [{date, code, shares, price, value, owner, filingDate}] for ONE symbol →
// [{eventDate (latest FILING date), owners, combinedValue, txDates}] with
// overlapping windows collapsed: each P-buy belongs to at most one event, built
// greedily in transaction-date order; per-name session cooldown applied later
// (needs the bar axis).
function clusterEvents(txs, {
  windowDays = CLUSTER_WINDOW_DAYS, minOwners = MIN_OWNERS, minValue = MIN_COMBINED_VALUE,
} = {}) {
  const buys = (txs || [])
    .filter((t) => t && t.code === 'P' && t.shares > 0 && t.price > 0 && t.owner && t.date && t.filingDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const events = [];
  let i = 0;
  while (i < buys.length) {
    const start = Date.parse(buys[i].date);
    const members = [];
    let j = i;
    while (j < buys.length && Date.parse(buys[j].date) - start <= windowDays * DAY) { members.push(buys[j]); j++; }
    const owners = new Set(members.map((m) => m.owner.trim().toUpperCase()));
    const combinedValue = members.reduce((s, m) => s + (m.value || Math.round(m.shares * m.price)), 0);
    if (owners.size >= minOwners && combinedValue >= minValue) {
      const eventDate = members.map((m) => String(m.filingDate).slice(0, 10)).sort().pop();
      events.push({ eventDate, owners: owners.size, combinedValue, txDates: [members[0].date, members[members.length - 1].date] });
      i = j;                                    // consume the window — no overlapping events
    } else {
      i++;
    }
  }
  return events;
}

// Single-buyer comparison events: P-buys ≥ $25k that are NOT part of any cluster
// window (frozen: half the cluster dollar floor, one owner). Comparison cohort
// only — never a gate.
function singleBuyerEvents(txs, clusterEvts) {
  const inCluster = (d) => clusterEvts.some((c) => {
    const t = Date.parse(d);
    return t >= Date.parse(c.txDates[0]) - CLUSTER_WINDOW_DAYS * DAY && t <= Date.parse(c.txDates[1]) + CLUSTER_WINDOW_DAYS * DAY;
  });
  return (txs || [])
    .filter((t) => t && t.code === 'P' && t.shares > 0 && t.price > 0 && t.owner && t.date && t.filingDate)
    .filter((t) => (t.value || t.shares * t.price) >= 25_000 && !inCluster(t.date))
    .map((t) => ({ eventDate: String(t.filingDate).slice(0, 10), owners: 1, combinedValue: t.value || Math.round(t.shares * t.price) }));
}

const loadBars = (sym) => {
  try { return pit.priceSeries(JSON.parse(fs.readFileSync(path.join(pit.CACHE, `${sym}.json`), 'utf8')).price); } catch { return null; }
};

const barIdxAt = (bars, ms) => { let idx = -1; for (let k = 0; k < bars.length; k++) { if (bars[k].ms <= ms) idx = k; else break; } return idx; };

function excessFromIdx(bars, spy, idx, h) {
  const e0 = idx + 1, e1 = idx + 1 + h;
  if (idx < 0 || e1 >= bars.length) return null;
  let s0 = -1; for (let k = 0; k < spy.length; k++) { if (spy[k].ms <= bars[e0].ms) s0 = k; else break; }
  const s1 = s0 + h;
  if (s0 < 0 || s1 >= spy.length) return null;
  return (bars[e1].close / bars[e0].close - 1 - (spy[s1].close / spy[s0].close - 1)) * 100;
}

const isDrawdown = (bars, idx) => {
  if (idx < DRAWDOWN_LOOKBACK) return null;    // insufficient history — condition unknowable, event dropped
  let hi = 0; for (let k = idx - DRAWDOWN_LOOKBACK; k <= idx; k++) hi = Math.max(hi, bars[k].close);
  return bars[idx].close <= DRAWDOWN_FRAC * hi;
};

async function study() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);
  const spy = loadBars('SPY');
  if (!spy) { console.log('BLOCKED: SPY cache missing'); process.exitCode = 1; return; }

  const cohorts = { clusterDrawdown: [], clusterNoDrawdown: [], singleBuyer: [], placebo: [] };
  let symbolsWithData = 0, noBars = 0, eventsRaw = 0, cooled = 0, noHistory = 0;
  for (const sym of universe()) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(EDGAR_DIR, `${sym}.json`), 'utf8')); } catch { continue; }
    if (!doc.txs || !doc.txs.length) continue;
    symbolsWithData++;
    const bars = loadBars(sym);
    if (!bars) { noBars++; continue; }

    const clusters = clusterEvents(doc.txs);
    const singles = singleBuyerEvents(doc.txs, clusters);
    let lastIdx = -Infinity;
    for (const ev of clusters.sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1))) {
      if (ev.eventDate > EVENT_TO) continue;
      eventsRaw++;
      const idx = barIdxAt(bars, Date.parse(ev.eventDate));
      if (idx < 0) continue;
      if (idx - lastIdx < COOLDOWN_SESSIONS) { cooled++; continue; }
      const dd = isDrawdown(bars, idx);
      if (dd === null) { noHistory++; continue; }
      const ex = {}; for (const h of HOLDS) ex[h] = excessFromIdx(bars, spy, idx, h);
      if (ex[21] == null && ex[63] == null) continue;
      lastIdx = idx;
      (dd ? cohorts.clusterDrawdown : cohorts.clusterNoDrawdown).push({ sym, ...ev, ex });
      if (dd) {
        const pex = {}; for (const h of HOLDS) pex[h] = excessFromIdx(bars, spy, idx - PLACEBO_SHIFT_SESSIONS, h);
        if (pex[21] != null || pex[63] != null) cohorts.placebo.push({ sym, eventDate: ev.eventDate, ex: pex });
      }
    }
    for (const ev of singles) {
      if (ev.eventDate > EVENT_TO) continue;
      const idx = barIdxAt(bars, Date.parse(ev.eventDate));
      if (idx < 0) continue;
      const dd = isDrawdown(bars, idx);
      if (dd !== true) continue;                // comparison holds the drawdown condition fixed — isolates the CLUSTER term
      const ex = {}; for (const h of HOLDS) ex[h] = excessFromIdx(bars, spy, idx, h);
      if (ex[21] != null || ex[63] != null) cohorts.singleBuyer.push({ sym, ...ev, ex });
    }
  }

  const summary = {};
  for (const [name, evs] of Object.entries(cohorts)) {
    summary[name] = {};
    for (const h of HOLDS) summary[name][h] = statsOf(evs.map((e) => e.ex[h]).filter((x) => x != null));
    console.log(`${name}: ${evs.length} events | 21s ${JSON.stringify(summary[name][21])} | 63s ${JSON.stringify(summary[name][63])}`);
  }
  console.log(`coverage: ${symbolsWithData} symbols with Form-4 data, ${noBars} lacked price cache, ${eventsRaw} raw clusters, ${cooled} cooled-down, ${noHistory} lacked 252-bar history`);

  // FROZEN verdict (preregistration §2): fail-closed on thin primary cohort.
  const prim = summary.clusterDrawdown;
  const nPrimary = cohorts.clusterDrawdown.length;
  let verdict;
  if (nPrimary < MIN_PRIMARY_EVENTS) verdict = 'invalid-data';
  else verdict = (prim[63].t != null && prim[63].t >= 2 && prim[21].meanPct != null && prim[21].meanPct > 0) ? 'pass-provisional' : 'not-confirmed';
  console.log(`FROZEN CRITERION → primary n ${nPrimary} (min ${MIN_PRIMARY_EVENTS}), 63s t ${prim[63].t}, 21s mean ${prim[21].meanPct} ⇒ VERDICT ${verdict.toUpperCase()}`);

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
    datasetHash: `edgar-form4-cluster:${crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex').slice(0, 16)}`,
    periodStart: FILINGS_FROM, periodEnd: EVENT_TO,
    horizon: '63d',
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify({ summary, symbolsWithData, eventsRaw })).digest('hex').slice(0, 16),
    metrics: { summary, nPrimary, symbolsWithData, noBars, eventsRaw, cooledDown: cooled, noHistory },
    verdict,
    mode: 'exploratory',
    generatedAt: new Date().toISOString(),
    note: `The ONE registered exploratory pass (window now SPENT for ${HYP_ID}). Event date = latest cluster FILING date (PIT). Universe present-day small/micro lists (survivorship-reduced; cohort comparisons share the bias). Comparison cohorts hold the drawdown condition fixed to isolate the cluster term.`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
  await EL.appendEvidence(deps, rec.record).then((r) => console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/${HYP_ID}/`));
}

async function main() {
  if (process.argv.includes('--pull')) return pull();
  const missing = universe().filter((s) => !fs.existsSync(path.join(EDGAR_DIR, `${s}.json`)));
  if (missing.length) { console.log(`data incomplete (${missing.length} symbols unpulled) — running pull first`); await pull(); }
  return study();
}

if (require.main === module) main();
module.exports = { clusterEvents, singleBuyerEvents, HYP_ID, CLUSTER_WINDOW_DAYS, MIN_OWNERS, MIN_COMBINED_VALUE, DRAWDOWN_FRAC, MIN_PRIMARY_EVENTS };
