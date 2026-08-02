'use strict';
// PEER PROPAGATION routes + UI-contract tests. The invariants that matter:
//   1. permuteGroups (the random-peers falsification control) is DETERMINISTIC,
//      preserves group sizes, and actually scrambles membership — a control that
//      quietly returns the real groups would fake a passed falsification.
//   2. The Lab panel is wired end-to-end at the SOURCE level (browser code has
//      no test runner): peer-lab.js exports loadPeerLab, app.js imports it,
//      registers the peerlab tab, and index.html carries the section — the same
//      keep-in-sync guard style as test/research-lab-ui.test.js.
//   3. tracker.js gates the new ops correctly: log ops privileged, heavy ops
//      rate-limited — a new engine must never ship an ungated write.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { permuteGroups } = require('../lib/peerprop-routes');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('permuteGroups: deterministic, size-preserving, membership-scrambling', () => {
  const groups = {
    'Tech|large': ['A', 'B', 'C', 'D', 'E', 'F'],
    'Energy|large': ['G', 'H', 'I', 'J', 'K', 'L'],
  };
  const p1 = permuteGroups(groups);
  const p2 = permuteGroups(groups);
  assert.equal(JSON.stringify(p1), JSON.stringify(p2), 'must be deterministic (seeded)');
  assert.equal(p1['Tech|large'].length, 6);
  assert.equal(p1['Energy|large'].length, 6);
  const all = [...p1['Tech|large'], ...p1['Energy|large']].sort();
  assert.deepEqual(all, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'], 'same tickers overall');
  const moved = p1['Tech|large'].filter(t => !groups['Tech|large'].includes(t)).length;
  assert.ok(moved >= 2, `permutation must actually cross groups (moved=${moved})`);
});

test('UI contract: peer-lab.js exports loadPeerLab and app.js wires the peerlab tab', () => {
  const lab = read('public/js/peer-lab.js');
  assert.match(lab, /export async function loadPeerLab\(/);
  assert.match(lab, /op=peerprop/);
  assert.match(lab, /cached=1/, 'the panel must only read the CACHED walk-forward, never trigger it');
  const app = read('public/js/app.js');
  assert.match(app, /import \{ loadPeerLab \} from '\.\/peer-lab\.js'/);
  assert.match(app, /'peerlab'\]/, 'peerlab must be in TAB_GROUPS.lab');
  assert.match(app, /ensurePeerLab/);
  const html = read('public/index.html');
  assert.match(html, /id="peerlab"/);
  assert.match(html, /id="peerlab-container"/);
});

test('tracker gates: log ops privileged; board/wf/underreaction rate-limited', () => {
  const tracker = read('api/tracker.js');
  const priv = tracker.match(/const PRIVILEGED_OPS = new Set\(\[[\s\S]*?\]\);/)[0];
  assert.match(priv, /'peerproplog'/);
  assert.match(priv, /'underreactionlog'/);
  const exp = tracker.match(/const EXPENSIVE_OPS = new Set\(\[[\s\S]*?\]\);/)[0];
  assert.match(exp, /'peerprop'/);
  assert.match(exp, /'peerpropwf'/);
  assert.match(exp, /'underreaction'/);
});

test('registry + contracts: sections resolve and both engines are shadow', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const { SECTION_TO_ID } = require('../lib/strategy-contracts');
  const peer = STRATEGY_REGISTRY.find(s => s.id === 'peerlab');
  const ur = STRATEGY_REGISTRY.find(s => s.id === 'underreaction');
  assert.equal(peer.maturity, 'shadow');
  assert.equal(ur.maturity, 'shadow');
  assert.equal(SECTION_TO_ID.PeerProp, 'peerlab');
  assert.equal(SECTION_TO_ID.Underreaction, 'underreaction');
});
