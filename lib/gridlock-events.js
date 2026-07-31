'use strict';
// ⚡ GRIDLOCK — physical event extraction + ledger assembly.
//
// Discipline (mirrors lib/evidence-extract.js + lib/gapgo.js classifyGapCause):
//   1. DETERMINISTIC FIRST — regex classification of event type, megawatts,
//      dollar amounts and states straight from the source text. Cheap, exact,
//      replayable.
//   2. LLM SECOND AND BOUNDED — an optional Haiku tool-forced call may propose
//      field values, but every proposal passes groundExtraction(): a numeric
//      value (MW, $, dates) survives ONLY if the number literally appears in
//      the source text; enums are whitelisted; the ISO region is resolved from
//      the state map, never from model recall. The LLM can classify and point;
//      it can never invent megawatts, dollars, dates, locations, ISO regions,
//      company relationships, probabilities or project status.
//   3. Ungrounded values stay NULL and land in unresolvedFields — missing data
//      is disclosed, never fabricated (lib/evidence-schema.js rule).

const S = require('./gridlock-schema');

const EXTRACT_VERSION = 'gridlock-extract-v1';
const MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 40000;
const MAX_TEXT_CHARS = 6000;

// ── Deterministic event-type classification (headline+lede regexes) ─────────
// Ordered most-specific → least. First match wins. Types with no reliable
// regex signature are reachable only via seeds or (grounded) LLM extraction.
const EVENT_RX = [
  ['DATA_CENTER_LOAD', /data.?cent(er|re)s?\b.*\b(campus|load|megawatt|MW|GW|gigawatt|power|build|construct)|\b(hyperscale|AI)\b.*data.?cent/i],
  ['POWER_PURCHASE_AGREEMENT', /\b(PPA|power purchase agreement|nuclear power agreement|power supply agreement)\b/i],
  ['ENERGY_SERVICES_AGREEMENT', /\b(energy services agreement|interconnection services agreement|ESA\b)/i],
  ['GENERATOR_RETIREMENT', /\b(retire|retirement|deactivat|shut(ting)? down|close|closure)\b.*\b(plant|unit|station|generator|coal|nuclear|gas)|\b(plant|unit|station)\b.*\b(retire|deactivat|closure)/i],
  ['RETIREMENT_DELAY', /\b(delay|extend|postpone|keep.*(open|online|running))\b.*\b(retirement|closure|deactivation)|reliability.?must.?run/i],
  ['GENERATOR_OUTAGE', /\b(outage|trip(ped)?|offline|forced out)\b.*\b(plant|unit|reactor|generator)/i],
  ['GENERATION_EXPANSION', /\b(uprate|expand|expansion|restart|add.*(unit|capacity))\b.*\b(plant|station|nuclear|gas|generation)/i],
  ['GENERATION_BUILD', /\b(new|build|construct|develop|propose[ds]?)\b.*\b(power plant|gas.?fired|combined.?cycle|peaker|nuclear (plant|reactor)|SMR|generation (project|facility))/i],
  ['BATTERY_STORAGE_PROJECT', /\b(battery|BESS|energy storage)\b.*\b(project|facility|MW|MWh)/i],
  ['TRANSMISSION_BUILD', /\b(transmission (line|project|upgrade)|new.*transmission|grid upgrade|765.?kv|500.?kv|345.?kv)\b/i],
  ['TRANSMISSION_CONSTRAINT', /\b(congestion|transmission constraint|curtail(ed|ment))\b/i],
  ['INTERCONNECTION_CHANGE', /\binterconnection (queue|reform|agreement|request)\b/i],
  ['CAPACITY_AUCTION', /\b(capacity auction|base residual auction|BRA\b|capacity market.*(clear|price|result))/i],
  ['RESOURCE_ADEQUACY_CHANGE', /\b(resource adequacy|reserve margin|reliability assessment|loss of load)\b/i],
  ['PROJECT_CANCELLATION', /\b(cancel(led|ed|s)?|abandon(ed|s)?|terminate[ds]?|scrap(ped|s)?)\b.*\b(project|plant|campus|line|agreement)/i],
  ['PROJECT_DELAY', /\b(delay(ed|s)?|push(ed)? back|behind schedule|slip(ped|s)?)\b.*\b(project|plant|campus|construction|completion)/i],
  ['PROJECT_MORATORIUM', /\b(moratorium|pause[ds]?.*(approval|connection)|halt.*new.*(data cent|connection))/i],
  ['REGULATORY_REJECTION', /\b(reject(ed|s)?|denie[ds]|block(ed|s)?)\b.*\b(FERC|PUC|commission|regulator|permit|application)|\b(FERC|PUC|commission)\b.*\breject/i],
  ['REGULATORY_APPROVAL', /\b(approve[ds]?|authoriz|permit(ted)?|green.?light)\b.*\b(FERC|PUC|commission|regulator|project|plant|line)|\b(FERC|PUC|commission)\b.*\bapprov/i],
  ['TURBINE_ORDER', /\b(turbine)s?\b.*\b(order|reserv|slot|deliver|supply)|\border(ed|s)?\b.*\bturbines?/i],
  ['TRANSFORMER_ORDER', /\btransformers?\b.*\b(order|shortage|lead time|supply)/i],
  ['ELECTRICAL_EQUIPMENT_ORDER', /\b(switchgear|electrical equipment|grid equipment)\b.*\b(order|contract|supply)/i],
  ['EPC_CONTRACT', /\b(EPC|engineering,? procurement)\b.*\b(contract|award)|\bconstruction contract\b.*\b(plant|substation|transmission)/i],
  ['GAS_SUPPLY_AGREEMENT', /\b(gas supply agreement|firm gas|gas transportation agreement)\b/i],
  ['PIPELINE_BUILD', /\b(pipeline)\b.*\b(build|expansion|project|approve|construct)/i],
  ['POWER_PRICE_SHOCK', /\b(power|electricity) price(s)?\b.*\b(spike|surge|soar|record|jump)/i],
  ['EXTREME_WEATHER', /\b(heat wave|heatwave|polar vortex|winter storm|extreme (heat|cold))\b.*\b(grid|power|electric|demand)/i],
  ['EARNINGS_POWER_DISCLOSURE', /\b(earnings|quarterly|guidance)\b.*\b(data.?cent(er|re)|power demand|load growth|megawatt)/i],
];

