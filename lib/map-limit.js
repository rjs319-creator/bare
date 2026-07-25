'use strict';
// Bounded-concurrency map. Runs `fn` over `items` with at most `limit` in flight, preserving
// input order in the result. Extracted from lib/atlasx-routes.js, which now imports it.
// NB lib/cern-run.js keeps its own near-copy on purpose: that one DISCARDS results (fire-and-
// forget over a universe scan) and is not a drop-in for this order-preserving version.
//
// Why bounded rather than a plain Promise.all: callers here fan out to Blob/HTTP, and several
// of them ALREADY fan out internally, so an unbounded outer Promise.all multiplies into
// thousands of simultaneous sockets.
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { mapLimit };
