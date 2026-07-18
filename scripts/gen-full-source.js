#!/usr/bin/env node
'use strict';
// Regenerate APP-FULL-SOURCE.md — a single-file dump of the app's source for pasting
// into an LLM review. The output is a generated artifact (gitignored); this script is
// the source of truth for it. Run with `npm run gen:source` (or `node scripts/gen-full-source.js`).
//
// Contract (kept stable so the dump stays paste-compatible):
//   • Pinned root files (package.json, vercel.json) first, then paths lexicographically.
//   • Each file in a 6-backtick fenced block (so any inner ``` can't break the block).
//   • Excludes files > 250KB — currently only public/js/app.js (the ~7.4k-line frontend).
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');   // repo root, regardless of cwd
process.chdir(ROOT);

const MAX_BYTES = 250 * 1000;                  // ">250KB"
const PINNED = ['package.json', 'vercel.json'];
const GLOBS = ['api/*.js', 'lib/*.js', 'scripts/*.js', 'test/*.js', 'public/js/*.js', 'public/css/*.css'];
const EXPLICIT = ['public/index.html', 'public/sw.js'];

const LANG = { js: 'javascript', json: 'json', html: 'html', css: 'css' };
const FENCE = '``````';                         // 6 backticks

function tracked(glob) {
  return cp.execSync(`git ls-files ${glob}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
}

// Candidate set → drop oversized/missing → dedupe.
const candidates = new Set([...PINNED, ...EXPLICIT, ...GLOBS.flatMap(tracked)]);
const included = [...candidates].filter(f => fs.existsSync(f) && fs.statSync(f).size <= MAX_BYTES);

// Order: pinned roots first, then everything else lexicographically.
const rest = included.filter(f => !PINNED.includes(f)).sort();
const ordered = [...PINNED.filter(f => included.includes(f)), ...rest];

const bodies = ordered.map(rel => {
  const content = fs.readFileSync(rel, 'utf8');
  const ext = rel.split('.').pop();
  return { rel, content, lang: LANG[ext] || '', lines: content.split('\n').length };
});

const totalLines = bodies.reduce((n, b) => n + b.lines, 0);
const index = ordered.map(p => `- ${p}`).join('\n');
const sections = bodies.map(b => `## ${b.rel}\n\n${FENCE}${b.lang}\n${b.content}\n${FENCE}\n`).join('\n');

const out =
`# market-news-app — Full Source

Generated ${new Date().toISOString()} · ${ordered.length} files · ~${totalLines.toLocaleString('en-US')} lines.
Excludes node_modules, tests-optional, research/, data dumps, and files >250KB.

## File index

${index}

${sections}`;

fs.writeFileSync('APP-FULL-SOURCE.md', out);
console.log(`wrote APP-FULL-SOURCE.md — ${ordered.length} files, ~${totalLines.toLocaleString('en-US')} lines, ${out.length.toLocaleString('en-US')} bytes`);
