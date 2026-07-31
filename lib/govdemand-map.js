'use strict';
// 🏛️ GOV-DEMAND — verified recipient → public-company map (STATIC, no LLM).
//
// USAspending identifies recipients by legal name (e.g. "SIKORSKY AIRCRAFT
// CORPORATION"), not by ticker. Mapping recipient → tradeable public company is
// the single most error-prone step of any government-demand signal, so this map
// is DELIBERATELY curated by hand: every entry names its evidence (a public,
// durable corporate fact — a 10-K subsidiary listing, a completed acquisition),
// and anything not in the map resolves to null. We never let an LLM's parametric
// memory invent a recipient→ticker link (the AI-Alpha-OS rule: a tradeable
// relationship requires verifiable evidence, not model recall).
//
// Effective dating: acquisitions move a recipient from one parent to another
// (Sikorsky was UTC's until 2015-11, Lockheed's after). Each entry carries
// effectiveFrom/effectiveTo so a historical decision date can't use a mapping
// that wasn't true yet. The prospective ledger always maps as-of "today".
//
// Coverage honesty: ~55 large public federal contractors ≠ the federal market.
// Resellers (Carahsoft), PE-owned primes (ManTech, Peraton) and joint-venture
// vehicles are UNMAPPABLE to a ticker and must stay null — a big slice of
// obligations is invisible to this map BY DESIGN, and the docs disclose it.

// Corporate-suffix tokens stripped during normalization (they carry no identity).
const SUFFIX_TOKENS = new Set([
  'CORPORATION', 'CORP', 'INC', 'INCORPORATED', 'LLC', 'LP', 'LLP', 'CO',
  'COMPANY', 'LTD', 'LIMITED', 'PLC', 'SA', 'THE',
]);

