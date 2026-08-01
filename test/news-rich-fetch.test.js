// fetchCompanyNewsRich must distinguish "both providers failed" (throw — rate-limit or
// outage) from "providers answered: no articles" (return []). The old behavior swallowed
// every non-ok response into [] — so the nightly evidence tick logged 14/14 "noNews"
// while actually being 429'd by the concurrent warm-cron burst, and the Thesis Changes
// tab stayed empty with a diag that pointed at the wrong cause.

// Env BEFORE require — lib/fundamentals reads FINNHUB_API_KEY at module load.
process.env.FINNHUB_API_KEY = 'test-fh';
process.env.FMP_API_KEY = 'test-fmp';

const test = require('node:test');
const assert = require('node:assert');
const { fetchCompanyNewsRich } = require('../lib/fundamentals');
const { classifyNewsSkip } = require('../lib/evidence-routes');

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('throws (not []) when BOTH providers are rate-limited, naming the statuses', async () => {
  global.fetch = async () => resp(429, {});
  await assert.rejects(
    () => fetchCompanyNewsRich('AAPL', '2026-07-01', '2026-07-10', 5),
    /429/,
  );
});

test('falls back to Finnhub rows when FMP is rate-limited', async () => {
  global.fetch = async (url) => String(url).includes('finnhub')
    ? resp(200, [{ headline: 'Beat and raise', summary: 's', datetime: 1753900000, url: 'u', source: 'PR' }])
    : resp(429, {});
  const rows = await fetchCompanyNewsRich('AAPL', '2026-07-01', '2026-07-10', 5);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].title, 'Beat and raise');
  assert.strictEqual(rows[0].publisher, 'PR');
});

test('returns [] (genuine noNews) when providers answer OK with no articles', async () => {
  global.fetch = async () => resp(200, []);
  const rows = await fetchCompanyNewsRich('QUIET', '2026-07-01', '2026-07-10', 5);
  assert.deepStrictEqual(rows, []);
});

test('retries a transient FMP 429 and succeeds without falling back', async () => {
  let fmpCalls = 0;
  global.fetch = async (url) => {
    if (String(url).includes('financialmodelingprep')) {
      fmpCalls++;
      if (fmpCalls === 1) return resp(429, {});
      return resp(200, [{ title: 'T', text: 'x', publishedDate: '2026-07-09', url: 'u', publisher: 'W', symbol: 'AAPL' }]);
    }
    throw new Error('should not reach Finnhub');
  };
  const rows = await fetchCompanyNewsRich('AAPL', '2026-07-01', '2026-07-10', 5);
  assert.strictEqual(rows.length, 1);
  assert.ok(fmpCalls >= 2, 'must have retried the 429');
});

test('classifyNewsSkip: provider-failure errors count as rateLimited, not noNews', () => {
  assert.strictEqual(classifyNewsSkip(null), 'noNews');
  assert.strictEqual(classifyNewsSkip('news providers unavailable (fmp:429 finnhub:429)'), 'rateLimited');
  assert.strictEqual(classifyNewsSkip('news providers unavailable (fmp:empty finnhub:TimeoutError)'), 'rateLimited');
  assert.strictEqual(classifyNewsSkip('something unexpected exploded'), 'newsErr');
});