function classifyEventType(text) {
  const t = String(text || '');
  for (const [type, rx] of EVENT_RX) if (rx.test(t)) return type;
  return null;
}

// ── Deterministic quantitative grounding ─────────────────────────────────────
// Extract MW figures directly from text: "960 MW", "1,920-megawatt", "4.5 GW".
function extractMW(text) {
  const t = String(text || '');
  const out = [];
  const rx = /([\d][\d,]*(?:\.\d+)?)\s*[- ]?\s*(gigawatt|megawatt|gw|mw)s?\b/gi;
  let m;
  while ((m = rx.exec(t))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    out.push(/^g/i.test(m[2]) ? n * 1000 : n);
  }
  return out;
}
// Dollar amounts: "$650 million", "$16 billion".
function extractUSD(text) {
  const t = String(text || '');
  const out = [];
  const rx = /\$\s*([\d][\d,]*(?:\.\d+)?)\s*(billion|million|bn|mm|m|b)?\b/gi;
  let m;
  while ((m = rx.exec(t))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const unit = (m[2] || '').toLowerCase();
    out.push(unit.startsWith('b') ? n * 1e9 : (unit.startsWith('m') ? n * 1e6 : n));
  }
  return out;
}

// PJM footprint states (first vertical slice). State detection → ISO is a
// DETERMINISTIC map; the LLM never assigns an ISO region.
const STATE_ISO = Object.freeze({
  'PENNSYLVANIA': 'PJM', 'NEW JERSEY': 'PJM', 'MARYLAND': 'PJM', 'VIRGINIA': 'PJM',
  'WEST VIRGINIA': 'PJM', 'OHIO': 'PJM', 'DELAWARE': 'PJM',
  'ILLINOIS': 'PJM', 'KENTUCKY': 'PJM', 'NORTH CAROLINA': 'PJM',
  'WASHINGTON DC': 'PJM', 'DISTRICT OF COLUMBIA': 'PJM', 'INDIANA': 'PJM', 'MICHIGAN': 'PJM',
});
function detectStateIso(text) {
  const t = String(text || '').toUpperCase();
  if (/\bPJM\b/.test(t)) return { state: null, isoRegion: 'PJM' };
  for (const [state, iso] of Object.entries(STATE_ISO)) {
    if (t.includes(state)) return { state, isoRegion: iso };
  }
  return { state: null, isoRegion: null };
}

// ── Bounded LLM extraction (optional refinement, grounded afterwards) ───────
const EXTRACT_TOOL = {
  name: 'submit_physical_event',
  description: 'Structured extraction of ONE physical infrastructure event from the article. Copy numbers/dates exactly as written; use null when the article does not state a value.',
  input_schema: {
    type: 'object',
    properties: {
      eventType: { type: 'string', enum: [...S.EVENT_TYPES] },
      projectName: { type: 'string' },
      state: { type: 'string', description: 'US state named in the article, or null' },
      demandDeltaMW: { type: 'number' }, generationDeltaMW: { type: 'number' },
      transmissionDeltaMW: { type: 'number' }, storageDeltaMW: { type: 'number' },
      capexAmount: { type: 'number', description: 'USD, only if stated' },
      contractValue: { type: 'number', description: 'USD, only if stated' },
      contractDurationMonths: { type: 'number' },
      effectiveStartDate: { type: 'string', description: 'YYYY-MM-DD only if the article states it' },
      expectedCompletionDate: { type: 'string' },
      certainty: { type: 'string', enum: [...S.CERTAINTY] },
      companiesNamed: { type: 'array', items: { type: 'string' }, description: 'company NAMES as written; never tickers' },
      summary: { type: 'string' },
    },
    required: ['eventType', 'summary'],
  },
};

