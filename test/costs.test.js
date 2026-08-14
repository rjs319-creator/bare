// Tests for the transaction-cost model (cost-v2): round-trip haircut, liquidity
// tiering, short borrow, and net/net-excess conversion. Pure functions, no network.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  COST_MODEL_VERSION, roundTripCostPct, tierForPick, netReturn, netExcess,
  borrowCost, costBreakdown, BORROW_APR_BPS,
} = require('../lib/costs');

test('round-trip cost is charged on both sides and rises with illiquidity', () => {
  // liquid = 2×(3+5)bps = 16bps = 0.16%; small = 2×(15+15) = 0.60%;
  // micro = 2×(40+35) = 1.50%; biotech = 2×(25+25) = 1.00%.
  assert.strictEqual(roundTripCostPct('liquid'), 0.16);
  assert.strictEqual(roundTripCostPct('small'), 0.6);
  assert.strictEqual(roundTripCostPct('micro'), 1.5);
  assert.strictEqual(roundTripCostPct('biotech'), 1.0);
  assert.ok(roundTripCostPct('micro') > roundTripCostPct('small'));
  assert.ok(roundTripCostPct('small') > roundTripCostPct('liquid'));
});

test('unknown tier falls back to the liquid cost', () => {
  assert.strictEqual(roundTripCostPct('nonsense'), roundTripCostPct('liquid'));
  assert.strictEqual(roundTripCostPct(undefined), roundTripCostPct('liquid'));
});

test('tierForPick reads liquidity from the ledger metadata', () => {
  assert.strictEqual(tierForPick({ scope: 'micro' }), 'micro');
  assert.strictEqual(tierForPick({ scope: 'Small' }), 'small'); // case-insensitive
  assert.strictEqual(tierForPick({ section: 'Biotech' }), 'biotech');
  assert.strictEqual(tierForPick({ bench: 'XBI' }), 'biotech');
  assert.strictEqual(tierForPick({ scope: 'large' }), 'liquid');
  assert.strictEqual(tierForPick({}), 'liquid');
  assert.strictEqual(tierForPick(null), 'liquid');
});

test('netReturn subtracts the round-trip cost as a positive drag', () => {
  assert.strictEqual(netReturn(2.0, 'liquid'), 1.84);   // 2.00 − 0.16
  assert.strictEqual(netReturn(2.0, 'micro'), 0.5);     // 2.00 − 1.50
  // Works on shorts too: gross is already sign-flipped upstream, cost still drags.
  assert.strictEqual(netReturn(-1.0, 'liquid'), -1.16); // a loser gets worse
});

test('a thin edge can be flipped negative by costs (the whole point)', () => {
  const grossExcess = 0.8;                 // "beats the market by 0.8%" gross
  assert.ok(netExcess(grossExcess, 'micro') < 0); // 0.8 − 1.5 = −0.7 → net loser
  assert.ok(netExcess(grossExcess, 'liquid') > 0); // survives in liquid names
});

test('null / non-finite returns pass through as null', () => {
  assert.strictEqual(netReturn(null, 'liquid'), null);
  assert.strictEqual(netReturn(undefined, 'liquid'), null);
  assert.strictEqual(netReturn(NaN, 'liquid'), null);
  assert.strictEqual(netExcess(null, 'micro'), null);
});

test('cost model is versioned', () => {
  assert.strictEqual(COST_MODEL_VERSION, 'cost-v3');
});

// ── short borrow (cost-v2) ──────────────────────────────────────────────────
// The gap this closes: cost-v1 charged a short exactly what it charged a long,
// i.e. valued stock-loan fees at zero. The app's fade result is profitable ONLY
// on its short leg in illiquid names — the worst place to assume free borrow.

test('longs are never charged borrow; shorts are', () => {
  assert.strictEqual(borrowCost('micro', 21, 'long').pct, 0);
  assert.ok(borrowCost('micro', 21, 'short').pct > 0);
});

