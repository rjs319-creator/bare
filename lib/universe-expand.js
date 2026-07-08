// FREE universe expansion — source every listed US ticker from the NASDAQ Trader
// symbol directory (keyless, authoritative, daily) and mechanically prune the
// low-yield / untradeable ones (ETFs, test issues, delinquents, warrants/units/
// rights/preferreds/notes, SPACs) BEFORE any price fetch. No paid data feed.
//
// Two files, DIFFERENT column orders:
//   nasdaqlisted: Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot|ETF|NextShares
//   otherlisted:  ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot|Test Issue|NASDAQ Symbol

const NASDAQ_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
const OTHER_LISTED = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

// Financial-status codes that mean deficient/delinquent/bankrupt → skip.
const BAD_FIN = new Set(['D', 'E', 'G', 'H', 'J', 'K', 'Q']);
// Security-name patterns that mark a non-common-stock instrument.
const DROP_NAME = /\b(warrants?|rights?|units?|preferred|debentures?|subordinated|etn|acquisition (corp|inc|compan|holdings|ltd)|blank check)\b/i;
const FUND_NAME = /\b(etf|etv|fund)\b/i;   // closed-end funds / funds named as such
const EXCH_MAP = { N: 'NYSE', A: 'AMEX', P: 'NYSE Arca', Z: 'CBOE BZX', V: 'IEXG' };

function parseListed(text, kind) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i++) {         // skip header row
    const l = lines[i];
    if (l.startsWith('File Creation Time')) continue;  // skip footer
    const p = l.split('|');
    if (kind === 'nasdaq') out.push({ symbol: p[0], name: p[1] || '', testIssue: p[3], finStatus: p[4], etf: p[6], exchange: 'NASDAQ' });
    else out.push({ symbol: p[0], name: p[1] || '', testIssue: p[6], finStatus: '', etf: p[4], exchange: EXCH_MAP[p[2]] || p[2] || 'US' });
  }
  return out;
}

// Return the drop reason for a row, or null to KEEP it. Pure.
function classify(row) {
  const sym = String(row.symbol || '').trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) return 'symbol';        // preferreds/when-issued carry '.', '$', '='
  if (row.testIssue === 'Y') return 'test-issue';
  if (row.etf === 'Y') return 'etf';
  if (BAD_FIN.has(row.finStatus)) return 'delinquent';
  const name = row.name || '';
  if (name.includes('%')) return 'rate-security';        // "5.50% Notes", preferred rates
  if (DROP_NAME.test(name)) return 'non-common';         // warrant/right/unit/pref/SPAC/notes
  if (FUND_NAME.test(name)) return 'fund';
  return null;
}

// Merge + dedupe rows → { kept:[{symbol,name,exchange}], dropped:{reason:count}, total }.
function mechanicalFilter(rows) {
  const kept = [], dropped = {}, seen = new Set();
  for (const r of rows || []) {
    const sym = String(r.symbol || '').trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    const reason = classify(r);
    if (reason) { dropped[reason] = (dropped[reason] || 0) + 1; continue; }
    kept.push({ symbol: sym, name: (r.name || '').trim(), exchange: r.exchange });
  }
  return { kept, dropped, total: seen.size };
}

async function fetchUniverseSources() {
  const opt = { headers: { 'User-Agent': 'Mozilla/5.0 (market-research)' } };
  const [a, b] = await Promise.all([
    fetch(NASDAQ_LISTED, opt).then(r => r.text()),
    fetch(OTHER_LISTED, opt).then(r => r.text()),
  ]);
  return [...parseListed(a, 'nasdaq'), ...parseListed(b, 'other')];
}

module.exports = { parseListed, classify, mechanicalFilter, fetchUniverseSources };