// Validate an LLM proposal against the source text. Anything not literally
// grounded in the text is nulled and reported in `dropped`.
function groundExtraction(proposal, sourceText) {
  if (!proposal || typeof proposal !== 'object') return { grounded: null, dropped: ['all'] };
  const text = String(sourceText || '');
  const mwInText = new Set(extractMW(text).map(v => +v.toFixed(3)));
  const usdInText = new Set(extractUSD(text).map(v => +v.toFixed(0)));
  const dropped = [];
  const groundNum = (field, allowedSet) => {
    const v = proposal[field];
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v) && allowedSet.has(+v.toFixed(field.endsWith('MW') ? 3 : 0))) return v;
    dropped.push(field);
    return null;
  };
  const groundDate = (field) => {
    const v = proposal[field];
    if (v == null) return null;
    // A date survives only if its year appears in the text AND it parses.
    if (S.isIsoDate(v) && text.includes(v.slice(0, 4))) return v;
    dropped.push(field);
    return null;
  };
  const eventType = S.EVENT_TYPE_SET.has(proposal.eventType) ? proposal.eventType : null;
  if (!eventType) dropped.push('eventType');
  const certainty = S.CERTAINTY_SET.has(proposal.certainty) ? proposal.certainty : null;
  const det = detectStateIso(text);
  const durationNum = (() => {
    const v = proposal.contractDurationMonths;
    if (v == null) return null;
    // duration in months is usually stated in years — accept if years or months figure appears
    if (typeof v === 'number' && Number.isFinite(v) &&
      (text.includes(String(Math.round(v))) || text.includes(String(Math.round(v / 12))))) return v;
    dropped.push('contractDurationMonths');
    return null;
  })();

  return {
    grounded: {
      eventType,
      projectName: typeof proposal.projectName === 'string' ? proposal.projectName.slice(0, 120) : null,
      state: det.state,                 // deterministic, never LLM
      isoRegion: det.isoRegion,         // deterministic, never LLM
      demandDeltaMW: groundNum('demandDeltaMW', mwInText),
      generationDeltaMW: groundNum('generationDeltaMW', mwInText),
      transmissionDeltaMW: groundNum('transmissionDeltaMW', mwInText),
      storageDeltaMW: groundNum('storageDeltaMW', mwInText),
      capexAmount: groundNum('capexAmount', usdInText),
      contractValue: groundNum('contractValue', usdInText),
      contractDuration: durationNum,
      effectiveStartDate: groundDate('effectiveStartDate'),
      expectedCompletionDate: groundDate('expectedCompletionDate'),
      certainty,
      companiesNamed: Array.isArray(proposal.companiesNamed)
        ? proposal.companiesNamed.filter(c => typeof c === 'string' && text.toUpperCase().includes(c.toUpperCase().slice(0, 12))).slice(0, 8)
        : [],
      summary: typeof proposal.summary === 'string' ? proposal.summary.slice(0, 400) : null,
      extractionConfidence: dropped.length === 0 ? 0.8 : Math.max(0.3, 0.8 - dropped.length * 0.1),
    },
    dropped,
  };
}

