'use strict';
// WIKIMEDIA USER-AGENT — the one identity string for every call to a Wikimedia project
// (en.wikipedia.org change tables in lib/constituents.js, the REST pageviews API and the
// Wikidata SPARQL endpoint in research/lib/*).
//
// Wikimedia's User-Agent policy (https://meta.wikimedia.org/wiki/User-Agent_policy) asks every
// client for a DESCRIPTIVE UA: the tool's name and version, a way to contact its operator (URL
// or e-mail), and ideally the HTTP library. Generic browser strings (a bare "Mozilla/5.0 ...")
// are treated as abusive and get throttled or blocked. The contact is read from WIKIMEDIA_CONTACT
// so an operator can supply an e-mail without a code change; the SAFE default is the public
// repository's issue tracker — a real contact that is not anyone's personal address.
// test/wikimedia-ua.test.js pins that no Wikimedia host is fetched with the bare UA.

const APP_NAME = 'market-news-app';
const APP_VERSION = '1.0';
const REPO_URL = 'https://github.com/rjs319-creator/bare';
const DEFAULT_CONTACT = `${REPO_URL}/issues`;
const CONTACT_MAX_LENGTH = 120;
const WIKIMEDIA_HOST_RE = /(^|\.)(wikipedia|wikimedia|wikidata)\.org$/i;

// Header values must be single-line; the env var is operator input, so it is sanitised rather
// than trusted (a CR/LF would otherwise be a header-injection vector through undici's checks).
function sanitizeContact(raw) {
  const text = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').replace(/[()]/g, '').trim();
  return text ? text.slice(0, CONTACT_MAX_LENGTH) : DEFAULT_CONTACT;
}

function wikimediaUserAgent(env = process.env) {
  const contact = sanitizeContact(env && env.WIKIMEDIA_CONTACT);
  return `${APP_NAME}/${APP_VERSION} (${REPO_URL}; ${contact}) Node.js/${process.versions.node}`;
}

// True for any host under wikipedia.org / wikimedia.org / wikidata.org (and nothing else).
function isWikimediaUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try { return WIKIMEDIA_HOST_RE.test(new URL(url).hostname); } catch { return false; }
}

const WIKIMEDIA_UA = wikimediaUserAgent();
const WIKIMEDIA_HEADERS = Object.freeze({ 'User-Agent': WIKIMEDIA_UA });

module.exports = { APP_NAME, REPO_URL, DEFAULT_CONTACT, WIKIMEDIA_UA, WIKIMEDIA_HEADERS, wikimediaUserAgent, isWikimediaUrl };
