#!/usr/bin/env node
'use strict';
// Capture the deterministic golden projection of buildToday() over the frozen Phase-1
// fixture (test/fixtures/today-sources.js).
//
//   node scripts/capture-today-golden.js baseline   -> test/fixtures/today-golden-baseline.json
//                                                      (the immutable PRE-redesign control —
//                                                       capture once, never regenerate)
//   node scripts/capture-today-golden.js            -> test/fixtures/today-golden.json
//                                                      (the CURRENT expected output; regenerate
//                                                       only on a deliberate, documented change)
//
// The golden test (test/today-golden.test.js) compares live output to today-golden.json;
// the baseline file exists so any drift from the pre-redesign control is diffable forever.

const fs = require('node:fs');
const path = require('node:path');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES, project } = require('../test/fixtures/today-sources');

const which = process.argv[2] === 'baseline' ? 'today-golden-baseline.json' : 'today-golden.json';
const out = path.join(__dirname, '..', 'test', 'fixtures', which);

const payload = buildToday(SOURCES, null, null, null);
const golden = project(payload);
fs.writeFileSync(out, JSON.stringify(golden, null, 2) + '\n');
process.stdout.write(`wrote ${out}: top=${golden.top.length} signals=${golden.counts.signals}\n`);
