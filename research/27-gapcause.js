'use strict';
// Step 27 — gap-cause tagging PILOT (FMP news, recent window only).
//   node --env-file=research/.env research/27-gapcause.js [maxEvents]
//
// DATA REALITY: FMP Starter news history bottoms out ~2025-10 (12mo) = a single
// risk-on window — same trap that killed PEAD/exits. So this is a PILOT: prove the
// tagging works + measure coverage + a *caveated* recent-window continuation read.
// It CANNOT be a regime-robust verdict.
//
// PRE-REGISTERED taxonomy (priority order; "no news" is its own class = keep, don't drop):
//   FADE:     offering / dilution / priced / ATM / convertible / warrant / shelf / placement
//   CONTINUE: FDA/approval/trial ; M&A/acquire/merger ; contract/award/partnership ; guidance/beat/record
//   OTHER:    news exists but no category ;   NONE: no news rows in window
// Hypothesis: FADE gaps continue LESS (should be hard-skipped in gapTake); CONTINUE gaps continue MORE.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');

const DATA = path.join(__dirname, 'data');
const NEWSCACHE = path.join(DATA, 'gapnews');
const KEY = process.env.FMP_API_KEY;
const WIN_LO = Date.UTC(2025, 9, 15), WIN_HI = Date.UTC(2026, 4, 31);   // gap must fall in-window (news avail + 21d fwd)
const MAXEV = Number(process.argv[2]) || 900;
const DAY = 86400000;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
const wins = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const RX = {
  FADE: /offering|dilut|priced at|prices \$|registered direct|at-the-market|\bATM\b|convertible|\bshelf\b|secondary offering|public offering|private placement|\bwarrant|pricing of/i,
  FDA: /\bFDA\b|approval|approved|clearance|phase [123]|clinical|topline|breakthrough|orphan|PDUFA|trial (met|data|results)/i,
  MA: /acqui|merger|to be acquired|buyout|takeover|to acquire|agrees? to buy|going private/i,
  CONTRACT: /contract|awarded|\baward\b|partnership|collaborat|\bagreement\b|selected by|order worth|wins |secures |deal with/i,
  GUIDE: /raises? guidance|raised guidance|\bbeats?\b|tops estimates|record (revenue|quarter|results)|upgrade|initiat.*buy|price target rais/i,
};
function classify(newsRows) {
  if (!newsRows.length) return 'NONE';
  const blob = newsRows.map(r => `${r.title} . ${r.text || ''}`).join(' \n ');
  if (RX.FADE.test(blob)) return 'FADE';            // dilution dominates → check first
  if (RX.FDA.test(blob)) return 'FDA';
  if (RX.MA.test(blob)) return 'MA';
  if (RX.CONTRACT.test(blob)) return 'CONTRACT';
  if (RX.GUIDE.test(blob)) return 'GUIDE';
  return 'OTHER';
}

async function newsFor(sym, gapMs) {
  const from = new Date(gapMs - 3 * DAY).toISOString().slice(0, 10);
  const to = new Date(gapMs + 1 * DAY).toISOString().slice(0, 10);
  const cf = path.join(NEWSCACHE, `${sym}_${from}.json`);
  if (fs.existsSync(cf)) { try { return JSON.parse(fs.readFileSync(cf, 'utf8')); } catch {} }
  const url = `https://financialmodelingprep.com/stable/news/stock?symbols=${sym}&from=${from}&to=${to}&limit=50&apikey=${KEY}`;
  let rows = [];
  try { const r = await fetch(url); if (r.ok) { const j = await r.json(); if (Array.isArray(j)) rows = j.map(x => ({ title: x.title, text: (x.text || '').slice(0, 300), d: x.publishedDate })); } } catch {}
  fs.mkdirSync(NEWSCACHE, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(rows));
  return rows;
}

