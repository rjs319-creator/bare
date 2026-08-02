'use strict';
// op=hypotheses — read-only view of the hypothesis registry + negative-results
// graveyard (lib/research/hypothesis-registry.js). The Research Lab leads with the
// decision and evidence quality: what was tested, under what stopping rule, and what
// happened — including (especially) the failures, so a dead idea is never quietly
// re-run as if new. No secrets, no raw licensed payloads, no writes.

const HR = require('./research/hypothesis-registry');

async function runHypotheses(req, res) {
  const counts = {};
  for (const s of HR.STATUSES) counts[s] = HR.byStatus(s).length;
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.json({
    ok: true,
    version: HR.REGISTRY_VERSION,
    totalTrials: HR.totalTrials(),
    counts,
    graveyardN: HR.graveyard().length,
    sealedHoldouts: HR.HOLDOUTS.length,
    untouchedHoldouts: HR.untouchedHoldouts().length,
    hypotheses: HR.HYPOTHESES,
    note: 'Committed preregistration + graveyard. Statuses summarize the cited evidence artifacts; '
      + 'entries predating this registry are honestly marked grandfathered (no preregistered stopping rule). '
      + 'No considerable alpha is currently proven: the only non-negative rows are provisional or still open.',
  });
}

module.exports = { runHypotheses };
