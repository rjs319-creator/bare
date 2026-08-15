'use strict';
// Tech Operational Evidence — verified ticker↔product mapping registry.
//
// This file IS the registry (version-controlled and auditable through git). Every VERIFIED
// entry was checked against official sources on `verifiedAt`: the CIK against the SEC's
// company_tickers.json, package/repo/board/status identifiers against the company's own
// published pages or org-owned metadata. Never guess a mapping — unverifiable candidates
// live in CANDIDATES with the reason they are excluded from signal production.
//
// Point-in-time contract: `activeFrom`/`activeTo` bound when a mapping may produce signals.
// Backfilled history before `verifiedAt` relies on `historicalBasis` (ownership assumed
// continuous per the source's own metadata history) and is labeled basis:'backfill'
// downstream — the same retro-classification caveat the tech universe carries.

const REGISTRY_VERSION = 2;

// Hosts the collectors are allowed to touch, ever. Adapter URLs are validated against
// this list (plus per-mapping pricing hosts) to prevent SSRF via a corrupted mapping.
const OFFICIAL_API_HOSTS = Object.freeze([
  'api.npmjs.org', 'api.github.com', 'huggingface.co',
  'boards-api.greenhouse.io', 'api.lever.co', 'api.usaspending.gov',
  'data.sec.gov', 'www.sec.gov', 'efts.sec.gov',
]);

// Human-facing provenance hosts per source (sourceUrl points a reader at the official
// listing; collection itself only ever fetches OFFICIAL_API_HOSTS or company domains).
const SOURCE_DISPLAY_HOSTS = Object.freeze({
  npm: ['www.npmjs.com', 'npmjs.com'],
  github: ['github.com'],
  huggingface: ['huggingface.co'],
  usaspending: ['www.usaspending.gov'],
  greenhouse: ['boards-api.greenhouse.io', 'boards.greenhouse.io'],
  lever: ['api.lever.co', 'jobs.lever.co'],
});

const CONFIDENCE = Object.freeze(['verified', 'candidate']);
const WEIGHTS = Object.freeze(['high', 'medium', 'low']);

const company = (base, entries) => entries.map((e) => Object.freeze({ ...base, ...e }));

// ── Verified companies ──────────────────────────────────────────────────────
// CIKs verified against https://www.sec.gov/files/company_tickers.json on 2026-08-15.
const V = { mappingConfidence: 'verified', verifiedAt: '2026-08-15', activeFrom: '2024-01-01', activeTo: null, historicalBasis: 'ownership-assumed-continuous', version: REGISTRY_VERSION };