test('borrow scales with holding period and illiquidity', () => {
  const short21 = borrowCost('micro', 21, 'short').pct;
  const short63 = borrowCost('micro', 63, 'short').pct;
  assert.ok(short63 > short21, 'longer hold accrues more borrow');
  assert.ok(borrowCost('micro', 21, 'short').pct > borrowCost('liquid', 21, 'short').pct,
    'micro-cap borrow dwarfs general collateral');
});

test('borrow accrues on calendar days, not just trading sessions', () => {
  // 12%/yr over 21 sessions ≈ 30.4 calendar days ≈ 1.0%. A naive
  // sessions-as-calendar-days model would understate it by ~31%.
  const pct = borrowCost('micro', 21, 'short').pct;
  assert.ok(pct > 0.95 && pct < 1.05, `expected ~1.0%, got ${pct}`);
});

test('a modeled borrow rate is never presented as an observed one', () => {
  const b = borrowCost('micro', 21, 'short');
  assert.strictEqual(b.borrowKnown, false, 'tier priors must not masquerade as broker quotes');
  assert.match(b.basis, /ESTIMATE/);
  assert.strictEqual(b.hardToBorrow, true, 'micro prior clears the HTB threshold');
  assert.strictEqual(borrowCost('liquid', 21, 'short').hardToBorrow, false);
});

test('zero borrow charged is still not a claim that borrow was free', () => {
  // No side / no holding period ⇒ no charge, but the unknown flag persists.
  assert.strictEqual(borrowCost('micro', 0, 'short').pct, 0);
  assert.strictEqual(borrowCost('micro', 0, 'short').borrowKnown, false);
});

test('costBreakdown separates the modeled spread from the guessed borrow', () => {
  const b = costBreakdown('micro', { side: 'short', holdSessions: 21 });
  assert.strictEqual(b.spreadPct, 1.5);
  assert.ok(b.borrowPct > 0);
  assert.strictEqual(b.totalPct, +(b.spreadPct + b.borrowPct).toFixed(3));
  assert.strictEqual(b.borrow.borrowKnown, false);
});

test('THE REGRESSION: existing 2-arg callers keep cost-v1 spread-only behaviour', () => {
  // Every current caller passes (gross, tier). Adding borrow must not silently
  // re-price their history.
  assert.strictEqual(netReturn(2.0, 'micro'), +(2.0 - 1.5).toFixed(2));
  assert.strictEqual(netExcess(0.8, 'liquid'), +(0.8 - 0.16).toFixed(2));
});

test('a short that looks profitable gross can go negative once borrow is charged', () => {
  // The fade result in miniature: +1.2% gross on a micro-cap short over 63
  // sessions survives spread but not spread + borrow.
  const gross = 1.2;
  assert.ok(netReturn(gross, 'micro') < 0 || netReturn(gross, 'micro', { side: 'short', holdSessions: 63 })
    < netReturn(gross, 'micro'), 'borrow must be a strictly additional drag');
  const withBorrow = netReturn(gross, 'micro', { side: 'short', holdSessions: 63 });
  assert.ok(withBorrow < netReturn(gross, 'micro'), 'short pays more than the long-only haircut');
});

test('borrow priors are ordered by liquidity, not arbitrary', () => {
  assert.ok(BORROW_APR_BPS.liquid < BORROW_APR_BPS.small);
  assert.ok(BORROW_APR_BPS.small < BORROW_APR_BPS.biotech);
  assert.ok(BORROW_APR_BPS.biotech < BORROW_APR_BPS.micro);
});

// ── participation impact (cost-v3) ──────────────────────────────────────────
test('impact is charged only when BOTH dollarVol and an explicit notional are declared', () => {
  const { costBreakdown } = require('../lib/costs');
  // Arrange/Act — size-independent call (every pre-existing caller).
  const plain = costBreakdown('small', { side: 'long' });
  // Assert — cost-v2 behavior preserved exactly: no impact term.
  assert.strictEqual(plain.impactPct, 0);
  assert.match(plain.impactBasis, /no order size declared/);
});

