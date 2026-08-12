// Governance state-transition ledger (gov-transitions-v1).
//
// governance/latest.json is overwritten wholesale on every op=maturity run, so the
// history of WHY a strategy moved between statuses lived nowhere: no old→new record,
// no approval linkage, no tamper evidence. Governance decisions are capital controls;
// the record of them must be append-only. This module diffs the prior governed doc
// against the new one and appends any transitions to the hash-chained immutable
// ledger (lib/immutable-ledger.js, stream 'governance-transitions') — one entry per
// run that actually changed something. The ledger is write-once, so a later run can
// alter the current state but never the record of how it got there.

const LEDGER_STREAM = 'governance-transitions';
const GOV_TRANSITIONS_VERSION = 'gov-transitions-v1';

// Pure diff of two governed-strategy lists (lib/governance governRegistry output).
// Emits one transition per strategy whose status OR scoring version changed —
// including first sight (from:null) and disappearance (to:null), both of which are
// governance events (a strategy silently leaving the registry is a state change).
function diffGovernance(prevStrategies, nextStrategies) {
  const prev = new Map((prevStrategies || []).map(s => [s.id, s]));
  const next = new Map((nextStrategies || []).map(s => [s.id, s]));
  const out = [];
  for (const [id, n] of next) {
    const p = prev.get(id) || null;
    const statusChanged = !p || p.status !== n.status;
    const versionChanged = !p || (p.version || null) !== (n.version || null);
    if (!statusChanged && !versionChanged) continue;
    out.push({
      id,
      from: p ? (p.status || null) : null,
      to: n.status || null,
      fromVersion: p ? (p.version || null) : null,
      toVersion: n.version || null,
      fromWeight: p && Number.isFinite(p.weight) ? p.weight : null,
      toWeight: Number.isFinite(n.weight) ? n.weight : null,
      reason: n.reason || null,
      versionReset: n.versionReset === true,
      grandfathered: n.grandfathered === true || undefined,
      // A move INTO production is only possible through a valid promotion artifact
      // (lib/governance demands it) — stamp that linkage so the ledger entry carries
      // the approval context, not just the outcome.
      approval: n.status === 'production'
        ? { artifactRequired: true, awaitingPromotionArtifact: n.awaitingPromotionArtifact === true }
        : null,
    });
  }
  for (const [id, p] of prev) {
    if (next.has(id)) continue;
    out.push({
      id, from: p.status || null, to: null,
      fromVersion: p.version || null, toVersion: null,
      fromWeight: Number.isFinite(p.weight) ? p.weight : null, toWeight: null,
      reason: 'removed from governed registry', versionReset: false, approval: null,
    });
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

// Compare the freshly computed governance doc against the prior persisted one and,
// when anything moved, append ONE ledger entry describing every transition in this
// run. Returns a small report for the HTTP response; never throws (a failed append
// must not block the governance write itself, but it must be VISIBLE).
async function recordGovernanceTransitions(prevGov, governance, meta = {}) {
  const transitions = diffGovernance(
    prevGov && prevGov.strategies, governance && governance.strategies);
  const report = { version: GOV_TRANSITIONS_VERSION, count: transitions.length, logged: false, error: null };
  if (!transitions.length) return report;
  try {
    const ledger = require('./immutable-ledger');
    const entry = await ledger.append(LEDGER_STREAM, {
      kind: GOV_TRANSITIONS_VERSION,
      transitions,
      governanceVersion: (governance && governance.version) || null,
      evidenceHash: meta.evidenceHash || null,
      scoreboardGeneratedAt: meta.scoreboardGeneratedAt || null,
      initial: !(prevGov && Array.isArray(prevGov.strategies) && prevGov.strategies.length),
    });
    report.logged = true;
    report.seq = entry.seq;
  } catch (e) {
    report.error = String((e && e.message) || e);
  }
  return report;
}

module.exports = { GOV_TRANSITIONS_VERSION, LEDGER_STREAM, diffGovernance, recordGovernanceTransitions };
