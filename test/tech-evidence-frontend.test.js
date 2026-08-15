'use strict';
// Prevents: upstream text (SEC filings, job titles, incident names, package names)
// injecting HTML into the page, and empty/error states rendering as if "nothing is
// happening operationally" without a reason.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'tech-evidence-render.js')).href);

const HOSTILE = '<img src=x onerror="alert(1)">&"quote"';

function payload(over = {}) {
  return {
    ok: true,
    generatedAt: '2026-08-11T02:00:00Z',
    disclosure: 'Research evidence, not a trade recommendation.',
    health: { updatedAt: '2026-08-11T02:00:00Z', sources: { npm: { lastSuccessAt: '2026-08-11T02:00:00Z', freshObservations: 5, lastError: HOSTILE } } },
    coverage: { verifiedMappings: 2, verifiedTickers: ['MDB'], candidates: [{ ticker: 'GTLB', source: 'npm', sourceId: HOSTILE, excludeReason: HOSTILE }] },
    signals: {
      cutoffDate: '2026-08-07',
      items: [{
        id: 'sig-1', arm: 'npm', ticker: 'MDB', cutoffDate: '2026-08-07', available: true,
        metricLabel: HOSTILE, windows: { recent: '2026-07-11..2026-08-07' },
        recentGrowth: 0.12, ownExpected: 0.02, surprise: 0.1, z: 2.1, dispersion: 0.03,
        peerMedianSurprise: 0.01, adjustedSurprise: 0.09, quality: 'ok',
        caveats: [HOSTILE], coverage: {}, eligible: true, eligibleReason: 'ok', direction: 'positive',
        mappingId: 'MDB-npm-mongodb', mappingVersion: 2, attention: 61,
      }],
    },
    forward: { observedDates: 1, resolvedDates: 0, eligibleEvents: 1, resolvedEvents: 0 },
    scorecard: {
      arms: [{ arm: 'npm', horizon: 5, state: 'COLLECTING', stateReason: HOSTILE, resolvedEvents: 0, inFamily: true, q: null }],
      family: ['npm:5'], gate: { fdrAlpha: 0.1, minResolvedEvents: 100 },
      disclosure: 'Research evidence, not a trade recommendation.',
    },
    mappingsPublic: [{ mappingId: 'MDB-npm-mongodb', ticker: 'MDB', source: 'npm', product: HOSTILE, ownershipEvidence: HOSTILE, revenueConnection: HOSTILE, monetizationWeight: 'high', verifiedAt: '2026-08-15', sourceUrl: 'https://www.npmjs.com/package/mongodb', version: 2 }],
    ...over,
  };
}

test('hostile upstream strings are escaped everywhere', async () => {
  const R = await load();
  const html = R.renderTechEvidence(payload(), {});
  assert.ok(!html.includes('<img src=x'), 'raw upstream HTML must never reach the DOM');
  assert.ok(html.includes('&lt;img src=x'), 'hostile content is shown escaped, not dropped');
});

test('the disclosure line and honest empty states are always present', async () => {
  const R = await load();
  const html = R.renderTechEvidence(payload(), {});
  assert.match(html, /Research evidence, not a trade recommendation/);
  const empty = R.renderTechEvidence(payload({ signals: { cutoffDate: null, items: [] }, health: { updatedAt: null, sources: {}, note: 'Collection has not run yet — nightly chain populates this.' } }), {});
  assert.match(empty, /Collection has not run yet/);
  assert.match(empty, /coverage state, not evidence of quiet|not because nothing/);
});

test('error and not-configured states carry visible reasons', async () => {
  const R = await load();
  const err = R.renderTechEvidence(null, {}, { error: 'HTTP 500 for /api/tracker' });
  assert.match(err, /could not load/);
  assert.match(err, /not because nothing changed operationally/);
  const notConf = R.renderTechEvidence({ ok: false, state: 'not-configured', reason: 'Blob storage not configured' }, {});
  assert.match(notConf, /Blob storage not configured/);
});

test('signal cards show provenance, timestamps, revenue connection and both why/why-noise', async () => {
  const R = await load();
  const html = R.renderTechEvidence(payload(), {});
  assert.match(html, /cutoff 2026-08-07/);
  assert.match(html, /Why it may matter/);
  assert.match(html, /Why it may be noise/);
  assert.match(html, /data-ticker="MDB"/);
  assert.match(html, /attention 61/);
  assert.match(html, /Not expected return, not conviction/i);
});

test('the scorecard renders states as accessible pills and names the FDR family', async () => {
  const R = await load();
  const html = R.renderTechEvidence(payload(), {});
  assert.match(html, /Research status: collecting/);
  assert.match(html, /Declared family/);
  assert.match(html, /1-session rows are descriptive only/);
});

test('inactive mappings are labeled, candidates show exclusion reasons', async () => {
  const R = await load();
  const p = payload();
  p.mappingsPublic.push({ ...p.mappingsPublic[0], mappingId: 'CFLT-x', ticker: 'CFLT', activeTo: '2026-03-27', inactiveReason: 'deregistered' });
  const html = R.renderTechEvidence(p, {});
  assert.match(html, /inactive since 2026-03-27/);
  assert.match(html, /excluded mapping candidates/);
});
