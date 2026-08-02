'use strict';
// op=datahealth — the consolidated daily data-health report (lib/data-health.js).
// Read-only, bounded, secrets never appear (booleans + redacted error strings only).

const { buildDataHealthReport } = require('./data-health');

async function runDataHealth(req, res) {
  const report = await buildDataHealthReport();
  res.setHeader('Cache-Control', 's-maxage=300');
  return res.json({ ok: true, ...report });
}

module.exports = { runDataHealth };
