'use strict';
// api/tracker.js's DEFAULT path and UNKNOWN-OP answer.
//
// The op router is a long chain of `if (req.query.op === '…') return …` lines. Until
// 2026-10-02 its last line was an unconditional `return runScoreboard(req, res)`, so a typo'd
// or retired op (`?op=scoreboad`, `?op=foo`) silently got the FULL scoreboard payload —
// ~6.7 MB on the day this was found — instead of an error. The default path itself is a
// contract: public/js/app.js fetchScoreboard() fetches a bare `/api/tracker`, and the module
// header documents `?op=scoreboard` as its alias. Both are kept; everything else is a small
// 400 that is never CDN-cached (an error for a typo must not be served to the next caller).

const DEFAULT_OP = 'scoreboard';
const UNKNOWN_OP_ERROR = 'unknown op';
// Enough to recognise a typo in the response, short enough that the echo can never become a
// payload of its own (query strings are attacker-controlled).
const MAX_ECHOED_OP_LENGTH = 80;

// Only the EXACT no-op / empty / alias forms are the default. `req.query.op` can be an array
// when the key repeats (`?op=a&op=b`) — that is never the default path.
const isDefaultOp = (op) => op == null || op === '' || op === DEFAULT_OP;

const describeOp = (op) => {
  const text = Array.isArray(op) ? op.map(String).join(',') : String(op);
  return text.slice(0, MAX_ECHOED_OP_LENGTH);
};

function respondUnknownOp(req, res) {
  const op = describeOp(req && req.query ? req.query.op : undefined);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(400).json({ ok: false, error: UNKNOWN_OP_ERROR, op });
}

module.exports = { DEFAULT_OP, UNKNOWN_OP_ERROR, MAX_ECHOED_OP_LENGTH, isDefaultOp, respondUnknownOp };
