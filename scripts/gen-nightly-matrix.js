#!/usr/bin/env node
'use strict';
// Generate the job matrices of .github/workflows/nightly-chains.yml from lib/warm-chains.js
// ROOT_CHAINS, so the workflow can never drift from the module that defines the chains.
//
//   node scripts/gen-nightly-matrix.js          # rewrite the generated blocks in place
//   node scripts/gen-nightly-matrix.js --check  # exit 1 if the workflow is out of date (CI/test)
//
// Two matrices: `spine` (the decision spine, ROOT_CHAINS[0] = ledger — it writes the day's
// picks + decision snapshot the rest read) and `chains` (every other root, `needs: spine`).
// Their union, in order, must equal ROOT_CHAINS — pinned by test/nightly-chains-matrix.test.js.
// Nested chains (@decision, @universescan1, ...) are NOT roots and never appear here: their
// parent awaits them inside its own invocation, exactly as under api/warm.js.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT_CHAINS } = require('../lib/warm-chains');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'nightly-chains.yml');
const SPINE_COUNT = 1;

function splitRoots(roots = ROOT_CHAINS) {
  return { spine: roots.slice(0, SPINE_COUNT), chains: roots.slice(SPINE_COUNT) };
}

const beginMarker = (name) => `# BEGIN GENERATED matrix:${name} (scripts/gen-nightly-matrix.js — do not edit by hand)`;
const endMarker = (name) => `# END GENERATED matrix:${name}`;

function renderMatrix(name, list, indent) {
  const pad = ' '.repeat(indent);
  return [`${pad}${beginMarker(name)}`, `${pad}chain: [${list.join(', ')}]`, `${pad}${endMarker(name)}`].join('\n');
}

// Replace one generated block, keeping the indentation the file already uses for it.
function applyGenerated(yaml, name, list) {
  const b = yaml.indexOf(beginMarker(name));
  const e = yaml.indexOf(endMarker(name));
  if (b < 0 || e < 0 || e < b) throw new Error(`workflow is missing the generated block "${name}"`);
  const lineStart = yaml.lastIndexOf('\n', b) + 1;
  const indent = b - lineStart;
  const blockEnd = e + endMarker(name).length;
  return yaml.slice(0, lineStart) + renderMatrix(name, list, indent) + yaml.slice(blockEnd);
}

// Read a generated block's chain list back out of the YAML (what the pin test compares).
function extractMatrix(yaml, name) {
  const b = yaml.indexOf(beginMarker(name));
  const e = yaml.indexOf(endMarker(name));
  if (b < 0 || e < 0 || e < b) return null;
  const m = yaml.slice(b, e).match(/chain:\s*\[([^\]]*)\]/);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
}

function render(yaml, roots = ROOT_CHAINS) {
  const { spine, chains } = splitRoots(roots);
  return applyGenerated(applyGenerated(yaml, 'spine', spine), 'chains', chains);
}

function main(argv = process.argv) {
  const check = argv.includes('--check');
  const current = fs.readFileSync(WORKFLOW, 'utf8');
  const next = render(current);
  if (next === current) { process.stdout.write(`nightly-chains.yml matrix is current (${ROOT_CHAINS.length} roots)\n`); return 0; }
  if (check) { process.stderr.write('nightly-chains.yml matrix is OUT OF DATE — run: node scripts/gen-nightly-matrix.js\n'); return 1; }
  fs.writeFileSync(WORKFLOW, next);
  process.stdout.write(`nightly-chains.yml matrix rewritten (${ROOT_CHAINS.length} roots)\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { WORKFLOW, SPINE_COUNT, splitRoots, renderMatrix, applyGenerated, extractMatrix, render, main };
