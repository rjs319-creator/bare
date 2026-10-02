'use strict';
// ⌘K PALETTE INDEX — the pure shaping of what Fuse searches (sections + Learn concepts + ticker
// symbols AND company names) and the DOM scrape that supplies tickers/companies from whatever
// cards are on screen. Fuse itself is the vendored public/js/vendor/fuse-7.1.0.min.mjs; one test
// runs real fuzzy queries through it so a vendor bump that changes ranking semantics is caught.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const url = (f) => pathToFileURL(join(ROOT, 'public', 'js', f)).href;
let PI, Fuse;
test.before(async () => { PI = await import(url('palette-index.js')); Fuse = (await import(url('vendor/fuse-7.1.0.min.mjs'))).default; });

const SECTIONS = [
  { id: 'session', label: 'Session Board', group: 'Today' },
  { id: 'today', label: 'Today', group: 'Today' },
  { id: 'rotation', label: 'Sector Rotation', group: 'Markets' },
  { id: 'scoreboard', label: 'Signal Scoreboard', group: 'Evidence' },
];
const LEARN = [
  { key: 'regime', label: 'Market Regime (Risk-On / Risk-Off)', group: 'Reading the market' },
  { key: 'rr', label: 'Reward : Risk (R:R)', group: 'Managing risk' },
];
const TICKERS = [
  { ticker: 'NVDA', company: 'NVIDIA Corporation', sections: ['screener', 'today'] },
  { ticker: 'MDB', company: 'MongoDB, Inc.', sections: ['techcommand'] },
  { ticker: 'XLK', company: '', sections: ['rotation'] },
];

test('buildIndexItems shapes sections, learn concepts and tickers into one typed list, deduped and without empties', () => {
  const items = PI.buildIndexItems({ sections: SECTIONS, learn: LEARN, tickers: [...TICKERS, { ticker: 'NVDA', company: 'Nvidia', sections: ['momentum'] }, { ticker: '', company: 'x' }, null] });
  assert.equal(items.filter((i) => i.type === 'section').length, 4);
  assert.equal(items.filter((i) => i.type === 'learn').length, 2);
  const tk = items.filter((i) => i.type === 'ticker');
  assert.equal(tk.length, 3, 'tickers dedupe on symbol; blanks and nulls are dropped');
  const nvda = tk.find((i) => i.ticker === 'NVDA');
  assert.deepEqual(nvda.sections.sort(), ['momentum', 'screener', 'today'], 'sections union across duplicates');
  assert.equal(nvda.company, 'NVIDIA Corporation · Nvidia', 'distinct company strings are unioned (a setup/sector stand-in on one card must not hide the real name on another)');
  const standIn = PI.buildIndexItems({ tickers: [{ ticker: 'MRNA', company: 'gap-down continuation' }, { ticker: 'MRNA', company: '?' }, { ticker: 'MRNA', company: 'Health Care' }] });
  assert.equal(standIn[0].company, 'gap-down continuation · Health Care', '"?" placeholders are dropped');
  for (const it of items) {
    assert.ok(['section', 'learn', 'ticker'].includes(it.type));
    assert.equal(typeof it.label, 'string');
    assert.ok(it.label.length > 0);
  }
  assert.deepEqual(PI.buildIndexItems({}), []);
});

test('FUSE_OPTIONS searches label, ticker, company, id and group, ignoring position, with a tolerant threshold', () => {
  const keys = PI.FUSE_OPTIONS.keys.map((k) => (typeof k === 'string' ? k : k.name));
  for (const k of ['label', 'ticker', 'company', 'id', 'group']) assert.ok(keys.includes(k), `key ${k}`);
  assert.equal(PI.FUSE_OPTIONS.ignoreLocation, true);
  assert.ok(PI.FUSE_OPTIONS.threshold >= 0.2 && PI.FUSE_OPTIONS.threshold <= 0.45);
  assert.equal(PI.FUSE_OPTIONS.includeScore, true);
});