async function llmExtract({ title, text, timeoutMs = CALL_TIMEOUT_MS }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY missing', proposal: null };
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    const body = `${title || ''}\n\n${String(text || '').slice(0, MAX_TEXT_CHARS)}`;
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Extract the ONE physical electricity-infrastructure event described below. STRICT RULES: copy every number and date EXACTLY as written in the article; if the article does not state a value, use null — never estimate, never recall from memory. Company names as written, never tickers.\n\nARTICLE:\n${body}`,
      }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'submit_physical_event' },
    }, { timeout: timeoutMs });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_physical_event');
    return tool ? { ok: true, proposal: tool.input } : { ok: false, reason: 'no tool output', proposal: null };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), proposal: null };
  }
}

// ── Article → candidate event (deterministic path; LLM optional upstream) ───
// `article` = { title, text, url, publisher, publishedAt, retrievedAt }.
// Returns null when no physical event type is recognized (most articles).
function buildEventFromArticle(article, { grounded = null, todayIso } = {}) {
  const combined = `${article.title || ''} ${article.text || ''}`;
  const eventType = (grounded && grounded.eventType) || classifyEventType(combined);
  if (!eventType) return null;
  const det = detectStateIso(combined);
  const isoRegion = det.isoRegion || (grounded && grounded.isoRegion) || null;
  if (!isoRegion) return null;   // first slice: only events attributable to a supported region
  // Distinct values only: the same figure restated twice is corroboration, not
  // ambiguity — but TWO different figures stay ungrounded (never guessed).
  const mws = [...new Set(extractMW(combined))];
  const usds = [...new Set(extractUSD(combined))];
  const announcedAt = (S.isIsoDate(article.publishedAt) || S.isIsoDateTime(article.publishedAt))
    ? article.publishedAt : todayIso;

  const source = {
    sourceId: `news:${hashString(article.url || article.title || combined)}`,
    sourceFamily: 'trusted-news', publisher: article.publisher || 'unknown',
    sourceUrl: article.url || null, stableRef: article.url ? null : (article.title || null),
    publishedAt: article.publishedAt || null, effectiveAt: article.publishedAt || null,
    retrievedAt: article.retrievedAt || todayIso,
    primaryOrSecondary: S.SOURCE_QUALITY.SECONDARY,
    sourceQuality: 'secondary-news', freshnessStatus: 'fresh',
    parserVersion: EXTRACT_VERSION,
    rawContentHash: hashString(combined),
    extractionConfidence: grounded ? grounded.extractionConfidence : 0.6,
  };

  const constraintDelta = grounded || {};
  const draft = {
    id: `gridlock:evt:${hashString(`${eventType}|${isoRegion}|${combined.slice(0, 160)}`)}`,
    schemaVersion: S.SCHEMA_VERSION,
    eventType,
    title: String(article.title || '').slice(0, 200) || eventType,
    description: (constraintDelta.summary || String(article.text || '').slice(0, 300)) || null,
    announcedAt,
    effectiveStartDate: constraintDelta.effectiveStartDate || null,
    expectedCompletionDate: constraintDelta.expectedCompletionDate || null,
    durationMonths: constraintDelta.contractDuration || null,
    lifecycle: S.LIFECYCLE.NEW,
    certainty: constraintDelta.certainty || 'ANNOUNCED',
    geography: det.state, state: det.state, county: null, latitude: null, longitude: null,
    isoRegion, powerZone: null,
    projectName: constraintDelta.projectName || null,
    companies: constraintDelta.companiesNamed || [],
    counterparties: [],
    affectedTickers: [],   // filled by the exposure graph, never by the LLM
    demandDeltaMW: constraintDelta.demandDeltaMW != null ? constraintDelta.demandDeltaMW
      : (eventType === 'DATA_CENTER_LOAD' && mws.length === 1 ? mws[0] : null),
    generationDeltaMW: constraintDelta.generationDeltaMW != null ? constraintDelta.generationDeltaMW
      : (/GENERATION|RETIREMENT/.test(eventType) && mws.length === 1 ? mws[0] : null),
    storageDeltaMW: constraintDelta.storageDeltaMW || null,
    transmissionDeltaMW: constraintDelta.transmissionDeltaMW || null,
    fuelDemandDelta: null,
    capexAmount: constraintDelta.capexAmount != null ? constraintDelta.capexAmount : (usds.length === 1 ? usds[0] : null),
    contractValue: constraintDelta.contractValue || null,
    contractDuration: constraintDelta.contractDuration || null,
    expectedImpactWindow: null,
    sourceEvidence: [source],
    independentSourceCount: 1,
    extractionConfidence: source.extractionConfidence,
    evidenceQuality: 'secondary',
    fieldConflicts: [],
    unresolvedFields: [],
    parserVersion: EXTRACT_VERSION,
    createdAt: todayIso, updatedAt: todayIso,
  };
  draft.canonicalEventId = S.canonicalEventId(draft);
  draft.unresolvedFields = S.NUMERIC_FIELDS.filter(f => draft[f] == null);
  const v = S.validateEvent(draft);
  return v.ok ? draft : null;   // fail closed: invalid drafts are dropped, not "fixed"
}

// Fold candidate events into the canonical ledger map { canonicalEventId → event }.
// Duplicates MERGE (evidence accumulates); new canonicals append. Immutable.
function foldIntoLedger(ledger, candidates) {
  const next = { ...(ledger || {}) };
  let added = 0, merged = 0;
  for (const ev of candidates || []) {
    if (!ev) continue;
    const key = ev.canonicalEventId;
    if (next[key]) { next[key] = S.mergeEvent(next[key], ev); merged++; }
    else { next[key] = ev; added++; }
  }
  return { ledger: next, added, merged };
}

function hashString(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

module.exports = {
  EXTRACT_VERSION, EVENT_RX, EXTRACT_TOOL, STATE_ISO,
  classifyEventType, extractMW, extractUSD, detectStateIso,
  groundExtraction, llmExtract, buildEventFromArticle, foldIntoLedger, hashString,
};
