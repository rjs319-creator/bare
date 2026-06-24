// THEME ENGINE — the frontier "find pre-run-up names in LEADING themes" layer.
// Top desks don't just screen single names; they screen the THEME, then buy the
// laggard that hasn't run yet while the theme is already running (the SNDK /
// AI-memory play). This normalizes the app's free-text LLM themes into a canonical
// taxonomy, ranks which themes are HOT (member momentum), and exposes both so the
// Opportunities ranking can give a tailwind to early names in leading themes.

// Canonical themes → keyword regex. First match wins (most specific first).
const THEME_DEFS = [
  ['AI Infrastructure', /\bai\b|artificial intelligence|data ?cent|accelerat|\bgpu\b|inference|\bllm\b|hyperscal|neural/i],
  ['Memory & Storage', /memory|\bnand\b|flash|\bdram\b|\bssd\b|storage|\bhdd\b/i],
  ['Semiconductors', /semiconduct|foundry|\bchip\b|\bfab\b|process node|wafer|lithograph|\beuv\b|silicon/i],
  ['Cybersecurity', /cyber|security|zero.?trust|endpoint|firewall|threat/i],
  ['Crypto & Blockchain', /crypto|bitcoin|ethereum|blockchain|digital asset|stablecoin|web3|mining rig/i],
  ['Cloud & Software', /cloud|\bsaas\b|software|platform|devops|observability|data analytics/i],
  ['Power & Nuclear', /nuclear|uranium|\bgrid\b|electricity|power generation|energy infrastructure|\bsmr\b/i],
  ['EV & Battery', /\bev\b|electric vehicle|battery|lithium|charging|solid.?state/i],
  ['Defense & Space', /defen[cs]e|military|aerospace|\bspace\b|satellite|\bdrone\b|missile/i],
  ['Biotech & Pharma', /biotech|pharma|drug|therapeut|clinical|oncolog|\bgene\b|\bglp-?1\b|obesity/i],
  ['Fintech & Payments', /fintech|payment|neobank|lending|buy ?now|\bbnpl\b/i],
  ['Robotics & Automation', /robot|automation|autonom/i],
  ['Quantum', /quantum/i],
  ['Materials & Mining', /mining|copper|\bgold\b|rare earth|\bmetals?\b|materials/i],
  ['Industrials', /industrial|infrastructure|manufactur|machinery|construction/i],
  ['Healthcare', /health|medic|\bcare\b|hospital|medical device|managed care/i],
  ['Financials', /financ|\bbank\b|insurance|asset manage|brokerage|exchange/i],
  ['Consumer', /consumer|retail|\bbrand\b|apparel|restaurant|e-?commerce/i],
];

// Map a candidate's messy theme/narrative/sector → one canonical theme.
export function canonTheme(themeStr = '', narrative = '', sector = '') {
  const text = `${themeStr || ''} ${narrative || ''} ${sector || ''}`;
  for (const [name, rx] of THEME_DEFS) if (rx.test(text)) return name;
  return sector ? sector.split(/[\/,]/)[0].trim() : 'Other';
}

// Rank themes by HEAT: how hard the theme's members are collectively running
// (median 3- and 6-month momentum), weighted up a touch by membership breadth.
export function rankThemes(candidates) {
  const byTheme = {};
  for (const c of candidates || []) {
    const t = canonTheme(c.theme, c.narrative, c.sector);
    (byTheme[t] = byTheme[t] || []).push(c);
  }
  const median = arr => { const s = arr.filter(x => x != null).slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  return Object.entries(byTheme).map(([theme, mem]) => {
    const m63 = median(mem.map(c => c.factors?.mom63));
    const m126 = median(mem.map(c => c.factors?.mom126));
    const breadth = Math.min(mem.length / 5, 1);                      // a theme with more confirming names is sturdier
    const heat = +(0.55 * m63 + 0.35 * m126 + breadth * 12).toFixed(1);
    return { theme, n: mem.length, mom63: +m63.toFixed(1), mom126: +m126.toFixed(1), heat };
  }).sort((a, b) => b.heat - a.heat);
}

// The set of "leading" themes worth a tailwind: top by heat, with at least a
// little breadth (≥2 members) and genuinely hot (positive medium-term momentum).
export function leadingThemeSet(ranked, topN = 4) {
  const lead = ranked.filter(t => t.n >= 2 && t.mom63 > 8).slice(0, topN);
  return { set: new Set(lead.map(t => t.theme)), list: lead };
}
