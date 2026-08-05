'use strict';
// Guards the keyless bulk-quote fallback against the provider's symbol cap.
const { test } = require('node:test');
const assert = require('node:assert');
const qp = require('../lib/quote-provider');

test('spark chunk respects the provider 20-symbol cap', () => {
  // REGRESSION: Yahoo's spark endpoint caps a request at 20 symbols and answers
  //   400 {"error":{"description":"Number of symbols needs to be less than or equal to 20"}}
  // SPARK_CHUNK was 40, so EVERY chunk failed and the keyless fallback silently returned zero
  // rows for any request above 20 names — a full-universe scan looked like a quiet day.
  assert.ok(qp.SPARK_CHUNK <= 20, `spark chunk ${qp.SPARK_CHUNK} exceeds the provider cap of 20`);
  assert.ok(qp.FMP_CHUNK <= 200);
});
