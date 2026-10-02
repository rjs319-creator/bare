'use strict';
// JS STATS CLI — lets research/101-overfit-crosscheck.py obtain the SITE's own numbers
// (lib/research/pbo CSCV-PBO, lib/evolve-dsr PSR/DSR) on the exact matrix it is about to
// recompute with purgedcv, so the agreement delta compares two implementations on one
// input. Reads one JSON request on stdin, writes one JSON response on stdout.
//
//   { "op": "pbo", "matrix": [[...]], "blocks": 8 }
//   { "op": "dsr", "returns": [...], "trials": 4 }
//
// The DSR request mirrors lib/challenger-eval deflatedSharpeOf: analytic Var(SR) floor,
// PSR at benchmark 0, DSR at the expected max of `trials` under the null.

const PBO = require('../../lib/research/pbo');
const DSR = require('../../lib/evolve-dsr');

const MIN_RETURNS = 8;
const VAR_SR_FLOOR = 1e-6;

function dsrOf(returns, trials) {
  const rets = (returns || []).filter(Number.isFinite);
  if (!Number.isFinite(trials) || trials < 1) return { ready: false, reason: 'trial-count-required' };
  if (rets.length < MIN_RETURNS) return { ready: false, reason: `need ≥${MIN_RETURNS} returns` };
  const m = DSR.moments(rets);
  const sr = m.sd > 0 ? m.mean / m.sd : 0;
  const psr = DSR.probabilisticSharpe(sr, m.n, m.skew, m.kurt, 0);
  const varSR = (1 / m.n) * (1 - m.skew * sr + ((m.kurt - 1) / 4) * sr * sr);
  const def = DSR.deflatedSharpe(sr, m.n, m.skew, m.kurt, trials, Math.max(varSR, VAR_SR_FLOOR));
  return { ready: true, sr, psr, dsr: def.dsr, sr0: def.sr0, varSR: Math.max(varSR, VAR_SR_FLOOR), n: m.n, skew: m.skew, kurt: m.kurt };
}

function handle(req) {
  if (!req || typeof req !== 'object') return { error: 'request must be an object' };
  if (req.op === 'pbo') return PBO.pbo(req.matrix, { blocks: req.blocks });
  if (req.op === 'dsr') return dsrOf(req.returns, req.trials);
  return { error: `unknown op ${String(req.op)}` };
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => {
    let req;
    try { req = JSON.parse(buf); } catch (e) { process.stdout.write(JSON.stringify({ error: `bad JSON: ${e.message}` })); process.exit(2); }
    process.stdout.write(JSON.stringify(handle(req)));
  });
}

module.exports = { handle, dsrOf };