const MAPPINGS = Object.freeze([
  ...company({ ...V, ticker: 'MDB', companyName: 'MongoDB, Inc.', cik: '0001441816', subsector: 'software', benchmark: 'IGV', domain: 'mongodb.com' }, [
    { mappingId: 'MDB-npm-mongodb', source: 'npm', sourceId: 'mongodb', product: 'MongoDB Node.js driver',
      sourceUrl: 'https://www.npmjs.com/package/mongodb',
      ownershipEvidence: 'Published by the mongodb npm org; repository field is github.com/mongodb/node-mongodb-native; linked from official docs (mongodb.com/docs/drivers/node/).',
      revenueConnection: 'Driver installs track developer adoption of MongoDB, monetized through Atlas consumption and Enterprise Advanced subscriptions.',
      monetizationWeight: 'high' },
    { mappingId: 'MDB-github-node-driver', source: 'github', sourceId: 'mongodb/node-mongodb-native', product: 'MongoDB Node.js driver',
      sourceUrl: 'https://github.com/mongodb/node-mongodb-native',
      ownershipEvidence: 'Repository lives in the company-owned mongodb GitHub org (linked from mongodb.com).',
      revenueConnection: 'Release cadence and external participation reflect investment in and usage of the monetized driver ecosystem.',
      monetizationWeight: 'medium' },
    { mappingId: 'MDB-greenhouse', source: 'greenhouse', sourceId: 'mongodb', product: 'MongoDB hiring mix',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/mongodb/jobs',
      ownershipEvidence: 'Official Greenhouse board token "mongodb"; postings link back to mongodb.com careers.',
      revenueConnection: 'Sales/CS vs engineering posting mix is management intent about go-to-market investment — not completed hiring.',
      monetizationWeight: 'low' },
    { mappingId: 'MDB-status', source: 'statuspage', sourceId: 'status.mongodb.com', product: 'MongoDB Atlas status',
      sourceUrl: 'https://status.mongodb.com/api/v2/summary.json',
      ownershipEvidence: 'status.mongodb.com is on the company domain.',
      revenueConnection: 'Unexpected Atlas incidents are operational risk to consumption revenue. Company-reported.',
      monetizationWeight: 'low' },
  ]),
  ...company({ ...V, ticker: 'DDOG', companyName: 'Datadog, Inc.', cik: '0001561550', subsector: 'software', benchmark: 'IGV', domain: 'datadoghq.com' }, [
    { mappingId: 'DDOG-npm-dd-trace', source: 'npm', sourceId: 'dd-trace', product: 'Datadog Node.js APM tracer',
      sourceUrl: 'https://www.npmjs.com/package/dd-trace',
      ownershipEvidence: 'Published by the DataDog npm org; repository field is github.com/DataDog/dd-trace-js; linked from docs.datadoghq.com.',
      revenueConnection: 'Tracer installs track APM product adoption, billed per host/usage.',
      monetizationWeight: 'high' },
    { mappingId: 'DDOG-github-dd-trace-js', source: 'github', sourceId: 'DataDog/dd-trace-js', product: 'Datadog Node.js APM tracer',
      sourceUrl: 'https://github.com/DataDog/dd-trace-js',
      ownershipEvidence: 'Repository lives in the company-owned DataDog GitHub org.',
      revenueConnection: 'Release cadence reflects investment in the monetized APM client.',
      monetizationWeight: 'medium' },
    { mappingId: 'DDOG-greenhouse', source: 'greenhouse', sourceId: 'datadog', product: 'Datadog hiring mix',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/datadog/jobs',
      ownershipEvidence: 'Official Greenhouse board token "datadog"; postings link back to careers.datadoghq.com.',
      revenueConnection: 'Posting mix is management intent about go-to-market vs product investment — not completed hiring.',
      monetizationWeight: 'low' },
    { mappingId: 'DDOG-status', source: 'statuspage', sourceId: 'status.datadoghq.com', product: 'Datadog platform status',
      sourceUrl: 'https://status.datadoghq.com/api/v2/summary.json',
      ownershipEvidence: 'status.datadoghq.com is on the company domain.',
      revenueConnection: 'Unexpected platform incidents are operational risk to usage-billed revenue. Company-reported.',
      monetizationWeight: 'low' },
  ]),
  ...company({ ...V, ticker: 'NET', companyName: 'Cloudflare, Inc.', cik: '0001477333', subsector: 'cloud', benchmark: 'SKYY', domain: 'cloudflare.com' }, [
    { mappingId: 'NET-npm-wrangler', source: 'npm', sourceId: 'wrangler', product: 'Cloudflare Workers CLI (wrangler)',
      sourceUrl: 'https://www.npmjs.com/package/wrangler',
      ownershipEvidence: 'Published by the cloudflare npm org; repository field is github.com/cloudflare/workers-sdk; linked from developers.cloudflare.com.',
      revenueConnection: 'Wrangler installs track Workers developer-platform adoption, monetized via paid Workers plans and usage.',
      monetizationWeight: 'medium' },
    { mappingId: 'NET-github-workers-sdk', source: 'github', sourceId: 'cloudflare/workers-sdk', product: 'Cloudflare Workers SDK',
      sourceUrl: 'https://github.com/cloudflare/workers-sdk',
      ownershipEvidence: 'Repository lives in the company-owned cloudflare GitHub org.',
      revenueConnection: 'Release cadence reflects investment in the monetized developer platform.',
      monetizationWeight: 'medium' },
    { mappingId: 'NET-greenhouse', source: 'greenhouse', sourceId: 'cloudflare', product: 'Cloudflare hiring mix',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs',
      ownershipEvidence: 'Official Greenhouse board token "cloudflare".',
      revenueConnection: 'Posting mix is management intent — not completed hiring.',
      monetizationWeight: 'low' },
    { mappingId: 'NET-status', source: 'statuspage', sourceId: 'www.cloudflarestatus.com', product: 'Cloudflare network status',
      sourceUrl: 'https://www.cloudflarestatus.com/api/v2/summary.json',
      ownershipEvidence: 'cloudflarestatus.com is Cloudflare\'s official status host (linked from cloudflare.com).',
      revenueConnection: 'Unexpected network incidents are operational risk to subscription and usage revenue. Company-reported.',
      monetizationWeight: 'low' },
  ]),
  ...company({ ...V, ticker: 'TWLO', companyName: 'Twilio Inc.', cik: '0001447669', subsector: 'software', benchmark: 'IGV', domain: 'twilio.com' }, [
    { mappingId: 'TWLO-npm-twilio', source: 'npm', sourceId: 'twilio', product: 'Twilio Node.js SDK',
      sourceUrl: 'https://www.npmjs.com/package/twilio',
      ownershipEvidence: 'Published by the twilio npm org; repository field is github.com/twilio/twilio-node; linked from twilio.com/docs.',
      revenueConnection: 'SDK installs track developer usage of usage-billed communications APIs.',
      monetizationWeight: 'high' },
    { mappingId: 'TWLO-github-twilio-node', source: 'github', sourceId: 'twilio/twilio-node', product: 'Twilio Node.js SDK',
      sourceUrl: 'https://github.com/twilio/twilio-node',
      ownershipEvidence: 'Repository lives in the company-owned twilio GitHub org.',
      revenueConnection: 'Release cadence reflects investment in the monetized API client.',
      monetizationWeight: 'medium' },
    { mappingId: 'TWLO-status', source: 'statuspage', sourceId: 'status.twilio.com', product: 'Twilio API status',
      sourceUrl: 'https://status.twilio.com/api/v2/summary.json',
      ownershipEvidence: 'status.twilio.com is on the company domain.',
      revenueConnection: 'Unexpected API incidents are operational risk to usage revenue. Company-reported.',
      monetizationWeight: 'low' },
  ]),
  ...company({ ...V, ticker: 'ESTC', companyName: 'Elastic N.V.', cik: '0001707753', subsector: 'software', benchmark: 'IGV', domain: 'elastic.co' }, [
    { mappingId: 'ESTC-npm-elasticsearch', source: 'npm', sourceId: '@elastic/elasticsearch', product: 'Elasticsearch Node.js client',
      sourceUrl: 'https://www.npmjs.com/package/@elastic/elasticsearch',
      ownershipEvidence: 'Scoped @elastic npm org package; repository field is github.com/elastic/elasticsearch-js; linked from elastic.co docs.',
      revenueConnection: 'Client installs track Elasticsearch adoption, monetized via Elastic Cloud consumption and subscriptions.',
      monetizationWeight: 'high' },
    { mappingId: 'ESTC-github-elasticsearch-js', source: 'github', sourceId: 'elastic/elasticsearch-js', product: 'Elasticsearch Node.js client',
      sourceUrl: 'https://github.com/elastic/elasticsearch-js',
      ownershipEvidence: 'Repository lives in the company-owned elastic GitHub org.',
      revenueConnection: 'Release cadence reflects investment in the monetized client ecosystem.',
      monetizationWeight: 'medium' },
    { mappingId: 'ESTC-greenhouse', source: 'greenhouse', sourceId: 'elastic', product: 'Elastic hiring mix',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/elastic/jobs',
      ownershipEvidence: 'Official Greenhouse board token "elastic".',
      revenueConnection: 'Posting mix is management intent — not completed hiring.',
      monetizationWeight: 'low' },
  ]),
  // Confluent deregistered via Form 15-12G on 2026-03-27 (no longer SEC-listed) — mappings
  // retained for point-in-time history but INACTIVE: they may never produce new signals.
  ...company({ ...V, activeTo: '2026-03-27', inactiveReason: 'Form 15-12G deregistration filed 2026-03-27; ticker no longer trades.', ticker: 'CFLT', companyName: 'Confluent, Inc.', cik: '0001699838', subsector: 'software', benchmark: 'IGV', domain: 'confluent.io' }, [
    { mappingId: 'CFLT-npm-kafka-javascript', source: 'npm', sourceId: '@confluentinc/kafka-javascript', product: 'Confluent Kafka JavaScript client',
      sourceUrl: 'https://www.npmjs.com/package/@confluentinc/kafka-javascript',
      ownershipEvidence: 'Scoped @confluentinc npm org package; repository field is github.com/confluentinc/confluent-kafka-javascript; linked from docs.confluent.io.',
      revenueConnection: 'Client installs track Kafka/Confluent adoption, monetized via Confluent Cloud consumption.',
      monetizationWeight: 'medium' },
    { mappingId: 'CFLT-github-kafka-javascript', source: 'github', sourceId: 'confluentinc/confluent-kafka-javascript', product: 'Confluent Kafka JavaScript client',
      sourceUrl: 'https://github.com/confluentinc/confluent-kafka-javascript',
      ownershipEvidence: 'Repository lives in the company-owned confluentinc GitHub org.',
      revenueConnection: 'Release cadence reflects investment in the monetized client ecosystem.',
      monetizationWeight: 'medium' },
  ]),
]);

