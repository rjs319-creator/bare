'use strict';
// promptfoo `javascript` assertion shim: the provider already ran the family's pure assertions
// (assertions.js via families.js), so this just unpacks the verdict. Keeping the logic in one
// place means promptfoo and `run.js` can never disagree about what "pass" means.
module.exports = (output) => {
  let r;
  try { r = JSON.parse(output); } catch { return { pass: false, score: 0, reason: 'provider output was not JSON' }; }
  if (r.outcome !== 'ok') return { pass: false, score: 0, reason: `${r.outcome}: ${r.error || r.category || ''}` };
  const reasons = [...(r.shapeViolations || []), ...(r.assertions || [])];
  if (r.rubric && r.rubric.score !== 1) reasons.push(`rubric ${r.rubric.choice}: ${r.rubric.rationale || ''}`);
  return { pass: !!r.pass, score: r.pass ? 1 : 0, reason: reasons.join(' | ') || 'all assertions passed' };
};