// Pattern grammar (see matchesPattern):
//   multi-token  'LOCKHEED MARTIN'  — consecutive-run containment (distinctive)
//   single-token 'ORACLE'           — exact name, or name = pattern + generic
//                                     corporate-arm tokens only ("ORACLE AMERICA")
//   '^TELEDYNE'                     — prefix match: fires whenever the name's
//                                     FIRST token is the brand. Reserved for
//                                     distinctive coined brands that no
//                                     unrelated company plausibly leads with.
const MAP = Object.freeze([
  // ── Defense primes & shipbuilders ─────────────────────────────────────────
  entry('LMT', 'Lockheed Martin', ['LOCKHEED MARTIN'], 'parent', 'Lockheed Martin Corporation — NYSE: LMT'),
  entry('LMT', 'Lockheed Martin', ['SIKORSKY AIRCRAFT'], 'subsidiary', 'Sikorsky acquired by Lockheed Martin (completed 2015-11-06)', '2015-11-06'),
  entry('RTX', 'RTX Corporation', ['^RAYTHEON'], 'parent', 'Raytheon — RTX Corporation segment (Raytheon/UTC merger 2020-04-03)', '2020-04-03'),
  entry('RTX', 'RTX Corporation', ['COLLINS AEROSPACE'], 'subsidiary', 'Collins Aerospace — RTX segment (post 2020-04-03 merger)', '2020-04-03'),
  entry('RTX', 'RTX Corporation', ['PRATT & WHITNEY', 'PRATT AND WHITNEY'], 'subsidiary', 'Pratt & Whitney — RTX segment (post 2020-04-03 merger)', '2020-04-03'),
  entry('NOC', 'Northrop Grumman', ['NORTHROP GRUMMAN'], 'parent', 'Northrop Grumman Corporation — NYSE: NOC'),
  entry('NOC', 'Northrop Grumman', ['SCALED COMPOSITES'], 'subsidiary', 'Scaled Composites — wholly owned Northrop Grumman subsidiary (since 2007)'),
  entry('GD', 'General Dynamics', ['GENERAL DYNAMICS'], 'parent', 'General Dynamics Corporation — NYSE: GD'),
  entry('GD', 'General Dynamics', ['ELECTRIC BOAT'], 'subsidiary', 'Electric Boat — General Dynamics subsidiary (10-K segment)'),
  entry('GD', 'General Dynamics', ['BATH IRON WORKS'], 'subsidiary', 'Bath Iron Works — General Dynamics subsidiary (10-K segment)'),
  entry('GD', 'General Dynamics', ['GULFSTREAM AEROSPACE'], 'subsidiary', 'Gulfstream — General Dynamics subsidiary (10-K segment)'),
  entry('GD', 'General Dynamics', ['CSRA'], 'subsidiary', 'CSRA acquired by General Dynamics / merged into GDIT (completed 2018-04-03)', '2018-04-03'),
  entry('BA', 'Boeing', ['^BOEING'], 'parent', 'The Boeing Company — NYSE: BA'),
  entry('LHX', 'L3Harris', ['L3HARRIS', 'L3 HARRIS', 'HARRIS CORPORATION', 'L3 TECHNOLOGIES'], 'parent', 'L3Harris Technologies — NYSE: LHX (L3/Harris merger 2019-06-29)', '2019-06-29'),
  entry('LHX', 'L3Harris', ['AEROJET ROCKETDYNE'], 'subsidiary', 'Aerojet Rocketdyne acquired by L3Harris (completed 2023-07-28)', '2023-07-28'),
  entry('HII', 'Huntington Ingalls', ['HUNTINGTON INGALLS', 'NEWPORT NEWS SHIPBUILDING', 'INGALLS SHIPBUILDING'], 'parent', 'Huntington Ingalls Industries — NYSE: HII (10-K segments)'),
  entry('BWXT', 'BWX Technologies', ['BWX TECHNOLOGIES', '^BWXT'], 'parent', 'BWX Technologies — NYSE: BWXT (naval nuclear components)'),
  // ── Defense tech / aerospace suppliers ───────────────────────────────────
  entry('LDOS', 'Leidos', ['^LEIDOS'], 'parent', 'Leidos Holdings — NYSE: LDOS'),
  entry('LDOS', 'Leidos', ['DYNETICS'], 'subsidiary', 'Dynetics acquired by Leidos (completed 2020-01-31)', '2020-01-31'),
  entry('BAH', 'Booz Allen Hamilton', ['BOOZ ALLEN HAMILTON'], 'parent', 'Booz Allen Hamilton Holding — NYSE: BAH'),
  entry('CACI', 'CACI International', ['CACI'], 'parent', 'CACI International — NYSE: CACI'),
  entry('SAIC', 'SAIC', ['SCIENCE APPLICATIONS INTERNATIONAL', 'SAIC'], 'parent', 'Science Applications International Corp — Nasdaq: SAIC'),
  entry('PLTR', 'Palantir', ['^PALANTIR'], 'parent', 'Palantir Technologies — Nasdaq: PLTR'),
  entry('KTOS', 'Kratos', ['^KRATOS', 'KRATOS DEFENSE'], 'parent', 'Kratos Defense & Security Solutions — Nasdaq: KTOS'),
  entry('AVAV', 'AeroVironment', ['^AEROVIRONMENT'], 'parent', 'AeroVironment — Nasdaq: AVAV'),
  entry('TXT', 'Textron', ['^TEXTRON', 'BELL TEXTRON', 'BELL HELICOPTER'], 'parent', 'Textron Inc (Bell is a Textron segment) — NYSE: TXT'),
  entry('HON', 'Honeywell', ['^HONEYWELL'], 'parent', 'Honeywell International — Nasdaq: HON'),
  entry('GE', 'GE Aerospace', ['GENERAL ELECTRIC', 'GE AEROSPACE', 'GE AVIATION'], 'parent', 'GE Aerospace — NYSE: GE (defense engines/systems)'),
  entry('TDY', 'Teledyne', ['^TELEDYNE'], 'parent', 'Teledyne Technologies — NYSE: TDY'),
  entry('TDY', 'Teledyne', ['FLIR'], 'subsidiary', 'FLIR Systems acquired by Teledyne (completed 2021-05-14)', '2021-05-14'),
  entry('CW', 'Curtiss-Wright', ['CURTISS WRIGHT'], 'parent', 'Curtiss-Wright Corporation — NYSE: CW'),
  entry('HWM', 'Howmet Aerospace', ['^HOWMET'], 'parent', 'Howmet Aerospace — NYSE: HWM'),
  entry('TDG', 'TransDigm', ['^TRANSDIGM'], 'parent', 'TransDigm Group — NYSE: TDG'),
  entry('OSK', 'Oshkosh', ['^OSHKOSH'], 'parent', 'Oshkosh Corporation (Oshkosh Defense) — NYSE: OSK'),
  entry('RKLB', 'Rocket Lab', ['ROCKET LAB'], 'parent', 'Rocket Lab — Nasdaq: RKLB'),
  entry('LUNR', 'Intuitive Machines', ['INTUITIVE MACHINES'], 'parent', 'Intuitive Machines — Nasdaq: LUNR'),
  entry('RDW', 'Redwire', ['REDWIRE'], 'parent', 'Redwire Corporation — NYSE: RDW'),
  entry('MSI', 'Motorola Solutions', ['MOTOROLA SOLUTIONS'], 'parent', 'Motorola Solutions — NYSE: MSI'),
  entry('VVX', 'V2X', ['V2X', 'VECTRUS'], 'parent', 'V2X Inc (Vectrus/Vertex merger 2022-07-05) — NYSE: VVX', '2022-07-05'),
  entry('AMTM', 'Amentum', ['AMENTUM'], 'parent', 'Amentum Holdings — NYSE: AMTM (public since 2024-09-30)', '2024-09-30'),
  entry('VSEC', 'VSE Corporation', ['VSE CORPORATION'], 'parent', 'VSE Corporation — Nasdaq: VSEC'),
  // ── Federal IT / consulting ──────────────────────────────────────────────
  entry('ACN', 'Accenture', ['ACCENTURE FEDERAL SERVICES', '^ACCENTURE'], 'parent', 'Accenture plc (Accenture Federal Services subsidiary) — NYSE: ACN'),
  entry('IBM', 'IBM', ['INTERNATIONAL BUSINESS MACHINES', 'IBM'], 'parent', 'International Business Machines — NYSE: IBM'),
  entry('DXC', 'DXC Technology', ['DXC TECHNOLOGY', 'DXC'], 'parent', 'DXC Technology — NYSE: DXC'),
  entry('UIS', 'Unisys', ['^UNISYS'], 'parent', 'Unisys Corporation — NYSE: UIS'),
  entry('MMS', 'Maximus', ['^MAXIMUS'], 'parent', 'Maximus Inc — NYSE: MMS'),
  entry('ICFI', 'ICF International', ['ICF INTERNATIONAL', 'ICF INCORPORATED', 'ICF CONSULTING'], 'parent', 'ICF International — Nasdaq: ICFI'),
  entry('GIB', 'CGI', ['CGI FEDERAL'], 'subsidiary', 'CGI Federal — subsidiary of CGI Inc — NYSE: GIB'),
  entry('MSFT', 'Microsoft', ['^MICROSOFT'], 'parent', 'Microsoft Corporation — Nasdaq: MSFT'),
  entry('ORCL', 'Oracle', ['ORACLE', 'ORACLE AMERICA'], 'parent', 'Oracle Corporation — NYSE: ORCL'),
  entry('AMZN', 'Amazon', ['AMAZON WEB SERVICES'], 'subsidiary', 'AWS — Amazon.com subsidiary (10-K segment) — Nasdaq: AMZN'),
  // ── Engineering / construction / environment ─────────────────────────────
  entry('FLR', 'Fluor', ['^FLUOR'], 'parent', 'Fluor Corporation — NYSE: FLR'),
  entry('J', 'Jacobs', ['JACOBS ENGINEERING', 'JACOBS TECHNOLOGY', 'JACOBS GOVERNMENT SERVICES'], 'parent', 'Jacobs Solutions — NYSE: J'),
  entry('KBR', 'KBR', ['KBR'], 'parent', 'KBR Inc — NYSE: KBR'),
  entry('ACM', 'AECOM', ['^AECOM'], 'parent', 'AECOM — NYSE: ACM'),
  entry('PSN', 'Parsons', ['PARSONS CORPORATION', 'PARSONS GOVERNMENT SERVICES', 'PARSONS TECHNICAL SERVICES'], 'parent', 'Parsons Corporation — NYSE: PSN'),
  entry('TTEK', 'Tetra Tech', ['TETRA TECH'], 'parent', 'Tetra Tech — Nasdaq: TTEK'),
  entry('GVA', 'Granite Construction', ['GRANITE CONSTRUCTION'], 'parent', 'Granite Construction — NYSE: GVA'),
  // ── Health / pharma / services ───────────────────────────────────────────
  entry('MCK', 'McKesson', ['^MCKESSON'], 'parent', 'McKesson Corporation (VA pharmaceutical prime vendor) — NYSE: MCK'),
  entry('CAH', 'Cardinal Health', ['CARDINAL HEALTH'], 'parent', 'Cardinal Health — NYSE: CAH'),
  entry('COR', 'Cencora', ['CENCORA', 'AMERISOURCEBERGEN'], 'parent', 'Cencora (fka AmerisourceBergen) — NYSE: COR'),
  entry('HUM', 'Humana', ['^HUMANA'], 'parent', 'Humana Inc (TRICARE East) — NYSE: HUM'),
  entry('CNC', 'Centene', ['^CENTENE', 'HEALTH NET FEDERAL SERVICES'], 'parent', 'Centene (Health Net Federal Services subsidiary since 2016-03-24) — NYSE: CNC', '2016-03-24'),
  entry('UNH', 'UnitedHealth', ['UNITEDHEALTH', 'OPTUMSERVE', 'OPTUM PUBLIC SECTOR'], 'parent', 'UnitedHealth Group (OptumServe federal arm) — NYSE: UNH'),
  entry('PFE', 'Pfizer', ['^PFIZER'], 'parent', 'Pfizer Inc — NYSE: PFE'),
  entry('MRK', 'Merck & Co', ['MERCK SHARP & DOHME', 'MERCK SHARP AND DOHME'], 'parent', 'Merck & Co (US) — NYSE: MRK'),
  entry('MRNA', 'Moderna', ['^MODERNA'], 'parent', 'Moderna Inc — Nasdaq: MRNA'),
  entry('NVAX', 'Novavax', ['^NOVAVAX'], 'parent', 'Novavax Inc — Nasdaq: NVAX'),
  entry('EBS', 'Emergent BioSolutions', ['EMERGENT BIOSOLUTIONS', 'EMERGENT PRODUCT DEVELOPMENT'], 'parent', 'Emergent BioSolutions — NYSE: EBS'),
  entry('SIGA', 'SIGA Technologies', ['SIGA TECHNOLOGIES'], 'parent', 'SIGA Technologies (BARDA smallpox) — Nasdaq: SIGA'),
  entry('BAX', 'Baxter', ['BAXTER HEALTHCARE'], 'parent', 'Baxter International — NYSE: BAX'),
  // ── Other federal-heavy public names ─────────────────────────────────────
  entry('GEO', 'GEO Group', ['GEO GROUP'], 'parent', 'The GEO Group (ICE/BOP facilities) — NYSE: GEO'),
  entry('CXW', 'CoreCivic', ['^CORECIVIC'], 'parent', 'CoreCivic — NYSE: CXW'),
  entry('FDX', 'FedEx', ['FEDERAL EXPRESS', '^FEDEX'], 'parent', 'FedEx Corporation — NYSE: FDX'),
  entry('UPS', 'UPS', ['UNITED PARCEL SERVICE'], 'parent', 'United Parcel Service — NYSE: UPS'),
  entry('VZ', 'Verizon', ['^VERIZON'], 'parent', 'Verizon Communications — NYSE: VZ'),
  entry('T', 'AT&T', ['AT&T'], 'parent', 'AT&T Inc (FirstNet) — NYSE: T'),
]);

