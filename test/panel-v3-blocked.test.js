'use strict';
// panel-v3 migration discipline: without the authoritative security master the
// generator writes an explicit BLOCKED artifact with deterministic migration
// commands, and NEVER touches panel-v2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RESEARCH = path.join(__dirname, '..', 'research');
const DATA = path.join(RESEARCH, 'data');
const MASTER = path.join(DATA, 'secmaster-v3.json');
const BLOCKED = path.join(DATA, 'panel-v3.BLOCKED.json');
const PANEL_V3 = path.join(DATA, 'panel-features-v3.json');
const PANEL_V2 = path.join(DATA, 'panel-features.json');

test('15-panel-features-v3 without secmaster-v3: explicit blocked status, migration steps, v2 untouched', (t) => {
  if (fs.existsSync(MASTER)) return t.skip('secmaster-v3 exists locally — blocked path not exercisable');
  const v2Before = fs.existsSync(PANEL_V2) ? fs.statSync(PANEL_V2).mtimeMs : null;
  const out = execFileSync('node', [path.join(RESEARCH, '15-panel-features-v3.js')], { encoding: 'utf8' });
  assert.match(out, /BLOCKED/);
  assert.match(out, /16-secmaster-v3/);
  const blocked = JSON.parse(fs.readFileSync(BLOCKED, 'utf8'));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.panelVersion, 'panel-v3');
  assert.ok(Array.isArray(blocked.migration) && blocked.migration.length >= 2, 'deterministic migration commands');
  assert.equal(fs.existsSync(PANEL_V3), false, 'nothing fabricated');
  if (v2Before != null) assert.equal(fs.statSync(PANEL_V2).mtimeMs, v2Before, 'panel-v2 never overwritten');
});

test('16-secmaster-v3 without inputs: fails closed with its own blocked artifact', (t) => {
  if (process.env.FMP_API_KEY) return t.skip('FMP key in env — blocked path not exercisable');
  const out = execFileSync('node', [path.join(RESEARCH, '16-secmaster-v3.js')], { encoding: 'utf8', env: { ...process.env, FMP_API_KEY: '' } });
  assert.match(out, /BLOCKED/);
  const blocked = JSON.parse(fs.readFileSync(path.join(DATA, 'secmaster-v3.BLOCKED.json'), 'utf8'));
  assert.equal(blocked.status, 'blocked');
  assert.equal(fs.existsSync(MASTER), false, 'no fabricated master');
});
