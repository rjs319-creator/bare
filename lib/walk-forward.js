'use strict';
// CHRONOLOGICAL WALK-FORWARD with PURGING/EMBARGO — pure. Folds are expanding-window: fold k
// trains on all dates strictly before its test block and tests on the next block, with an
// EMBARGO gap of `embargoDays` date-slots between train and test so an overlapping-horizon
// label (a trade opened late on the last train day, resolving into the test day) can't leak
// across the boundary. Date-GROUPED: every episode on the same date stays on one side — you can
// never train and test on the same session. Returns [] when there aren't enough distinct dates,
// so the caller honestly reports "insufficient data" instead of overfitting a handful of days.

function uniqueSortedDates(rows) {
  return [...new Set((rows || []).map(r => r.date))].sort();
}

function purgedWalkForward(dates, { nFolds = 5, embargoDays = 1, minTrainDates = 20 } = {}) {
  const uniq = [...dates];
  // A test date at index i trains on dates[0 .. i-embargo]; require that to be ≥ minTrainDates,
  // so the earliest testable index is minTrainDates + embargoDays.
  const startTest = minTrainDates + embargoDays;
  const testable = uniq.slice(startTest);
  if (!testable.length) return [];
  const blockSize = Math.max(1, Math.ceil(testable.length / nFolds));
  const folds = [];
  for (let f = 0; f < nFolds; f++) {
    const testBlock = testable.slice(f * blockSize, (f + 1) * blockSize);
    if (!testBlock.length) break;
    const testStartIdx = startTest + f * blockSize;
    const trainEndIdx = testStartIdx - embargoDays;                 // purge/embargo gap
    const trainDates = new Set(uniq.slice(0, trainEndIdx));
    if (trainDates.size < minTrainDates) continue;
    folds.push({ trainDates, testDates: new Set(testBlock) });
  }
  return folds;
}

module.exports = { uniqueSortedDates, purgedWalkForward };