// ── Excluded mapping candidates (visible on the page, never produce signals) ──
const CANDIDATES = Object.freeze([
  Object.freeze({ ticker: 'CFLT', source: 'greenhouse', sourceId: null, excludeReason: 'No verified public Greenhouse/Lever board token found on official careers pages.' }),
  Object.freeze({ ticker: 'ESTC', source: 'huggingface', sourceId: 'elastic', excludeReason: 'Hugging Face org ownership not yet verified against an official elastic.co link.' }),
  Object.freeze({ ticker: 'GTLB', source: 'npm', sourceId: '@gitlab/ui', excludeReason: 'Package is an internal UI kit, not a revenue-producing product surface.' }),
  Object.freeze({ ticker: 'FSLY', source: 'npm', sourceId: '@fastly/js-compute', excludeReason: 'Ownership verified but download volume too thin for a robust baseline; revisit after forward collection.' }),
  Object.freeze({ ticker: 'IBM', source: 'github', sourceId: 'hashicorp/terraform', excludeReason: 'HashiCorp acquired by IBM (closed 2025); product-to-ticker revenue mapping too diluted at IBM scale.' }),
]);

const isTicker = (t) => typeof t === 'string' && /^[A-Z][A-Z.\-]{0,6}$/.test(t);
const isCik = (c) => typeof c === 'string' && /^\d{10}$/.test(c);
const isIsoDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function validateMapping(m) {
  const issues = [];
  if (!m || typeof m !== 'object') return { ok: false, issues: ['not an object'] };
  if (!m.mappingId) issues.push('missing mappingId');
  if (!isTicker(m.ticker || '')) issues.push('invalid ticker');
  if (!isCik(m.cik || '')) issues.push('invalid CIK (need 10-digit zero-padded string)');
  if (!m.source) issues.push('missing source');
  if (!m.sourceId) issues.push('missing sourceId');
  if (!m.sourceUrl || !hostOf(m.sourceUrl)) issues.push('missing/invalid sourceUrl');
  if (!m.ownershipEvidence) issues.push('missing ownershipEvidence');
  if (!m.revenueConnection) issues.push('missing revenueConnection');
  if (!WEIGHTS.includes(m.monetizationWeight)) issues.push('monetizationWeight must be high|medium|low');
  if (!CONFIDENCE.includes(m.mappingConfidence)) issues.push('mappingConfidence must be verified|candidate');
  if (!isIsoDate(m.verifiedAt || '')) issues.push('missing verifiedAt');
  if (!isIsoDate(m.activeFrom || '')) issues.push('missing activeFrom');
  if (m.activeTo != null && !isIsoDate(m.activeTo)) issues.push('activeTo must be null or YYYY-MM-DD');
  const host = hostOf(m.sourceUrl || '');
  const displayHosts = SOURCE_DISPLAY_HOSTS[m.source] || [];
  if (host && !OFFICIAL_API_HOSTS.includes(host) && !displayHosts.includes(host)
    && !isCompanyHost(host, m.domain, { allowStatusConvention: m.source === 'statuspage' })) {
    issues.push(`sourceUrl host "${host}" is neither an official API host nor on the company domain`);
  }
  return { ok: issues.length === 0, issues };
}

