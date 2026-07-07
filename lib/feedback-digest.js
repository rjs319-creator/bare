// Layer 4 — in-context self-calibration for the 5 novel "predict" screeners.
//
// Turns the resolved calibration (Layer 2 per-class beat-rates + Layer 3 conviction rank-IC,
// already graded in predict/calibration.json) into a compact, factual PERFORMANCE FEEDBACK
// digest that is appended to each screener's AI prompt. The model then sees how its own past
// calls actually resolved (1-week return vs each name's sector ETF) and can self-calibrate.
//
// Only surfaces classes/attributes the calibration has already GRADED (verdict != CALIBRATING),
// so below the sample floor it returns '' — the prompt is unchanged and the model is never fed
// noise. Framed as calibration context, not a rule to game. Reads-only (no heavy compute), so
// it depends only on the store, and a missing/empty cache degrades to no digest.
const { readJSON, hasStore } = require('./store');

const CACHE_KEY = 'predict/calibration.json';

// calib = the parsed predict/calibration.json payload. Pure + synchronous for testability.
function buildFeedbackDigest(section, calib) {
  const sec = calib && calib.sections && calib.sections[section];
  if (!sec) return '';
  const lines = [];

  const classes = sec.classes || {};
  for (const [cls, s] of Object.entries(classes)) {
    if (!s || s.verdict === 'CALIBRATING') continue;   // only classes with enough resolved picks
    const tag = s.verdict === 'PROVEN' ? 'reliable — keep flagging these'
      : s.verdict === 'DUD' ? 'weak — these have NOT beaten their sector, so hold this label to a higher bar'
        : '';
    lines.push(`- Your "${cls}" calls have beaten their sector ${s.beatRate}% of the time over ${s.n} resolved picks${tag ? ` (${tag})` : ''}.`);
  }

  const cv = sec.attributes && sec.attributes.conviction;
  if (cv && cv.verdict && cv.verdict !== 'CALIBRATING' && cv.rankIC != null) {
    const ic = `${cv.rankIC > 0 ? '+' : ''}${cv.rankIC}`;
    if (cv.verdict === 'CALIBRATED')
      lines.push(`- Your ${cv.label} score HAS tracked outcomes (rank-IC ${ic}) — keep scoring conviction honestly; it carries real signal.`);
    else if (cv.verdict === 'INVERTED')
      lines.push(`- Your ${cv.label} score has been INVERTED (rank-IC ${ic}) — your high-${cv.label} calls did WORSE, so be sceptical of your own strong convictions here.`);
    else if (cv.verdict === 'NOISE')
      lines.push(`- Your ${cv.label} score has NOT separated winners from losers (rank-IC ${ic}) — don't inflate ${cv.label}; raise it only when genuinely warranted.`);
  }

  if (!lines.length) return '';
  return `\n\nPERFORMANCE FEEDBACK — how your own past calls on THIS screener actually resolved (1-week return vs each name's sector ETF). Use it as calibration context to sharpen your judgement; it is NOT a rule to game, and you must still classify each name honestly on its own merits:\n${lines.join('\n')}`;
}

// Fetch the cached calibration and build the digest for a screener. '' when unconfigured,
// uncached, or nothing has resolved yet — callers append it, so the prompt is unchanged.
async function getFeedbackDigest(section) {
  if (!hasStore()) return '';
  const calib = await readJSON(CACHE_KEY, null).catch(() => null);
  return calib ? buildFeedbackDigest(section, calib) : '';
}

module.exports = { buildFeedbackDigest, getFeedbackDigest, CACHE_KEY };