test('sqrt participation impact: grows with order size, capped, zero below the floor', () => {
  const { impactBps, IMPACT_CAP_BPS } = require('../lib/costs');
  // Arrange — $10M/day name.
  const adv = 10e6;
  // Assert — tiny order below the 5bps-of-ADV floor is free of impact…
  assert.strictEqual(impactBps(adv, 1000), 0);
  // …a 1%-of-ADV order pays real impact…
  const mid = impactBps(adv, 100e3);
  assert.ok(mid > 0);
  // …monotone in size…
  assert.ok(impactBps(adv, 400e3) > mid);
  // …and capped so an absurd size cannot explode the model.
  assert.strictEqual(impactBps(adv, 100e9), IMPACT_CAP_BPS);
});

test('costBreakdown totalPct includes the impact term when a size is declared', () => {
  const { costBreakdown } = require('../lib/costs');
  const sized = costBreakdown('small', { side: 'long', dollarVol: 10e6, notionalUsd: 100e3 });
  const plain = costBreakdown('small', { side: 'long' });
  assert.ok(sized.impactPct > 0);
  assert.ok(Math.abs(sized.totalPct - (plain.totalPct + sized.impactPct)) < 1e-9);
  assert.match(sized.impactBasis, /MODELED/);
});

// ── section tier defaults (audit 2026-08-14) ────────────────────────────────
// SECTION_TIER_DEFAULT omitted Fade, momentum, DownDay, GapDown, Ignition and OMEGA, so
// those sections silently defaulted to the CHEAPEST 'liquid' tier (16bps RT) — flattering
// exactly the illiquid/short studies this file's own header warns about.
test('unstamped Fade/momentum/DownDay/GapDown/Ignition/OMEGA picks no longer grade at the cheapest tier', () => {
  // Fade shorts social-darling names; DownDay/GapDown/Ignition are mixed-universe event
  // sleeves; momentum is fed by full-market price/volume discovery (api/momentum.js);
  // the OMEGA section is the OMEGA-SWING ledger whose Stage-1 candidates are the merged
  // op=today signals (Day Trade, Gap&Go, Breakout, Coil, …) — NOT the 62-name
  // liquid-options cohort (that universe belongs to the separate omega-ab lane).
  for (const section of ['Fade', 'momentum', 'DownDay', 'GapDown', 'Ignition', 'OMEGA']) {
    assert.strictEqual(tierForPick({ section }), 'small', `${section} must not grade at the liquid tier`);
  }
  // A stamped scope still always wins.
  assert.strictEqual(tierForPick({ section: 'Fade', scope: 'large' }), 'liquid');
  assert.strictEqual(tierForPick({ section: 'OMEGA', scope: 'micro' }), 'micro');
});

test('every scoreboard section has an EXPLICIT cost-tier decision (a new section cannot silently fall to liquid)', () => {
  const { SECTION_TO_ID } = require('../lib/strategy-contracts');
  const { SECTION_TIER_DEFAULT, TIERS } = require('../lib/costs');
  for (const section of Object.keys(SECTION_TO_ID)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SECTION_TIER_DEFAULT, section),
      `section "${section}" has no explicit tier default — it would silently grade at the cheapest 'liquid' tier`,
    );
    const tier = SECTION_TIER_DEFAULT[section];
    assert.ok(TIERS[tier], `section "${section}" maps to unknown tier "${tier}" (roundTripCostPct would silently fall back to liquid)`);
  }
  // And the explicit defaults must round-trip through tierForPick unchanged.
  for (const [section, tier] of Object.entries(SECTION_TIER_DEFAULT)) {
    assert.strictEqual(tierForPick({ section }), tier, `tierForPick disagrees with the declared default for ${section}`);
  }
});
