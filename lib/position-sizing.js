'use strict';
// POSITION-SIZING REFERENCE CALCULATOR. A calculator, nothing more.
//
// It does not place orders, it does not connect to a broker, and it has no ability to do so.
// It answers one arithmetic question — "given this account, this risk tolerance and this
// structural stop, how many shares is that?" — and then applies capacity caps that matter
// enormously in low-float names, where a position that looks tiny against your account can be
// large against the day's actual liquidity.
//
// THE RULE THAT IS NEVER BROKEN: the stop is an input, never an output. If the risk budget
// cannot support the structural stop, the answer is FEWER SHARES — or none. Tightening the
// stop to fit the budget converts a defined-risk trade into a coin flip with a smaller number
// on it, which is how position sizing usually goes wrong.

const { SIZING, FLOAT_TIERS } = require('./lowfloat-config');

const finite = v => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function defaultSettings() {
  return {
    accountSize: SIZING.DEFAULT_ACCOUNT_SIZE,
    maxRiskPerTradePct: SIZING.DEFAULT_MAX_RISK_PER_TRADE_PCT,
    maxPositionPct: SIZING.DEFAULT_MAX_POSITION_PCT,
    maxPortfolioOpenRiskPct: SIZING.DEFAULT_MAX_PORTFOLIO_OPEN_RISK_PCT,
    maxTradeValue: null,
    maxShares: null,
  };
}

// Liquidity capacity: the share count the CURRENT session's dollar volume can absorb without
// the trade being a meaningful fraction of the tape. Low-float names get a cap five times
// tighter, because in those the participation IS the move — a large order does not fill into
// existing liquidity, it creates the print.
function liquidityCapacity({ sessionDollarVolume, price, floatTier }) {
  if (!finite(sessionDollarVolume) || !finite(price) || price <= 0) {
    return { shares: null, note: 'current-session dollar volume unknown — no capacity cap could be computed, so size conservatively by hand' };
  }
  const lowFloat = ['ULTRA_LOW', 'LOW'].includes(floatTier);
  const share = lowFloat ? SIZING.LOW_FLOAT_MAX_SHARE_OF_SESSION_DOLLAR_VOL : SIZING.MAX_SHARE_OF_SESSION_DOLLAR_VOL;
  const notional = sessionDollarVolume * share;
  return {
    shares: Math.floor(notional / price),
    notional: Math.round(notional),
    sharePctOfSessionVolume: +(share * 100).toFixed(3),
    lowFloatCapApplied: lowFloat,
    note: lowFloat
      ? `Low-float capacity cap: at most ${(share * 100).toFixed(2)}% of today's traded dollars.`
      : `Capacity cap: at most ${(share * 100).toFixed(2)}% of today's traded dollars.`,
  };
}

// Merge caller settings over the defaults, IGNORING null/undefined values. A plain spread
// would let an absent setting (an omitted query parameter arriving as null) overwrite a real
// default with null — and `accountSize * (null / 100)` is 0, which silently reports "no
// viable size" for a perfectly sizeable trade. Absent means "use the default", never "zero".
function mergeSettings(settings = {}) {
  const out = defaultSettings();
  for (const [k, v] of Object.entries(settings)) {
    if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) out[k] = v;
  }
  return out;
}