(async () => {
  if (!KEY) { console.error('run with: node --env-file=research/.env research/27-gapcause.js'); process.exit(1); }
  const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  const syms = Object.keys(sj);

  // 1) detect in-window gap events on the corrected cache
  const events = [];
  for (const sym of syms) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const ps = pit.priceSeries(c.price); if (ps.length < 120) continue;
    const ss = pit.sharesSeries(c.income); if (!ss.length) continue;
    for (let i = 60; i < ps.length - 21; i++) {
      if (ps[i].ms < WIN_LO || ps[i].ms > WIN_HI) continue;
      const g = ps[i].close / ps[i - 1].close - 1;
      if (g < 0.07 || g > 0.60) continue;
      const nxt = ps[i + 1] ? ps[i + 1].close / ps[i].close - 1 : 0;
      if (g > 0.25 && nxt < -0.20) continue;         // split artifact guard
      const pa = pit.asOfPriceAdv(ps, ps[i].ms); const sh = pit.asOfShares(ss, ps[i].ms);
      if (!pa || !sh) continue; const cap = pa.close * sh;
      if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;   // small/mid in-band
      events.push({ sym, ms: ps[i].ms, gap: g, c5: wins(ps[i + 5].close / ps[i].close - 1, -0.9, 2), c21: wins(ps[i + 21].close / ps[i].close - 1, -0.9, 2) });
    }
  }
  console.log(`${events.length} in-band gap-up events in ${new Date(WIN_LO).toISOString().slice(0, 10)}..${new Date(WIN_HI).toISOString().slice(0, 10)}.`);

  // 2) sample (deterministic stride) down to MAXEV to bound API calls
  const step = Math.max(1, Math.floor(events.length / MAXEV));
  const sample = events.filter((_, i) => i % step === 0).slice(0, MAXEV);
  console.log(`classifying ${sample.length} (stride ${step})…`);

  // 3) fetch + classify
  const byClass = {};
  let done = 0;
  for (const ev of sample) {
    const news = await newsFor(ev.sym, ev.ms);
    ev.cls = classify(news); ev.nNews = news.length;
    (byClass[ev.cls] || (byClass[ev.cls] = [])).push(ev);
    if (++done % 150 === 0) process.stdout.write(`  ${done}/${sample.length}\n`);
  }

  // 4) report
  const total = sample.length, covered = sample.filter(e => e.cls !== 'NONE').length;
  console.log(`\n=== Gap-cause PILOT (${total} events; ${(100 * covered / total).toFixed(0)}% had news; single risk-on window — NOT regime-robust) ===\n`);
  const order = ['FADE', 'FDA', 'MA', 'CONTRACT', 'GUIDE', 'OTHER', 'NONE'];
  console.log('class     n     share   mean gap   cont+5d    cont+21d');
  for (const k of order) {
    const g = byClass[k] || []; if (!g.length) continue;
    console.log(`${k.padEnd(9)} ${String(g.length).padStart(4)}  ${(100 * g.length / total).toFixed(1).padStart(5)}%   ${pct(mean(g.map(e => e.gap))).padStart(7)}   ${pct(mean(g.map(e => e.c5))).padStart(7)}   ${pct(mean(g.map(e => e.c21))).padStart(7)}`);
  }
  const fade = byClass.FADE || [], cont = [...(byClass.FDA || []), ...(byClass.MA || []), ...(byClass.CONTRACT || []), ...(byClass.GUIDE || [])];
  console.log(`\nKEY CONTRAST (21d continuation):`);
  console.log(`  FADE (offering/dilution) ${pct(mean(fade.map(e => e.c21)))} (n=${fade.length})   vs   CONTINUE catalysts ${pct(mean(cont.map(e => e.c21)))} (n=${cont.length})`);
  console.log(`  baseline all-gaps ${pct(mean(sample.map(e => e.c21)))}`);
  console.log('\nVERDICT cues: FADE << CONTINUE (esp. FADE negative) = cause de-lumps the gap edge → hard-skip offerings worth piloting live. Caveat: single-regime, small n per class.');
})();