function entry(ticker, company, patterns, via, evidence, effectiveFrom = null, effectiveTo = null) {
  // The '^' prefix flag must be peeled BEFORE normalization (normalizeRecipient
  // strips it as punctuation, which silently demoted every prefix pattern to
  // exact-match — caught by the first live dry-run: "RAYTHEON TECHNICAL
  // SERVICES" failed to map).
  const parsed = patterns.map((raw) => {
    const prefix = raw.startsWith('^');
    return Object.freeze({ text: normalizeRecipient(prefix ? raw.slice(1) : raw), prefix });
  });
  return Object.freeze({
    ticker, company, patterns: Object.freeze(parsed),
    via, evidence, verificationStatus: 'verified-static', effectiveFrom, effectiveTo,
  });
}

// Uppercase, strip punctuation except '&' (corporate identity: AT&T), drop
// corporate-suffix tokens, collapse whitespace. '-' becomes a space so
// "CACI, INC.-FEDERAL" and "CURTISS-WRIGHT" tokenize cleanly.
function normalizeRecipient(name) {
  if (!name || typeof name !== 'string') return '';
  const tokens = name.toUpperCase()
    .replace(/[^A-Z0-9&]+/g, ' ')
    .trim().split(/\s+/)
    .filter(t => !SUFFIX_TOKENS.has(t));
  return tokens.join(' ');
}