// The calculation. Returns the size plus EVERY cap that was considered and which one bound,
// so the number is explainable rather than magic.
function calculatePositionSize({
  entryPrice, invalidation, settings = {}, sessionDollarVolume = null, floatTier = null,
  openRiskPct = 0,
} = {}) {
  const s = mergeSettings(settings);
  const warnings = [];

  if (!finite(entryPrice) || entryPrice <= 0) {
    return { shares: 0, error: 'entry price unavailable', warnings: ['NO_ENTRY_PRICE'], settings: s };
  }
  if (!finite(invalidation) || invalidation <= 0) {
    return { shares: 0, error: 'no structural invalidation level', warnings: ['NO_INVALIDATION'], settings: s };
  }
  const riskPerShare = entryPrice - invalidation;
  if (!(riskPerShare > 0)) {
    return { shares: 0, error: 'invalidation is at or above the entry price', warnings: ['INVALID_STOP'], settings: s };
  }

  const riskBudget = s.accountSize * (s.maxRiskPerTradePct / 100);
  const byRisk = Math.floor(riskBudget / riskPerShare);

  const caps = [];
  caps.push({ name: 'RISK_BUDGET', shares: byRisk, detail: `$${riskBudget.toFixed(2)} risk ÷ $${riskPerShare.toFixed(4)} per share` });

  const byPosition = Math.floor((s.accountSize * (s.maxPositionPct / 100)) / entryPrice);
  caps.push({ name: 'MAX_POSITION_PCT', shares: byPosition, detail: `${s.maxPositionPct}% of account` });

  if (finite(s.maxTradeValue) && s.maxTradeValue > 0) {
    caps.push({ name: 'MAX_TRADE_VALUE', shares: Math.floor(s.maxTradeValue / entryPrice), detail: `$${s.maxTradeValue} notional cap` });
  }
  if (finite(s.maxShares) && s.maxShares > 0) {
    caps.push({ name: 'MAX_SHARES', shares: Math.floor(s.maxShares), detail: 'explicit share cap' });
  }

  const cap = liquidityCapacity({ sessionDollarVolume, price: entryPrice, floatTier });
  if (finite(cap.shares)) caps.push({ name: 'LIQUIDITY_CAPACITY', shares: cap.shares, detail: cap.note });
  else warnings.push('LIQUIDITY_CAPACITY_UNKNOWN');

  // Portfolio-level open risk: if this trade would push total open risk past the ceiling, the
  // size is scaled down to fit — never the stop.
  const remainingPortfolioRiskPct = Math.max(0, s.maxPortfolioOpenRiskPct - (openRiskPct || 0));
  if (remainingPortfolioRiskPct <= 0) {
    warnings.push('PORTFOLIO_OPEN_RISK_EXHAUSTED');
    caps.push({ name: 'PORTFOLIO_OPEN_RISK', shares: 0, detail: `open risk ${openRiskPct}% already at the ${s.maxPortfolioOpenRiskPct}% ceiling` });
  } else if (remainingPortfolioRiskPct < s.maxRiskPerTradePct) {
    const scaled = Math.floor((s.accountSize * (remainingPortfolioRiskPct / 100)) / riskPerShare);
    caps.push({ name: 'PORTFOLIO_OPEN_RISK', shares: scaled, detail: `only ${remainingPortfolioRiskPct.toFixed(2)}% portfolio risk remains` });
  }

  const binding = caps.reduce((m, c) => (c.shares < m.shares ? c : m), caps[0]);
  const shares = Math.max(0, binding.shares);

  if (finite(cap.shares) && byRisk > cap.shares) warnings.push('LIQUIDITY_CAPACITY_BINDS');
  if (['ULTRA_LOW', 'LOW'].includes(floatTier)) warnings.push('LOW_FLOAT_SIZE_CONSERVATIVELY');
  if (shares === 0) warnings.push('NO_VIABLE_SIZE');

  const notional = +(shares * entryPrice).toFixed(2);
  const dollarRisk = +(shares * riskPerShare).toFixed(2);

  return {
    shares,
    notional,
    dollarRisk,
    riskPerShare: +riskPerShare.toFixed(4),
    stopDistancePct: +((riskPerShare / entryPrice) * 100).toFixed(2),
    riskBudget: +riskBudget.toFixed(2),
    actualRiskPctOfAccount: s.accountSize > 0 ? +((dollarRisk / s.accountSize) * 100).toFixed(3) : null,
    positionPctOfAccount: s.accountSize > 0 ? +((notional / s.accountSize) * 100).toFixed(2) : null,
    caps,
    bindingCap: binding.name,
    liquidityCapacity: cap,
    warnings,
    settings: s,
    disclaimers: [
      'Reference arithmetic only. This app does not place orders and has no broker connection.',
      'The stop is an INPUT. If the risk budget cannot support the structural stop, take fewer shares — never move the stop to fit the size.',
      'Capacity caps are estimates from session dollar volume, not from order-book depth, which this app cannot see.',
    ],
  };
}

module.exports = { defaultSettings, mergeSettings, liquidityCapacity, calculatePositionSize, SIZING, FLOAT_TIERS };
