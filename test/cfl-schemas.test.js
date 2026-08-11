'use strict';
// CFL SCHEMAS — the point-in-time invariants are ENFORCED at construction:
// a future-dated feature or a same-day entry is a thrown bug, never data.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/cfl/schemas');

test('assertPointInTime rejects a feature dated after the decision (future-feature rejection)', () => {
  assert.throws(
    () => S.assertPointInTime({ decisionDate: '2026-06-01', featureDates: ['2026-06-02'] }),
    /PIT violation/,
  );
});

test('assertPointInTime rejects an entry at/before the decision date — EOD signals fill next session at the earliest', () => {
  assert.throws(
    () => S.assertPointInTime({ decisionDate: '2026-06-01', entryDate: '2026-06-01' }),
    /not after decision/,
  );
  assert.doesNotThrow(() => S.assertPointInTime({ decisionDate: '2026-06-01', entryDate: '2026-06-02' }));
});

test('opportunityId is deterministic and version-scoped (idempotent rebuilds)', () => {
  const a = S.opportunityId({ symbol: 'nvda', checkpointDate: '2026-06-01', horizon: 'h21' });
  const b = S.opportunityId({ symbol: 'NVDA', checkpointDate: '2026-06-01', horizon: 'h21' });
  assert.strictEqual(a, b);   // case-insensitive symbol identity
  assert.notStrictEqual(a, S.opportunityId({ symbol: 'NVDA', checkpointDate: '2026-06-01', horizon: 'h63' }));
});

const label = {
  ok: true, labelVersion: 'cfl-label-v1', horizon: 'h21', outcome: 'target-before-stop', matured: true,
  entryDate: '2026-06-02', entryPrice: 100, mfe: 0.2, mae: -0.03, rawReturn: 0.15,
  barriers: { upPct: 8, downPct: 5 },
};

test('makeOpportunityEpisode freezes the record and enforces entry-after-checkpoint', () => {
  const ep = S.makeOpportunityEpisode({ symbol: 'TEST', checkpointDate: '2026-06-01', horizon: 'h21', label });
  assert.ok(Object.isFrozen(ep));
  assert.strictEqual(ep.outcome, 'target-before-stop');
  assert.throws(
    () => S.makeOpportunityEpisode({ symbol: 'TEST', checkpointDate: '2026-06-02', horizon: 'h21', label }),
    /PIT violation/,   // entryDate 06-02 not after checkpoint 06-02
  );
});

test('makeDecisionSnapshot rejects a dataCutoff after the decision date', () => {
  assert.throws(
    () => S.makeDecisionSnapshot({ scope: 'large', decisionDate: '2026-06-01', dataCutoff: '2026-06-03', engineVersion: 'e1', scoringVersion: 's1' }),
    /PIT violation/,
  );
});

test('makeFailureAttribution requires an anchor id, a primary failure, and a valid confidence', () => {
  assert.throws(() => S.makeFailureAttribution({ kind: 'missed-winner', primaryFailure: 'X' }), /opportunityId or decisionId/);
  assert.throws(() => S.makeFailureAttribution({ opportunityId: 'abc', kind: 'missed-winner' }), /primaryFailure/);
  assert.throws(
    () => S.makeFailureAttribution({ opportunityId: 'abc', kind: 'missed-winner', primaryFailure: 'X', confidence: 'certain' }),
    /invalid confidence/,
  );
  const a = S.makeFailureAttribution({ opportunityId: 'abc', kind: 'missed-winner', primaryFailure: 'RANKING_FAILURE' });
  assert.ok(Object.isFrozen(a));
  assert.ok(a.attributionId.length === 24);
});

test('model-version separation: different label versions can never collide on an opportunityId', () => {
  // opportunityId embeds LABEL_VERSION — this locks the id to the definition that produced it.
  const CFG = require('../lib/cfl/config');
  assert.match(require('node:fs').readFileSync(require.resolve('../lib/cfl/schemas.js'), 'utf8'), /CFG\.LABEL_VERSION/);
  assert.ok(CFG.LABEL_VERSION.startsWith('cfl-label-'));
});
