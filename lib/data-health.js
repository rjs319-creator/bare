'use strict';
// CONSOLIDATED DATA-HEALTH REPORT (data-health-v1)
//
// One daily, machine-readable artifact answering "is the data foundation sound today?"
// The pieces existed but were scattered across op=health (cron stages), op=provenance
// (hash chains), op=daytradescanhealth (grading backlog), op=universescan — nothing
// assembled universe counts, ledger completeness, pending-outcome counts and artifact
// staleness into one view. This module does, read-only and bounded (a fixed handful of
// Blob reads; every failure is captured per-section, never thrown).
//
// Honesty rules: a section that cannot be read reports {ok:false, error} — absence of
// data is a finding, not a blank. All error strings pass through redactSecrets().

const { readJSON } = require('./store');
const RS = require('./research/store');
const { redactSecrets } = require('./redact');

const DATA_HEALTH_VERSION = 'data-health-v1';
const RECENT_DAYS = 7;          // ledger-completeness lookback (calendar days)
const STALE_UNIVERSE_DAYS = 10; // curated-universe rebuild considered stale after this

const daysAgo = (iso, now) => iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null;

async function section(name, fn) {
  try { return { name, ok: true, ...(await fn()) }; }
  catch (e) { return { name, ok: false, error: redactSecrets((e && e.message) || e) }; }
}

async function buildDataHealthReport({ now = Date.now() } = {}) {
  const sections = await Promise.all([
    // Universe: candidate counts + build freshness. Unknown membership fails closed
    // upstream; here we surface how stale the mechanically-built list is.
    section('universe', async () => {
      const doc = await readJSON('universe/candidates.json', null);
      if (!doc) return { present: false, warning: 'no mechanical universe build found' };
      const age = daysAgo(doc.builtAt, now);
      return {
        present: true, tickers: (doc.tickers || []).length, dropped: doc.dropped ?? null,
        builtAt: doc.builtAt || null, ageDays: age,
        stale: age != null ? age > STALE_UNIVERSE_DAYS : true,
      };
    }),
    // Security master: active/removed/observed counts + the honest survivorship flag.
    section('securityMaster', async () => {
      const m = await readJSON('secmaster/master.json', null);
      if (!m) return { present: false, warning: 'production security master not built' };
      return {
        present: true, version: m.version || null, builtAt: m.builtAt || null,
        count: (m.records && Object.keys(m.records).length) || m.count || null,
        removed: (m.removed && m.removed.length) || m.removedCount || null,
        survivorshipSafe: m.survivorshipSafe === true,   // expected FALSE — asserting otherwise needs gates
      };
    }),
    // Prospective decision-ledger completeness: which of the last N weekdays have a
    // write-once decision snapshot, and do recent snapshots carry rejected candidates.
    section('decisionLedger', async () => {
      const dates = RS.recentDates(new Date(now).toISOString().slice(0, 10), RECENT_DAYS);
      const days = await Promise.all(dates.map(async (d) => {
        const snap = await RS.loadDecisionSnapshot(d).catch(() => null);
        return snap ? {
          date: d, present: true, n: snap.nPredictions ?? null, nRejected: snap.nRejected ?? null,
          caveats: (snap.caveats || []).length,
        } : { date: d, present: false };
      }));
      const present = days.filter((d) => d.present);
      const withRejected = present.filter((d) => (d.nRejected || 0) > 0);
      return {
        lookbackDays: dates.length, daysPresent: present.length,
        daysWithRejectedCandidates: withRejected.length,
        selectionBiasWarning: present.length > 0 && withRejected.length === 0
          ? 'no snapshot in the window carries rejected candidates — full-population logging may be broken' : null,
        days,
      };
    }),
    // Pending/unresolved outcome counts by horizon from the newest horizon-outcome batch.
    section('outcomes', async () => {
      const dates = RS.recentDates(new Date(now).toISOString().slice(0, 10), RECENT_DAYS);
      for (const d of dates) {
        const batch = await RS.loadHorizonOutcomes(d).catch(() => null);
        if (!batch) continue;
        const rows = batch.outcomes || batch.vectors || [];
        const tally = { batchDate: d, rows: rows.length, pendingRungs: 0, filledRungs: 0, byHorizon: {} };
        for (const r of rows) {
          const horizons = r.horizons || r.rungs || {};
          for (const [h, v] of Object.entries(horizons)) {
            const st = (v && (v.status || (v.value != null ? 'filled' : 'pending'))) || 'pending';
            const bucket = (tally.byHorizon[h] ||= { filled: 0, pending: 0, other: 0 });
            if (st === 'filled' || st === 'mature') { bucket.filled++; tally.filledRungs++; }
            else if (st === 'pending') { bucket.pending++; tally.pendingRungs++; }
            else bucket.other++;
          }
        }
        return tally;
      }
      return { warning: `no horizon-outcome batch found in the last ${RECENT_DAYS} days` };
    }),
    // Feed/key availability — booleans only, never values.
    section('keys', async () => ({
      fmp: !!process.env.FMP_API_KEY,
      finnhub: !!process.env.FINNHUB_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      blobStore: !!process.env.BLOB_READ_WRITE_TOKEN,
      cronSecret: !!process.env.CRON_SECRET,
    })),
    // Router state freshness (shadow) — a stale router doc means the daily force run died.
    section('router', async () => {
      const st = await readJSON('router/latest.json', null);
      if (!st) return { present: false };
      const age = daysAgo(st.savedAt, now);
      return { present: true, savedAt: st.savedAt || null, ageDays: age, stale: age != null && age > 4 };
    }),
  ]);

  const problems = [];
  for (const s of sections) {
    if (!s.ok) problems.push(`${s.name}: ${s.error}`);
    else if (s.warning) problems.push(`${s.name}: ${s.warning}`);
    else if (s.selectionBiasWarning) problems.push(`decisionLedger: ${s.selectionBiasWarning}`);
    else if (s.stale) problems.push(`${s.name}: stale`);
  }

  return {
    version: DATA_HEALTH_VERSION,
    generatedAt: new Date(now).toISOString(),
    healthy: problems.length === 0,
    problems,
    sections: Object.fromEntries(sections.map((s) => [s.name, s])),
  };
}

module.exports = { DATA_HEALTH_VERSION, buildDataHealthReport };
