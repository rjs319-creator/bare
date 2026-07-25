'use strict';
// The Algo Leaderboard ranks strategies by realized performance. Its failure mode is
// sample size: a strategy with 3 resolved picks that happened to win all 3 will show a
// spectacular average and take the gold medal from a strategy with a real record. That
// is exactly what happened live — CERN|INDEX_ADD_FADE sat at #1 ("beating, +16.85% avg,
// 100% win, n3") while the same engine's 54-pick record was losing money and the app's
// own Evidence grade had it as Disabled. These tests lock the sample-size gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// leaderboard.js is a browser ES module; load it into a CommonJS sandbox by stripping
// the import/export syntax (same trick the app's other frontend-module tests use).
function loadLeaderboard() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/leaderboard.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const factory = new Function('esc', 'fetchJSON', 'HEAVY_TIMEOUT_MS', 'OPTIONAL_TIMEOUT_MS', 'module',
    `${src}\nmodule.exports = { buildBoard, verdict, MIN_RANKED_N };`);
  const mod = { exports: {} };
  factory(x => x, async () => null, 0, 0, mod);
  return mod.exports;
}

// A scoreboard group with a live forward record at the 1-month horizon.
const group = (section, tier, n, avg, winRate) => ({
  section, tier, horizons: { '1m': { n, avg, winRate } },
});

test('buildBoard: a 3-pick perfect record cannot outrank a real track record', () => {
  // Arrange — the live shape of the bug: a tiny flawless CERN tier vs a big honest one.
  const { buildBoard } = loadLeaderboard();
  const groups = [
    group('CERN', 'INDEX_ADD_FADE', 3, 16.85, 100),
    group('momentum', 'StrongSell', 18, 7.37, 55),
  ];

  // Act
  const board = buildBoard(groups, null, null);

  // Assert — the well-evidenced row leads; the 3-pick row is not ranked at all.
  assert.equal(board[0].key, 'momentum|StrongSell');
  assert.equal(board[0].ranked, true);
  assert.equal(board[1].key, 'CERN|INDEX_ADD_FADE');
  assert.equal(board[1].ranked, false);
});

test('verdict: a thin-sample row reads "too few to rank", never "beating"', () => {
  // Arrange
  const { buildBoard, verdict, MIN_RANKED_N } = loadLeaderboard();
  const board = buildBoard([group('CERN', 'INDEX_ADD_FADE', 3, 16.85, 100)], null, null);

  // Act
  const [label, , detail] = verdict(board[0]);

  // Assert
  assert.equal(label, 'building');
  assert.match(detail, /only 3 resolved/);
  assert.match(detail, new RegExp(`needs ${MIN_RANKED_N}`));
});

test('verdict: a row that clears the sample gate is still judged on its numbers', () => {
  // Arrange — 30 resolved, positive, winning often enough for the Wilson floor.
  const { buildBoard, verdict } = loadLeaderboard();
  const board = buildBoard([group('screener', 'Breakout', 30, 3.2, 70)], null, null);

  // Act
  const [label] = verdict(board[0]);

  // Assert
  assert.equal(board[0].ranked, true);
  assert.equal(label, 'beating');
});

test('buildBoard: CERN tiers get plain-English names, not raw section|tier keys', () => {
  // Arrange / Act
  const { buildBoard } = loadLeaderboard();
  const board = buildBoard([group('CERN', 'LOCKUP_EXPIRY', 54, -0.57, 59)], null, null);

  // Assert
  assert.equal(board[0].name, '⚡ CERN · IPO lock-up expiry');
  assert.doesNotMatch(board[0].name, /\|/);
});

test('buildBoard: a big high-volume backtest row still ranks normally', () => {
  // Arrange — confluence strategies come in via the cached-backtest path.
  const { buildBoard } = loadLeaderboard();
  const confAlgos = { 'confluence|ema': { name: 'Confluence · ema', excess: -0.25, beatRate: 48, wilsonLo: 47, n: 48928 } };

  // Act
  const board = buildBoard([], null, confAlgos);

  // Assert
  assert.equal(board[0].ranked, true);
  assert.equal(board[0].n, 48928);
});