function isCompanyHost(host, domain, { allowStatusConvention = false } = {}) {
  if (!host || !domain) return false;
  const d = String(domain).toLowerCase();
  if (host === d || host.endsWith('.' + d)) return true;
  // The <name>status.com convention (e.g. www.cloudflarestatus.com) is a naming
  // convention, not ownership evidence — it is honored ONLY for statuspage mappings.
  if (!allowStatusConvention) return false;
  const stem = d.split('.')[0];
  return host === `www.${stem}status.com` || host === `${stem}status.com` || host.endsWith(`.${stem}status.com`);
}

// Active, verified mappings only — the sole path into signal production.
function activeMappings({ source = null, asOf = null } = {}) {
  const day = asOf || new Date().toISOString().slice(0, 10);
  return MAPPINGS.filter((m) => m.mappingConfidence === 'verified'
    && validateMapping(m).ok
    && (!source || m.source === source)
    && m.activeFrom <= day
    && (m.activeTo == null || day <= m.activeTo));
}

const mappingsForTicker = (ticker) => MAPPINGS.filter((m) => m.ticker === ticker);
const mappingById = (id) => MAPPINGS.find((m) => m.mappingId === id) || null;

function verifiedTickers() {
  return [...new Set(activeMappings().map((m) => m.ticker))].sort();
}

