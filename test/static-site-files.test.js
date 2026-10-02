'use strict';
// Site audit 2026-10-02 #10 — /favicon.ico and /robots.txt returned 404 (Safari and crawlers
// request both regardless of the <link rel="icon"> the page declares). Both are static files
// under public/, served by Vercel without a function.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');

test('favicon.ico is a real ICO container with at least one embedded image', () => {
  const buf = fs.readFileSync(path.join(PUB, 'favicon.ico'));
  // ICONDIR: reserved 0, type 1 (icon), count >= 1.
  assert.equal(buf.readUInt16LE(0), 0);
  assert.equal(buf.readUInt16LE(2), 1);
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 1 && count <= 8, `unexpected icon count ${count}`);
  // Every directory entry must point inside the file.
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(6 + 16 * i + 8);
    const offset = buf.readUInt32LE(6 + 16 * i + 12);
    assert.ok(offset + size <= buf.length, `icon ${i} overruns the file`);
  }
  assert.ok(buf.length < 20_000, 'favicon should stay tiny (it is fetched on every page load)');
});

test('robots.txt allows the UI and the public feed and keeps crawlers off the API', () => {
  const txt = fs.readFileSync(path.join(PUB, 'robots.txt'), 'utf8');
  assert.match(txt, /^User-agent: \*$/m);
  assert.match(txt, /^Disallow: \/api\/$/m);
  assert.match(txt, /^Allow: \/feed\/$/m);
});

test('index.html still declares the SVG icon the app was designed with', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /rel="icon" href="\/icon\.svg"/);
});
