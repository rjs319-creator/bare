'use strict';
// MICROSTRUCTURE ADAPTER — provider-neutral order-flow interface with EXPLICIT missingness.
//
// WHY. Minute-ahead microstructure signals (signed aggressor flow, book imbalance, quote
// depletion) require a paid tick/quote feed the core screener must NOT depend on. This
// adapter makes that dependency optional and HONEST: with no provider configured, every
// field is null with `microAvailable: false` — never a fabricated zero that a model would
// read as "flow was flat". The null provider is the only built-in; real providers register
// under a MICROSTRUCTURE_PROVIDER env name when (if) one is ever paid for.
//
// ⚠️ SCOPE GUARD — read before "just adding a signal" here: raw call/put ratios and
// search-volume/attention counts are DELIBERATELY not accepted as primary minute-ahead
// microstructure signals through this interface. Both are popular, both are cheap, and
// neither has passed a separate prospective validation in this system; letting them in
// through the microstructure door would launder unvalidated attention data into the
// model's flow features. They may only enter as their own capture stream with their own
// pre-registered study.
//
// Field list lives in lib/intraday-schema (MICRO_FIELDS registry) so schema and adapter
// can never drift; the fields join DATASET_FEATURES at the next FEATURE_SCHEMA_VERSION
// bump — see the schema module for the compatibility contract.

const { MICROSTRUCTURE_FIELDS } = require('./intraday-schema');

// Built-in null provider: the honest default. `available: false` + empty byTicker means
// downstream feature assembly produces all-null fields (see microstructureFeaturesOf).
const NULL_PROVIDER = Object.freeze({
  name: null,
  async fetchMicrostructure(_tickers) {
    return { provider: null, available: false, byTicker: {} };
  },
});

// Provider registry keyed by process.env.MICROSTRUCTURE_PROVIDER. Intentionally empty
// beyond the null default — a real provider is added here alongside its own tests.
const PROVIDERS = Object.freeze({});

// Unknown or unset provider name falls back to the null provider: fail to MISSING data,
// never to fabricated data and never to a crash in the screener's hot path.
function getProvider(env = process.env) {
  const name = env && env.MICROSTRUCTURE_PROVIDER;
  return (name && PROVIDERS[name]) || NULL_PROVIDER;
}

// Canonical per-ticker feature object: EVERY microstructure field present as an own
// property — null when the provider had nothing (missingness contract, same as the rest
// of the schema). `microAvailable` is true only when at least one field carried a real
// finite value; a provider returning an empty record still reads as unavailable.
function microstructureFeaturesOf(byTicker, ticker) {
  const rec = byTicker && ticker ? byTicker[ticker] : null;
  const out = {};
  let hasAnyRealValue = false;
  for (const k of MICROSTRUCTURE_FIELDS) {
    const v = rec ? rec[k] : null;
    const isReal = v != null && Number.isFinite(v);
    out[k] = isReal ? v : null;
    if (isReal) hasAnyRealValue = true;
  }
  return { ...out, microAvailable: hasAnyRealValue };
}

module.exports = { MICROSTRUCTURE_FIELDS, NULL_PROVIDER, getProvider, microstructureFeaturesOf };
