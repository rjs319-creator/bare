#!/usr/bin/env node
'use strict';
// pull-intraday — download the accrued fader-regime intraday capture (Blob intraday/*.json)
// into research/data/intra5b/ so the opening-range-gate re-validation (research/41) can be
// re-run once neutral/risk-off fader sessions have accumulated.
//
//   BLOB_READ_WRITE_TOKEN=... node scripts/pull-intraday.js
//
// Writes one file per session (intra5b/<date>.json = { date, regime, signalDate, events })
// plus an index.json summarising coverage by regime. Read-only against Blob.

const fs = require('fs');
const path = require('path');

async function main() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) { console.error('BLOB_READ_WRITE_TOKEN not set (pull it from Vercel: `vercel env pull`).'); process.exit(1); }
  const { list } = require('@vercel/blob');

  const outDir = path.resolve(__dirname, '..', 'research', 'data', 'intra5b');
  fs.mkdirSync(outDir, { recursive: true });

  const DAILY_RE = /^intraday\/\d{4}-\d{2}-\d{2}\.json$/;
  const blobs = []; let cursor;
  do { const r = await list({ prefix: 'intraday/', cursor, limit: 1000, token }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const daily = blobs.filter(b => DAILY_RE.test(b.pathname));
  if (!daily.length) { console.log('No intraday/ captures found yet — the daily cron accrues one session per trading day.'); return; }

  const index = { pulledAt: new Date().toISOString(), sessions: 0, events: 0, byRegime: {}, days: [] };
  for (const b of daily) {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) { console.warn('skip', b.pathname, res.status); continue; }
      const doc = await res.json();
      const n = doc.count != null ? doc.count : (doc.events || []).length;
      fs.writeFileSync(path.join(outDir, `${doc.date}.json`), JSON.stringify(doc));
      index.sessions++; index.events += n;
      index.byRegime[doc.regime || 'unknown'] = (index.byRegime[doc.regime || 'unknown'] || 0) + n;
      index.days.push({ date: doc.date, regime: doc.regime || null, count: n });
    } catch (e) { console.warn('error', b.pathname, String(e && e.message || e)); }
  }
  index.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Pulled ${index.sessions} sessions, ${index.events} events → ${outDir}`);
  console.log('By regime:', index.byRegime);
}

main().catch(e => { console.error(e); process.exit(1); });