test('a real Fuse index over the shaped items finds a company by name, a misspelt section and a concept', () => {
  const items = PI.buildIndexItems({ sections: SECTIONS, learn: LEARN, tickers: TICKERS });
  const fuse = new Fuse(items, PI.FUSE_OPTIONS);
  const top = (q) => PI.rankMatches(fuse, q, 5).map((i) => i.type + ':' + (i.ticker || i.id || i.key));
  assert.equal(top('nvidia')[0], 'ticker:NVDA', 'company name → ticker');
  assert.equal(top('mongo')[0], 'ticker:MDB');
  assert.equal(top('sesion board')[0], 'section:session', 'typo-tolerant section match');
  assert.ok(top('regime').includes('learn:regime'));
  assert.ok(top('reward risk').includes('learn:rr'));
  assert.deepEqual(PI.rankMatches(fuse, '', 5), [], 'empty query → nothing (caller shows defaults)');
  assert.deepEqual(PI.rankMatches(null, 'x', 5), [], 'no index → nothing, never a throw');
  // The app's real nav labels are one word ("Session", not "Session Board"): a longer query must
  // still land via the per-word fallback instead of returning nothing.
  const short = new Fuse(PI.buildIndexItems({ sections: [{ id: 'session', label: 'Session', group: 'Today' }, { id: 'today', label: 'Today', group: 'Today' }] }), PI.FUSE_OPTIONS);
  assert.equal(PI.rankMatches(short, 'sesion board', 5)[0].id, 'session');
  assert.deepEqual(PI.rankMatches(short, 'zzzz qqqq', 5), [], 'two nonsense words → still nothing');
});

test('collectTickersFromDom reads ticker + company from the cards the app renders (data-live / data-ticker)', () => {
  // A tiny DOM stand-in: querySelectorAll over a flat list of fake elements.
  const el = (attrs, companyText, sectionId) => {
    const card = { querySelector: (sel) => (companyText != null && /company|-co\b|sb-name|td-co/.test(sel) ? { textContent: companyText } : null) };
    const section = { id: sectionId };
    return {
      getAttribute: (k) => attrs[k] ?? null,
      closest: (sel) => (/section/.test(sel) ? section : card),
    };
  };
  const root = {
    querySelectorAll: () => [
      el({ 'data-live': 'NVDA' }, 'NVIDIA Corp · Technology · NASDAQ', 'screener'),
      el({ 'data-ticker': 'nvda' }, 'NVIDIA Corp', 'session'),
      el({ 'data-ticker': 'MDB' }, null, 'techcommand'),
      el({ 'data-live': 'not a ticker!!' }, 'x', 'screener'),
      el({ 'data-live': '' }, 'x', 'screener'),
    ],
  };
  const out = PI.collectTickersFromDom(root);
  assert.deepEqual(out.map((t) => t.ticker), ['NVDA', 'MDB']);
  assert.equal(out[0].company, 'NVIDIA Corp', 'the " · sector · exchange" tail is stripped');
  assert.deepEqual(out[0].sections.sort(), ['screener', 'session']);
  assert.equal(out[1].company, '');
  assert.deepEqual(PI.collectTickersFromDom(null), []);
});

test('command-palette.js keeps the TICKER_RE fast path first and lazy-loads the vendored Fuse on first open', () => {
  const src = readFileSync(join(ROOT, 'public', 'js', 'command-palette.js'), 'utf8');
  assert.match(src, /const TICKER_RE = /);
  assert.match(src, /if \(TICKER_RE\.test\(raw\.trim\(\)\)\) out\.push\(\.\.\.tickerCommands\(raw\.trim\(\)\)\)/, 'ticker-shaped query → ticker commands first');
  assert.match(src, /import\('\.\/vendor\/fuse-7\.1\.0\.min\.mjs'\)/, 'dynamic import, not a static one (25 KB stays off the critical path)');
  assert.match(src, /from '\.\/palette-index\.js'/);
  assert.ok(!/^import .*fuse/m.test(src), 'no static Fuse import');
});
