'use strict';
// WIKIMEDIA USER-AGENT POLICY (https://meta.wikimedia.org/wiki/User-Agent_policy): every
// client must send a DESCRIPTIVE User-Agent — tool name, a way to contact its operator — and
// bare browser strings such as `Mozilla/5.0` are throttled or blocked. lib/constituents.js
// (S&P 500/400/600 change tables) sent exactly that bare string to en.wikipedia.org three
// times a night, while research/lib/http-polite.js carried its own separate identity. One
// constant, lib/wikimedia-ua.js, now serves every Wikimedia call site, and this file pins that
// no Wikimedia host is ever fetched with the bare UA again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WUA = require('../lib/wikimedia-ua');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WIKIMEDIA_HOST_RE = /\b(?:[a-z0-9-]+\.)*(?:wikipedia|wikimedia|wikidata)\.org\b/i;
const BARE_UA_RE = /['"`]Mozilla\/5\.0['"`]/;

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => String(body) });
const recordingFetch = (body) => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url: String(url), headers: (opts && opts.headers) || {} }); return okResponse(body); };
  fetchImpl.calls = calls;
  return fetchImpl;
};
const uaOf = (headers) => headers['User-Agent'] || headers['user-agent'];

test('WIKIMEDIA_UA is descriptive: app name, repo URL and a contact, never a bare browser string', () => {
  assert.match(WUA.WIKIMEDIA_UA, /^market-news-app\//);
  assert.match(WUA.WIKIMEDIA_UA, /https:\/\/github\.com\/rjs319-creator\/bare/);
  assert.doesNotMatch(WUA.WIKIMEDIA_UA, /^Mozilla\/5\.0/);
  assert.ok(WUA.WIKIMEDIA_UA.length < 200);
  assert.equal(WUA.WIKIMEDIA_HEADERS['User-Agent'], WUA.WIKIMEDIA_UA);
  assert.ok(Object.isFrozen(WUA.WIKIMEDIA_HEADERS));
});

test('the contact comes from WIKIMEDIA_CONTACT, with the repo issues URL as the safe default', () => {
  assert.match(WUA.wikimediaUserAgent({}), /rjs319-creator\/bare\/issues/);
  assert.match(WUA.wikimediaUserAgent({ WIKIMEDIA_CONTACT: 'ops@example.test' }), /ops@example\.test/);
  assert.doesNotMatch(WUA.wikimediaUserAgent({ WIKIMEDIA_CONTACT: 'ops@example.test' }), /\/issues/);
  // Header-unsafe input is sanitised, never passed through, and blank falls back to the default.
  const ua = WUA.wikimediaUserAgent({ WIKIMEDIA_CONTACT: 'a@b.c\r\nX-Injected: 1' });
  assert.doesNotMatch(ua, /[\r\n]/);
  assert.match(WUA.wikimediaUserAgent({ WIKIMEDIA_CONTACT: '   ' }), /\/issues/);
});

test('isWikimediaUrl recognises every Wikimedia project host and nothing else', () => {
  for (const u of ['https://en.wikipedia.org/wiki/X', 'https://wikimedia.org/api/rest_v1/metrics/pageviews/x', 'https://query.wikidata.org/sparql?query=1', 'https://commons.wikimedia.org/x']) {
    assert.equal(WUA.isWikimediaUrl(u), true, u);
  }
  for (const u of ['https://example.com/wikipedia.org', 'https://notwikipedia.org/x', 'https://query.yahoo.com/v8', 'nonsense', '', null]) {
    assert.equal(WUA.isWikimediaUrl(u), false, String(u));
  }
});

test('lib/constituents.js: all three Wikipedia fetches send WIKIMEDIA_UA', async () => {
  const C = require('../lib/constituents');
  const fetchImpl = recordingFetch('<html></html>');
  await C.fetchRemovedConstituents(3, { fetchImpl });
  await C.fetchRecentIndexChanges(70, { fetchImpl });
  await C.fetchRecentSmidIndexChanges(70, { fetchImpl });
  assert.ok(fetchImpl.calls.length >= 4, `expected the S&P 500 changes page twice plus the 400/600 pages, got ${fetchImpl.calls.length}`);
  for (const c of fetchImpl.calls) {
    assert.ok(WUA.isWikimediaUrl(c.url), c.url);
    assert.equal(uaOf(c.headers), WUA.WIKIMEDIA_UA, `${c.url} must carry the Wikimedia UA`);
  }
});

test('research/lib/http-polite.js: the research identity IS the Wikimedia UA unless overridden', async () => {
  const HP = require('../research/lib/http-polite');
  assert.equal(HP.RESEARCH_UA, process.env.RESEARCH_USER_AGENT || WUA.WIKIMEDIA_UA);
  const fetchImpl = recordingFetch({ items: [] });
  await HP.fetchJSON('https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/X/daily/20150701/20150702', { fetchImpl });
  assert.equal(uaOf(fetchImpl.calls[0].headers), HP.RESEARCH_UA);
  assert.doesNotMatch(uaOf(fetchImpl.calls[0].headers), /^Mozilla\/5\.0$/);
});

test('research/lib wiki-pageviews + wikidata-tickers reach Wikimedia through the shared UA', async () => {
  const PV = require('../research/lib/wiki-pageviews');
  const WD = require('../research/lib/wikidata-tickers');
  const pv = recordingFetch({ items: [] });
  await PV.fetchArticleSeries('Apple_Inc.', { start: '20250101', end: '20250102', fetchImpl: pv });
  const wd = recordingFetch({ results: { bindings: [] } });
  await WD.fetchTickerMap({ fetchImpl: wd });
  for (const c of [...pv.calls, ...wd.calls]) {
    assert.ok(WUA.isWikimediaUrl(c.url), c.url);
    assert.equal(uaOf(c.headers), require('../research/lib/http-polite').RESEARCH_UA, c.url);
  }
});

test('SOURCE PIN: no module that names a Wikimedia host carries a bare Mozilla/5.0 UA, and each uses the shared constant', () => {
  const dirs = ['lib', 'research/lib'];
  const offenders = [];
  const unwired = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js'))) {
      const rel = `${dir}/${f}`;
      const src = read(rel);
      if (!WIKIMEDIA_HOST_RE.test(src)) continue;
      if (BARE_UA_RE.test(src)) offenders.push(rel);
      const wired = /require\(['"][./]*(?:\.\.\/)*(?:lib\/)?wikimedia-ua['"]\)/.test(src) || /require\(['"]\.\/http-polite['"]\)/.test(src) || rel === 'lib/wikimedia-ua.js';
      if (!wired) unwired.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `bare Mozilla/5.0 UA next to a Wikimedia host in: ${offenders.join(', ')}`);
  assert.deepEqual(unwired, [], `Wikimedia caller not using the shared UA: ${unwired.join(', ')}`);
});
