// Probability of Backtest Overfitting (pbo-v1) — combinatorially symmetric
// cross-validation (CSCV; Bailey, Borwein, López de Prado & Zhu 2014).
//
// The repo cited PBO numbers computed by Python notebooks that the JS stack could
// not reproduce; this is the missing native implementation, so a study's PBO is
// recomputable from the same artifact it ships in.
//
// Input: a dates × variants performance matrix (each cell = that variant's measure
// on that date; rank IC, net return — any higher-is-better scalar). Method: split
// the DATE axis into S contiguous blocks (contiguous, so serial correlation stays
// inside a block); for every ⌈S/2⌉-subset used as in-sample, pick the best variant
// in-sample and find its RELATIVE RANK out-of-sample. PBO = the fraction of
// combinations where the in-sample winner lands in the bottom half out-of-sample —
// i.e., the probability that selecting the backtest winner selected noise.
//
// Pure, deterministic, no I/O. Fails closed: too few dates/variants → null verdict
// with the reason, never a fabricated 0.

const PBO_VERSION = 'pbo-v1';
const MIN_DATES_PER_BLOCK = 2;
const MIN_VARIANTS = 2;

function combinations(n, k) {
  const out = [];
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    out.push(idx.slice());
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

const meanOf = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// matrix: array of rows (one per date), each an array of variant measures.
// opts.blocks: S (even; default 8, shrunk to fit the data).
function pbo(matrix, opts = {}) {
  const rows = (matrix || []).filter(r => Array.isArray(r) && r.every(Number.isFinite));
  const nVariants = rows.length ? rows[0].length : 0;
  if (nVariants < MIN_VARIANTS) return { version: PBO_VERSION, pbo: null, reason: `need ≥${MIN_VARIANTS} variants` };
  if (!rows.every(r => r.length === nVariants)) return { version: PBO_VERSION, pbo: null, reason: 'ragged matrix' };

  let S = opts.blocks || 8;
  if (S % 2) S -= 1;
  while (S > 2 && Math.floor(rows.length / S) < MIN_DATES_PER_BLOCK) S -= 2;
  if (S < 2 || Math.floor(rows.length / S) < MIN_DATES_PER_BLOCK) {
    return { version: PBO_VERSION, pbo: null, reason: `too few dates (${rows.length}) for ${MIN_DATES_PER_BLOCK}/block × 2 blocks` };
  }

  // Contiguous date blocks (serial correlation stays inside a block, not across the split).
  const per = Math.floor(rows.length / S);
  const blocks = Array.from({ length: S }, (_, b) => rows.slice(b * per, b === S - 1 ? rows.length : (b + 1) * per));

  const combos = combinations(S, S / 2);
  let below = 0;
  const logits = [];
  for (const inIdx of combos) {
    const inSet = new Set(inIdx);
    const isRows = inIdx.flatMap(b => blocks[b]);
    const oosRows = blocks.flatMap((blk, b) => (inSet.has(b) ? [] : blk));
    const isMeans = Array.from({ length: nVariants }, (_, v) => meanOf(isRows.map(r => r[v])));
    const oosMeans = Array.from({ length: nVariants }, (_, v) => meanOf(oosRows.map(r => r[v])));
    let best = 0;
    for (let v = 1; v < nVariants; v++) if (isMeans[v] > isMeans[best]) best = v;
    // Relative OOS rank of the IS winner in (0,1): 1 = best OOS, 0 = worst.
    const beaten = oosMeans.filter(m => m < oosMeans[best]).length;
    const omega = (beaten + 0.5) / nVariants;
    if (omega < 0.5) below++;
    logits.push(Math.log(omega / (1 - omega)));
  }

  return {
    version: PBO_VERSION,
    pbo: +(below / combos.length).toFixed(4),
    combinations: combos.length,
    blocks: S,
    dates: rows.length,
    variants: nVariants,
    meanLogit: +(meanOf(logits)).toFixed(4),
    basis: 'CSCV: fraction of IS/OOS splits where the in-sample winner ranks in the bottom half out-of-sample',
  };
}

module.exports = { PBO_VERSION, pbo, combinations };