function benchmarkFor(ticker) {
  const m = MAPPINGS.find((x) => x.ticker === ticker);
  return m ? m.benchmark : null;
}

function cikFor(ticker) {
  const m = MAPPINGS.find((x) => x.ticker === ticker);
  return m ? m.cik : null;
}

// Full allowlist for outbound collection fetches — only hosts from mappings that PASS
// validation may join (a typo'd or unofficial host must not become fetchable), memoized
// since MAPPINGS is a frozen in-repo constant.
let _allowedHosts = null;
function allowedHosts() {
  if (_allowedHosts) return _allowedHosts;
  const hosts = new Set(OFFICIAL_API_HOSTS);
  for (const m of MAPPINGS) {
    if (!validateMapping(m).ok) continue;
    const h = hostOf(m.sourceUrl);
    if (h) hosts.add(h);
  }
  _allowedHosts = [...hosts].sort();
  return _allowedHosts;
}

function isAllowedUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (!/^https:/.test(String(url))) return false;
  return allowedHosts().includes(h);
}

module.exports = {
  REGISTRY_VERSION, OFFICIAL_API_HOSTS, SOURCE_DISPLAY_HOSTS, MAPPINGS, CANDIDATES,
  validateMapping, activeMappings, mappingsForTicker, mappingById,
  verifiedTickers, benchmarkFor, cikFor, allowedHosts, isAllowedUrl, isCompanyHost,
};