// True when `pattern`'s tokens appear as a CONSECUTIVE run inside `name`'s tokens.
function tokensContain(nameTokens, patternTokens) {
  if (!patternTokens.length || patternTokens.length > nameTokens.length) return false;
  for (let i = 0; i <= nameTokens.length - patternTokens.length; i++) {
    let hit = true;
    for (let j = 0; j < patternTokens.length; j++) {
      if (nameTokens[i + j] !== patternTokens[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

// Generic corporate-arm tokens that may follow a single-token pattern without
// changing identity ("CACI FEDERAL", "ORACLE AMERICA"). Anything else after a
// single-token pattern is a DIFFERENT company ("ORACLE ELEVATOR") → no match.
const GENERIC_EXPANSIONS = new Set([
  'FEDERAL', 'AMERICA', 'AMERICAS', 'NORTH', 'INTERNATIONAL', 'NATIONAL',
  'TECHNOLOGY', 'TECHNOLOGIES', 'DEFENSE', 'GOVERNMENT', 'SERVICES',
  'SOLUTIONS', 'SYSTEMS', 'GROUP', 'HOLDINGS', 'USA', 'US', 'ENTERPRISE',
]);

// Single-token patterns are high-risk (any unrelated "X Elevator Co" shares
// the token), so they match only when the name IS the pattern or the pattern
// followed exclusively by generic corporate-arm tokens — unless the entry
// declared '^' (distinctive coined brand), where leading-token is enough.
// Multi-token patterns are distinctive enough for consecutive-run containment.
function matchesPattern(nameTokens, patternTokens, prefix = false) {
  if (patternTokens.length > 1) return tokensContain(nameTokens, patternTokens);
  if (nameTokens[0] !== patternTokens[0]) return false;
  if (prefix) return true;
  return nameTokens.slice(1).every(t => GENERIC_EXPANSIONS.has(t));
}

// Map a raw USAspending recipient name to a public company as-of `asOf`
// (YYYY-MM-DD; defaults to "any time" for the prospective path where the map
// is applied at collection time). Returns null when unmapped — the honest
// default; the caller must treat null as UNMAPPABLE, never guess.
function mapRecipient(rawName, asOf = null) {
  const norm = normalizeRecipient(rawName);
  if (!norm) return null;
  const nameTokens = norm.split(' ');
  for (const e of MAP) {
    if (asOf && e.effectiveFrom && asOf < e.effectiveFrom) continue;
    if (asOf && e.effectiveTo && asOf > e.effectiveTo) continue;
    for (const p of e.patterns) {
      if (matchesPattern(nameTokens, p.text.split(' '), p.prefix)) {
        return {
          ticker: e.ticker, company: e.company, via: e.via,
          matchedPattern: p.text, evidence: e.evidence,
          verificationStatus: e.verificationStatus,
          effectiveFrom: e.effectiveFrom, effectiveTo: e.effectiveTo,
        };
      }
    }
  }
  return null;
}

// Distinct parent companies in the map — the collector's scan roster. Query
// text uses the FIRST pattern of the first entry per ticker (the parent's own
// name); recipient_search_text also surfaces subsidiary recipients whose
// parent recipient matches (verified live: "LOCKHEED MARTIN" returns Sikorsky).
function scanRoster() {
  const seen = new Set(); const roster = [];
  for (const e of MAP) {
    if (seen.has(e.ticker) || e.via !== 'parent') continue;
    seen.add(e.ticker);
    roster.push({ ticker: e.ticker, company: e.company, query: e.patterns[0].text });
  }
  return roster;
}

module.exports = { MAP, normalizeRecipient, mapRecipient, scanRoster, tokensContain, matchesPattern };
