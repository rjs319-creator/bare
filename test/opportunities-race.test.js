'use strict';
// Opportunities — an older response can never overwrite the current scope, a failed reload
// keeps the loaded board behind a strip with Retry (review 2026-10, Prompt 8.6).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
let O;
test.before(async () => { O = await import(pathToFileURL(join(__dirname, '..', 'public', 'js', 'opportunities.js')).href); });

// Minimal container: innerHTML + the handful of DOM calls the loader makes.
function container() {
  const c = { innerHTML: '', inserted: [], listeners: [] };
  c.querySelector = (sel) => {
    if (sel === '.opp-wrap-body, .rot-head') return c.innerHTML.includes('opp-wrap-body') ? {} : null;
    if (sel === '[data-opp-retry]') return c.innerHTML.includes('data-opp-retry') ? { dataset: { scope: 'small', limit: '12' }, addEventListener: (ev, fn) => c.listeners.push(fn) } : null;
    return null;
  };
  c.insertAdjacentHTML = (where, html) => { c.inserted.push(html); c.innerHTML = html + c.innerHTML; };
  return c;
}
const ok = (json) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => json });
const screener = (scope) => ({ ok: true, regime: { riskOn: true }, results: [{ ticker: scope.toUpperCase() + 'AA', score: 70, metrics: {}, sector: 'Tech', theme: 'AI' }] });

test('sequence tokens: the slower, OLDER scope response does not overwrite the newer selection', async () => {
  const resolvers = {};
  globalThis.fetch = (url) => new Promise((resolve) => {
    const m = /scope=(\w+)/.exec(String(url));
    if (m) resolvers[m[1]] = () => resolve(ok(screener(m[1])));
    else resolve(ok({ ok: false }));
  });
  const c = container();
  const first = O.loadOpportunities(c, 'small', 12);
  const second = O.loadOpportunities(c, 'micro', 12);
  resolvers.micro(); await second;
  assert.match(c.innerHTML, /data-scope="micro"/);
  resolvers.small(); await first;
  assert.match(c.innerHTML, /data-scope="micro"/, 'the older small-cap response must not paint over micro');
  assert.ok(!/data-scope="small"/.test(c.innerHTML));
  assert.equal(O.isCurrentLoad(c, 1), false);
  assert.equal(O.isCurrentLoad(c, 2), true);
});

test('a failed reload keeps the loaded board, shows a failure strip and offers Retry; a failed FIRST load offers Retry too', async () => {
  globalThis.fetch = async (url) => (/scope=/.test(String(url)) ? ok(screener('large')) : ok({ ok: false }));
  const c = container();
  await O.loadOpportunities(c, 'large', 12);
  assert.match(c.innerHTML, /data-scope="large"/);
  globalThis.fetch = async (url) => { if (/scope=/.test(String(url))) throw new Error('HTTP 503'); return ok({ ok: false }); };
  await O.loadOpportunities(c, 'small', 12);
  assert.match(c.innerHTML, /opp-load-failed[^>]*>⚠️ Couldn't load small-cap opportunities \(HTTP 503\) — showing the previous selection below\./);
  assert.match(c.innerHTML, /data-scope="large"/, 'the previous board is still on screen');
  assert.match(c.innerHTML, /data-opp-retry/);
  assert.equal(c.listeners.length, 1, 'Retry is wired');
  const fresh = container();
  await O.loadOpportunities(fresh, 'small', 12);
  assert.match(fresh.innerHTML, /Couldn't load small-cap opportunities \(HTTP 503\)\. <button[^>]*data-opp-retry/);
  assert.ok(!/previous selection/.test(fresh.innerHTML));
});
