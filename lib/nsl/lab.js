'use strict';
// NOVEL SIGNAL LAB — orchestrator (nsl-v1).
//
// Composes the shadow-only "Novel Evidence" view for one ticker and reports lab status. This
// NEVER touches production recommendations — it only reads whatever real data each engine can
// lawfully obtain and returns an honest envelope set. Engines whose data is licensed-and-absent
// return UNAVAILABLE (not zero); population-level engines (twin/invariance/representation) are
// surfaced through the status/eval routes, not per-ticker composition.
//
// The lab is DISABLED BY DEFAULT (see nsl-routes): nothing here is wired into any live ranker.

const { SIGNAL_REGISTRY, signalMeta } = require('./registry');
const { resolveSignal, PROVIDERS, providerStatus } = require('./providers');
const shortPressure = require('./short-pressure');
const insider = require('./insider-conviction');
const mechanical = require('./mechanical-flow');
const accounting = require('./accounting-forensics');
const operating = require('./operating-nowcast');
const capital = require('./capital-structure');

// Lab status: which engines are usable / experimental / unavailable right now, and why.
function labStatus() {
  const engines = SIGNAL_REGISTRY.map(meta => {
    const res = resolveSignal(meta);
    let availability;
    if (meta.providers.length === 0) availability = meta.feasible === 'experimental' ? 'experimental' : 'usable'; // pure engines
    else if (res.anyAvailable) availability = 'usable';
    else availability = 'unavailable';
    return {
      engine: meta.engine, key: meta.key, title: meta.title, version: meta.version,
      family: meta.family, feasible: meta.feasible, availability,
      providers: res.providers.map(p => ({ id: p.id, kind: p.kind, available: p.available, note: p.note })),
      signals: meta.signals,
    };
  });
  const providers = Object.keys(PROVIDERS).map(providerStatus);
  return {
    version: 'nsl-v1', shadowOnly: true,
    summary: {
      usable: engines.filter(e => e.availability === 'usable').length,
      experimental: engines.filter(e => e.availability === 'experimental').length,
      unavailable: engines.filter(e => e.availability === 'unavailable').length,
    },
    engines, providers,
  };
}

// Per-ticker Novel Evidence panel. Runs the per-name engines that have any real data path.
// `asOf` is required (no clock in the lab). `sharesOut`/`events` optionally passed through.
async function composeNovelEvidence(ticker, { asOf, securityId = null, sharesOut = null, events = null } = {}) {
  if (!asOf) throw new Error('composeNovelEvidence requires asOf');
  const T = String(ticker).toUpperCase();

  // Run per-name engines in parallel; each returns a standard envelope (usable/unavailable/exp).
  const [shortEnv, insiderEnv, flowEnv, acctEnv] = await Promise.all([
    shortPressure.computeShortPressure(T, { asOf, securityId, sharesOut }).catch(errEnv('short_pressure', 1, T, asOf)),
    insider.computeInsiderConviction(T, { asOf, securityId }).catch(errEnv('insider_conviction', 2, T, asOf)),
    mechanical.computeMechanicalFlow(T, { asOf, securityId, events }).catch(errEnv('mechanical_flow', 3, T, asOf)),
    accounting.computeAccountingForensics(T, { asOf, securityId }).catch(errEnv('accounting_forensics', 6, T, asOf)),
  ]);
  // Licensed-blocked engines report UNAVAILABLE deterministically (no network).
  const nowcastEnv = operating.computeOperatingNowcast(T, { asOf, securityId });
  const capitalEnv = capital.computeCapitalStructure(T, { asOf, securityId });

  const envelopes = [shortEnv, insiderEnv, flowEnv, acctEnv, nowcastEnv, capitalEnv];
  return {
    version: 'nsl-v1', shadowOnly: true, ticker: T, asOf,
    present: envelopes.filter(e => e.status === 'usable').map(e => e.signal),
    unavailable: envelopes.filter(e => e.status === 'unavailable').map(e => ({ signal: e.signal, reason: e.warnings[0] || null, restrictions: e.restrictions })),
    experimental: envelopes.filter(e => e.status === 'experimental').map(e => e.signal),
    conflicts: detectConflicts(envelopes),
    note: 'Shadow evidence only — does NOT affect production recommendations. Directional scores are conditional, not promises.',
    envelopes,
  };
}

// Cross-engine conflict: usable engines whose direction disagrees (e.g. insider buying while
// accounting deteriorates). Surfaced honestly rather than silently averaged away.
function detectConflicts(envelopes) {
  const usable = envelopes.filter(e => e.status === 'usable' && e.direction !== 0);
  const out = [];
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    if (usable[i].direction !== usable[j].direction) out.push({ a: usable[i].signal, b: usable[j].signal, directions: [usable[i].direction, usable[j].direction] });
  }
  return out;
}

const errEnv = (signal, engine, ticker, asOf) => (e) => require('./registry').unavailable(signal, { engine, ticker, asOf, reason: `engine error: ${e && e.message}` });

module.exports = { labStatus, composeNovelEvidence, detectConflicts };
