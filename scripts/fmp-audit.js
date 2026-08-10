'use strict';
// LOCAL FMP CAPABILITY AUDIT — `npm run fmp:audit`
//
// Same probe set as op=fmpaudit (lib/fmp-audit.js), run from a workstation with
// FMP_API_KEY in .env.local. Prints a human-readable table and writes the
// machine-readable report to research/private-data/fmp-capability-audit.json
// (git-ignored). Output is redacted by construction — the key and full URLs
// never reach stdout or the report file.
const fs = require('node:fs');
const path = require('node:path');
const { runFmpCapabilityAudit, STATUS } = require('../lib/fmp-audit');

const OUT_DIR = path.join(__dirname, '..', 'research', 'private-data');
const OUT_FILE = path.join(OUT_DIR, 'fmp-capability-audit.json');

const ORDER = [STATUS.AVAILABLE, STATUS.EMPTY_BUT_ACCESSIBLE, STATUS.PLAN_GATED, STATUS.INVALID_OR_LEGACY, STATUS.TEMPORARILY_FAILED, STATUS.UNTESTED];

async function main() {
  if (!process.env.FMP_API_KEY) {
    process.stderr.write('FMP_API_KEY is not set — add it to .env.local (git-ignored) and re-run.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('Probing FMP endpoint families (serial, ~30s)…\n\n');
  const report = await runFmpCapabilityAudit();

  for (const status of ORDER) {
    const ids = report.summary[status] || [];
    if (!ids.length) continue;
    process.stdout.write(`${status} (${ids.length})\n`);
    for (const id of ids) {
      const p = report.probes[id];
      const bits = [`http:${p.httpStatus ?? '—'}`, `rows:${p.rows}`];
      if (p.capped) bits.push('CAPPED');
      if (p.dateRange) bits.push(`${p.dateRange.earliest}..${p.dateRange.latest}`);
      if (p.knownUse) bits.push(`in-use:${p.knownUse}`);
      process.stdout.write(`  ${id.padEnd(36)} ${bits.join('  ')}\n`);
      if (p.error && status !== STATUS.AVAILABLE && status !== STATUS.EMPTY_BUT_ACCESSIBLE) {
        process.stdout.write(`    ↳ ${String(p.error).slice(0, 140)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  process.stdout.write(`Report written to ${path.relative(process.cwd(), OUT_FILE)} (${report.probeCount} probes, ${report.elapsedMs}ms)\n`);
}

main().catch((e) => {
  process.stderr.write(`fmp:audit failed: ${String((e && e.message) || e)}\n`);
  process.exitCode = 1;
});
