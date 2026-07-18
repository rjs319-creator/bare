'use strict';
// PROVENANCE routes — folded into api/tracker.js (no new Serverless Function).
// Three ops share this module because they are one institutional concern (data
// provenance): the immutable run ledger, the run manifest, and the point-in-time
// security master.
//
//   op=runmanifest    (PRIVILEGED, cron)  — commit today's manifest to the `runs`
//                       hash-chain, pinning the deploy SHA + content hashes of the
//                       daily ledger outputs. Runs as the last step of the `ledger`
//                       warm-chain, after track/apexlog/ghostlog have written.
//   op=secmasterbuild (PRIVILEGED, cron)  — (re)assemble the point-in-time security
//                       master from universe + constituent-removals + observed ledger.
//   op=provenance     (PUBLIC read)       — inspect/verify: chain integrity, latest
//                       committed run, output verification, and PIT symbol resolution.
const manifest = require('./run-manifest');
const secmaster = require('./security-master');
const ledger = require('./immutable-ledger');
const { nowET } = require('./stats');
const { SECTOR_OF, LARGE, SMALL_CAPS, MICRO_CAPS, BIOTECH } = require('./universe');
const { readJSON, readAllPicks, hasStore } = require('./store');
const { fetchRemovedConstituents } = require('./constituents');

// The daily ledger artifacts the `ledger` warm-chain produces — what a run manifest pins.
const dailyOutputs = (date) => [`picks/${date}.json`, `apex/${date}.json`, `ghost/${date}.json`];

// ── op=runmanifest : commit today's provenance manifest ─────────────────────
async function runRunManifest(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: false, note: 'No Blob store configured — manifest not committed.' });
  }
  const startedAt = new Date().toISOString();
  const { date } = nowET();
  const keys = dailyOutputs(date);
  try {
    const outputs = await manifest.hashOutputs(keys);
    const m = manifest.buildManifest({
      runId: date,
      trigger: req.query.trigger || 'warm-cron',
      startedAt,
      inputs: [{ feed: 'yahoo', role: 'candles+corporate-actions' }, { feed: 'blob', role: 'daily-ledgers' }],
      params: { chain: 'ledger', outputsRequested: keys },
      outputs,
      note: 'Pins the deploy SHA and content hash of each daily ledger artifact for reproducibility + tamper-evidence.',
    });
    const result = await manifest.commitRun(m);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, date, committed: result.committed, reason: result.reason || null, seq: result.seq, hash: result.hash, code: m.code, outputs });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, date, error: String(e && e.message || e) });
  }
}

// ── op=secmasterbuild : (re)assemble the point-in-time security master ───────
async function runSecMasterBuild(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: false, note: 'No Blob store configured — security master not built.' });
  }
  try {
    // Currently-tradeable symbols: the curated universe ∪ the expanded candidates.
    const known = new Set([...LARGE, ...SMALL_CAPS, ...MICRO_CAPS, ...BIOTECH]);
    const cand = await readJSON('universe/candidates.json', null).catch(() => null);
    for (const t of (cand && cand.tickers) || []) known.add(t);

    // Removed constituents (survivorship correction) — best-effort; [] if the source fails.
    const removed = await fetchRemovedConstituents(5).catch(() => []);

    // First/last-seen observed from the app's OWN pick ledger (what we've known and since when).
    const observed = {};
    for (const p of await readAllPicks().catch(() => [])) {
      if (!p || !p.ticker || !p.date) continue;
      const o = observed[p.ticker] || (observed[p.ticker] = { firstSeen: p.date, lastSeen: p.date });
      if (p.date < o.firstSeen) o.firstSeen = p.date;
      if (p.date > o.lastSeen) o.lastSeen = p.date;
    }

    const doc = await secmaster.saveMaster({ sectorOf: SECTOR_OF, knownSymbols: [...known], removed, observed });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, version: doc.v, builtAt: doc.builtAt, count: doc.count, removed: removed.length, observed: Object.keys(observed).length });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

// ── op=provenance : read / verify (public) ──────────────────────────────────
// Views: default summary, ?view=runs, ?view=verify[&run=<seq>], ?view=ledger&stream=<s>,
//        ?view=secmaster[&symbol=<s>&asOf=<date>] , ?view=universeat&date=<date>
async function runProvenance(req, res) {
  const view = req.query.view || 'summary';
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (view === 'runs') {
      const [manifests, integrity] = await Promise.all([manifest.readManifests(Number(req.query.limit) || 30), manifest.verifyRuns()]);
      return res.json({ ok: true, view, integrity, count: manifests.length, manifests });
    }
    if (view === 'verify') {
      const latest = await manifest.latestManifest();
      let target = latest;
      if (req.query.run != null) {
        const all = await manifest.readManifests(1000);
        target = all.find(m => String(m.seq) === String(req.query.run)) || null;
      }
      if (!target) return res.json({ ok: true, view, note: 'No committed run to verify yet.' });
      const outputs = await manifest.verifyOutputs(target.manifest);
      return res.json({ ok: true, view, run: { seq: target.seq, hash: target.hash, runId: target.manifest.runId, code: target.manifest.code }, verification: outputs });
    }
    if (view === 'ledger') {
      const stream = req.query.stream || manifest.RUN_STREAM;
      return res.json({ ok: true, view, verification: await ledger.verify(stream) });
    }
    if (view === 'secmaster') {
      if (req.query.symbol) {
        const r = await secmaster.resolveSecurityId(String(req.query.symbol).toUpperCase(), req.query.asOf || null, SECTOR_OF);
        return res.json({ ok: true, view, resolution: r });
      }
      const master = await secmaster.loadMaster();
      return res.json({ ok: true, view, built: !!master, builtAt: master && master.builtAt, count: master ? master.count : 0, version: master && master.v });
    }
    if (view === 'universeat') {
      return res.json({ ok: true, view, ...(await secmaster.universeAt(req.query.date || null)) });
    }
    // Default: one-glance provenance health.
    const [integrity, latest, master] = await Promise.all([
      manifest.verifyRuns(),
      manifest.latestManifest(),
      secmaster.loadMaster(),
    ]);
    return res.json({
      ok: true, view: 'summary',
      runs: {
        committed: integrity.length,
        chainOk: integrity.ok,
        brokenAt: integrity.brokenAt,
        latest: latest ? { seq: latest.seq, runId: latest.manifest.runId, sha: (latest.manifest.code || {}).sha, at: latest.recordedAt } : null,
      },
      secmaster: { built: !!master, builtAt: master && master.builtAt, count: master ? master.count : 0 },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, view, error: String(e && e.message || e) });
  }
}

module.exports = { runRunManifest, runSecMasterBuild, runProvenance, dailyOutputs };
