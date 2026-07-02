'use strict';
// Step 38 — join gap-CAUSE onto the survivorship-corrected Gap & Go event set.
//   node --env-file=research/.env research/38-gap-cause-join.js
//
// Takes the ORB-triggered events from research/data/gap-events.json (build: step 36),
// restricts to the FMP-news-available window (>= NEWS_FLOOR — FMP Starter news
// history bottoms out ~2025-10), fetches each event's gap-window headlines (disk
// cache research/data/gapnews/, same SYM_<from>.json key as the step-27 pilot so its
// 900 cached fetches are reused), classifies with the SHIPPED lib/gapgo.js
// classifyGapCause (headline-only — the exact production classifier under test),
// and writes research/data/gap-events-cause.json for step 39's evaluation.
//
// Unlike the step-27 pilot (close-close >=7% gaps, 21d drift), this joins cause to
// the ACTUAL strategy events (open gap >=3%, non-earnings, liquid, ORB-triggered,
// R-multiple outcome) — the strategy-relevant test of cause de-lumping.

const fs = require('fs');
const path = require('path');
const { classifyGapCause } = require('../lib/gapgo');

const DATA = path.join(__dirname, 'data');
const NEWSCACHE = path.join(DATA, 'gapnews');
const EVENTS = path.join(DATA, 'gap-events.json');
const OUT = path.join(DATA, 'gap-events-cause.json');
const KEY = process.env.FMP_API_KEY;
const NEWS_FLOOR = '2025-10-15';
const DAY = 86400000;
const CONCURRENCY = 4;
const THROTTLE_MS = 60;              // ~4x60ms staggered -> well under Starter rate cap
const RETRIES = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function windowFor(dateStr) {
  const ms = Date.parse(dateStr);
  return {
    from: new Date(ms - 3 * DAY).toISOString().slice(0, 10),
    to: new Date(ms + 1 * DAY).toISOString().slice(0, 10),
  };
}

async function fetchNews(sym, dateStr) {
  const { from, to } = windowFor(dateStr);
  const cf = path.join(NEWSCACHE, `${sym}_${from}.json`);
  if (fs.existsSync(cf)) {
    try { return JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { /* refetch */ }
  }
  const url = `https://financialmodelingprep.com/stable/news/stock?symbols=${sym}&from=${from}&to=${to}&limit=50&apikey=${KEY}`;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    await sleep(THROTTLE_MS * (attempt + 1));
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        const rows = Array.isArray(j)
          ? j.map(x => ({ title: x.title, text: (x.text || '').slice(0, 300), d: x.publishedDate }))
          : [];
        fs.mkdirSync(NEWSCACHE, { recursive: true });
        fs.writeFileSync(cf, JSON.stringify(rows));
        return rows;
      }
      if (![429, 500, 502, 503, 504].includes(r.status)) {
        throw new Error(`FMP ${r.status}`);
      }
      await sleep(500 * (attempt + 1));            // transient — back off and retry
    } catch (e) {
      if (attempt === RETRIES - 1) throw e;
    }
  }
  throw new Error('unreachable');
}

(async () => {
  if (!KEY) { console.error('FMP_API_KEY missing — run with node --env-file=research/.env'); process.exit(1); }
  const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8'))
    .filter(e => e.date >= NEWS_FLOOR);
  console.log(`${events.length} ORB events >= ${NEWS_FLOOR} (news-available window).`);

  const out = [];
  let done = 0, failed = 0;
  // small worker pool — bounded concurrency, polite to the Starter rate limit
  const queue = [...events];
  async function worker() {
    for (;;) {
      const ev = queue.shift();
      if (!ev) return;
      try {
        const news = await fetchNews(ev.sym, ev.date);
        out.push({ ...ev, cause: classifyGapCause(news), nNews: news.length });
      } catch (e) {
        failed++;
        out.push({ ...ev, cause: null, nNews: null, newsErr: String(e.message || e).slice(0, 60) });
      }
      if (++done % 250 === 0) console.log(`  ${done}/${events.length} (failed ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  out.sort((a, b) => a.date.localeCompare(b.date) || a.sym.localeCompare(b.sym));
  fs.writeFileSync(OUT, JSON.stringify(out));
  const byCause = {};
  for (const e of out) byCause[e.cause] = (byCause[e.cause] || 0) + 1;
  console.log(`\nsaved ${out.length} events → ${OUT} (fetch failures: ${failed})`);
  console.log('cause counts:', JSON.stringify(byCause));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
