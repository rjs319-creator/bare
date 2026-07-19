'use strict';
// NOVEL SIGNAL LAB — shadow API route (op=nsl).
//
// Read-only, shadow-only surface over the Novel Signal Lab. It NEVER writes to any production
// ledger and NEVER affects live recommendations. A global kill-switch (env NSL_DISABLED=true)
// turns the whole lab off in one place, satisfying "every new module can be disabled
// independently". Views:
//   op=nsl                         → lab status (engine/provider availability)  [default]
//   op=nsl&view=status             → same
//   op=nsl&view=registry           → signal registry
//   op=nsl&view=evidence&ticker=X  → per-ticker Novel Evidence panel (live SEC/FINRA reads)
//                                    optional &asOf=YYYY-MM-DD (default = today, server clock)
// The evidence view is the only one that touches the network; it is bounded to one ticker.

const { labStatus, composeNovelEvidence } = require('./nsl/lab');
const { SIGNAL_REGISTRY } = require('./nsl/registry');

function disabled() { return String(process.env.NSL_DISABLED || '').toLowerCase() === 'true'; }
const isTicker = (t) => typeof t === 'string' && /^[A-Z.\-]{1,10}$/.test(t);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

async function runNsl(req, res) {
  if (disabled()) return json(res, 200, { version: 'nsl-v1', disabled: true, note: 'Novel Signal Lab disabled via NSL_DISABLED' });
  const view = (req.query.view || 'status').toLowerCase();
  try {
    if (view === 'registry') return json(res, 200, { version: 'nsl-v1', shadowOnly: true, registry: SIGNAL_REGISTRY });
    if (view === 'status') return json(res, 200, labStatus());
    if (view === 'evidence') {
      const ticker = (req.query.ticker || '').toUpperCase().trim();
      if (!isTicker(ticker)) return json(res, 400, { error: 'valid &ticker=SYMBOL required' });
      const asOf = isDate(req.query.asOf) ? req.query.asOf : new Date().toISOString().slice(0, 10);
      const sharesOut = req.query.sharesOut ? Number(req.query.sharesOut) : null;
      const evidence = await composeNovelEvidence(ticker, { asOf, sharesOut: Number.isFinite(sharesOut) ? sharesOut : null });
      return json(res, 200, evidence);
    }
    return json(res, 400, { error: `unknown view '${view}'`, views: ['status', 'registry', 'evidence'] });
  } catch (e) {
    return json(res, 500, { error: 'nsl failed', detail: e && e.message });
  }
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store'); // shadow research surface — never cache
  res.end(JSON.stringify(body));
}

module.exports = { runNsl };
