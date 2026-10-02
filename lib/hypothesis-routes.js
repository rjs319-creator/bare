'use strict';
// op=hypotheses — read-only view of the hypothesis registry + negative-results
// graveyard (lib/research/hypothesis-registry.js). The Research Lab leads with the
// decision and evidence quality: what was tested, under what stopping rule, and what
// happened — including (especially) the failures, so a dead idea is never quietly
// re-run as if new. No secrets, no raw licensed payloads, no writes.

const fs = require('node:fs');
const path = require('node:path');
const HR = require('./research/hypothesis-registry');

// Independent overfit cross-check badge (research/101-overfit-crosscheck.py --publish writes
// lib/research/overfit-crosscheck.json: { overall, generatedAt, byHypothesis: { id: {...} } }).
// Read-only, additive, fail-closed: a missing or malformed file means no badge, never an error.
const CROSSCHECK_FILE = path.join(__dirname, 'research', 'overfit-crosscheck.json');
const CROSSCHECK_VERDICTS = new Set(['agree', 'disagree', 'not-computable']);

function readCrossCheck(file = CROSSCHECK_FILE) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || !CROSSCHECK_VERDICTS.has(doc.overall)) return null;
    const byHypothesis = {};
    for (const [id, b] of Object.entries(doc.byHypothesis || {})) {
      if (b && CROSSCHECK_VERDICTS.has(b.verdict)) byHypothesis[id] = { verdict: b.verdict, checkedAt: b.checkedAt || null, matrix: b.matrix || null };
    }
    return { overall: doc.overall, generatedAt: doc.generatedAt || null, byHypothesis };
  } catch { return null; }
}

function withCrossCheck(hypotheses, crossCheck) {
  if (!crossCheck) return hypotheses;
  return hypotheses.map((h) => (crossCheck.byHypothesis[h.id] ? { ...h, crossCheck: crossCheck.byHypothesis[h.id] } : h));
}

async function runHypotheses(req, res) {
  const counts = {};
  for (const s of HR.STATUSES) counts[s] = HR.byStatus(s).length;
  const crossCheck = readCrossCheck();
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.json({
    ok: true,
    version: HR.REGISTRY_VERSION,
    totalTrials: HR.totalTrials(),
    counts,
    graveyardN: HR.graveyard().length,
    sealedHoldouts: HR.HOLDOUTS.length,
    untouchedHoldouts: HR.untouchedHoldouts().length,
    crossCheck: crossCheck ? { overall: crossCheck.overall, generatedAt: crossCheck.generatedAt } : null,
    hypotheses: withCrossCheck(HR.HYPOTHESES, crossCheck),
    note: 'Committed preregistration + graveyard. Statuses summarize the cited evidence artifacts; '
      + 'entries predating this registry are honestly marked grandfathered (no preregistered stopping rule). '
      + 'No considerable alpha is currently proven: the only non-negative rows are provisional or still open.',
  });
}

module.exports = { runHypotheses, readCrossCheck, withCrossCheck, CROSSCHECK_FILE };
