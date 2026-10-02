'use strict';
// Tech Operational Evidence — CONSUMER sleeve of the mapping registry (app stores +
// Workday job boards). Imported by registry.js; this file never requires registry.js.
//
// Every identifier below was probed read-only on 2026-10-02:
//   iOS      — https://itunes.apple.com/search?term=<company>&entity=software (sellerName
//              checked against the issuer) and /lookup?id=<id> (trackId round-trip).
//   Android  — https://play.google.com/store/apps/details?id=<package>&hl=en&gl=us returned
//              200 with the developer name shown in `playDeveloper`.
//   CIK      — https://www.sec.gov/files/company_tickers.json (exact ticker match).
//   Workday  — POST https://<tenant>.<wd>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
//              returned 200 with jobPostings[]. Tenants that answered 401/404/422 are
//              recorded as candidates in registry.js, not guessed.
// Companies WITHOUT a consumer app (AppLovin, Unity) are candidates with the reason stated.

const PROBE_DATE = '2026-10-02';

// [ticker, companyName, cik, domain, benchmark, subsector, iosId, iosSeller, playPackage, playDeveloper, product, revenueConnection]
const CONSUMER_APPS = Object.freeze([
  ['HOOD', 'Robinhood Markets, Inc.', '0001783879', 'robinhood.com', 'XLF', 'fintech', '938003185', 'Robinhood Markets Inc', 'com.robinhood.android', 'Robinhood', 'Robinhood app', 'Funded accounts and trading activity originate in the app; review velocity tracks new-user onboarding.'],
  ['COIN', 'Coinbase Global, Inc.', '0001679788', 'coinbase.com', 'XLF', 'fintech', '886427730', 'Coinbase, Inc.', 'com.coinbase.android', 'Coinbase Inc', 'Coinbase app', 'Retail transaction revenue is driven by app users; review velocity tracks retail engagement cycles.'],
  ['DUOL', 'Duolingo, Inc.', '0001562088', 'duolingo.com', 'IGV', 'consumer-software', '570060128', 'Duolingo, Inc', 'com.duolingo', 'Duolingo', 'Duolingo app', 'Subscriptions and DAU are app-native; review velocity tracks new-learner inflow.'],
  ['RBLX', 'Roblox Corp', '0001315098', 'roblox.com', 'XLC', 'interactive-media', '431946152', 'Roblox Corporation', 'com.roblox.client', 'Roblox Corporation', 'Roblox app', 'Bookings come from mobile DAU; review velocity tracks player inflow.'],
  ['SNAP', 'Snap Inc', '0001564408', 'snap.com', 'XLC', 'interactive-media', '447188370', 'Snap, Inc.', 'com.snapchat.android', 'Snap Inc', 'Snapchat app', 'Ad revenue scales with DAU; review velocity tracks user growth and release reception.'],
  ['PINS', 'Pinterest, Inc.', '0001506293', 'pinterest.com', 'XLC', 'interactive-media', '429047995', 'Pinterest, Inc.', 'com.pinterest', 'Pinterest', 'Pinterest app', 'Ad revenue scales with MAU; review velocity tracks mobile engagement.'],
  ['SOFI', 'SoFi Technologies, Inc.', '0001818874', 'sofi.com', 'XLF', 'fintech', '1191985736', 'Social Finance, LLC', 'com.sofi.mobile', 'Social Finance, LLC', 'SoFi app', 'Member growth and product adoption happen in-app; review velocity tracks onboarding.'],
  ['DKNG', 'DraftKings Inc.', '0001883685', 'draftkings.com', 'XLY', 'online-gaming', '1375031369', 'DRAFTKINGS LLC.', 'com.draftkings.sportsbook', 'DraftKings, Inc.', 'DraftKings Sportsbook & Casino app', 'Handle and monthly unique payers are app-native; review velocity tracks new-state launches and seasonal inflow.'],
  ['SPOT', 'Spotify Technology S.A.', '0001639920', 'spotify.com', 'XLC', 'interactive-media', '324684580', 'Spotify', 'com.spotify.music', 'Spotify AB', 'Spotify app', 'Premium subscriber adds and MAU are app-native; review velocity tracks user inflow.'],
  ['UBER', 'Uber Technologies, Inc', '0001543151', 'uber.com', 'XLY', 'marketplace', '368677368', 'Uber Technologies, Inc.', 'com.ubercab', 'Uber Technologies, Inc.', 'Uber rider app', 'Gross bookings originate in the rider app; review velocity tracks consumer activity.'],
  ['DASH', 'DoorDash, Inc.', '0001792789', 'doordash.com', 'XLY', 'marketplace', '719972451', 'DoorDash, Inc.', 'com.dd.doordash', 'DoorDash', 'DoorDash consumer app', 'Orders originate in the consumer app; review velocity tracks ordering activity.'],
  ['ABNB', 'Airbnb, Inc.', '0001559720', 'airbnb.com', 'XLY', 'marketplace', '401626263', 'Airbnb, Inc.', 'com.airbnb.android', 'Airbnb', 'Airbnb app', 'A majority of nights are booked in-app; review velocity tracks guest activity.'],
  ['RDDT', 'Reddit, Inc.', '0001713445', 'reddit.com', 'XLC', 'interactive-media', '1064216828', 'REDDIT, INC.', 'com.reddit.frontpage', 'reddit Inc.', 'Reddit app', 'Logged-in DAU monetized via ads; review velocity tracks app adoption.'],
  ['AFRM', 'Affirm Holdings, Inc.', '0001820953', 'affirm.com', 'XLF', 'fintech', '967040652', 'Affirm, Inc.', 'com.affirm.central', 'Affirm, Inc', 'Affirm app', 'Direct-to-consumer GMV and card usage are app-driven; review velocity tracks active-consumer growth.'],
  ['CHWY', 'Chewy, Inc.', '0001766502', 'chewy.com', 'XLY', 'e-commerce', '1149449468', 'Chewy, Inc.', 'com.chewy.android', 'Chewy, Inc.', 'Chewy app', 'Mobile orders and Autoship enrollment; review velocity tracks active-customer inflow.'],
  ['ETSY', 'ETSY INC', '0001370637', 'etsy.com', 'XLY', 'e-commerce', '477128284', 'Etsy, Inc.', 'com.etsy.android', 'Etsy, Inc', 'Etsy buyer app', 'App GMS share is a majority of marketplace sales; review velocity tracks buyer activity.'],
  ['ROKU', 'ROKU, INC', '0001428439', 'roku.com', 'XLC', 'streaming-platform', '482066631', 'ROKU INC', 'com.roku.remote', 'Roku, Inc. & its affiliates', 'Roku mobile app', 'Companion-app installs track active-account growth on the platform.'],
  ['PTON', 'PELOTON INTERACTIVE, INC.', '0001639825', 'onepeloton.com', 'XLY', 'connected-fitness', '792750948', 'Peloton Interactive, Inc.', 'com.onepeloton.callisto', 'Peloton Interactive, Inc', 'Peloton app', 'App subscriptions and member engagement; review velocity tracks subscriber inflow.'],
  ['BMBL', 'Bumble Inc.', '0001830043', 'bumble.com', 'XLC', 'interactive-media', '930441707', 'Bumble Holding Limited', 'com.bumble.app', 'Bumble Holding Limited', 'Bumble app', 'Paying users are acquired in-app; review velocity tracks user inflow.'],
  ['LYFT', 'Lyft, Inc.', '0001759509', 'lyft.com', 'XLY', 'marketplace', '529379082', 'Lyft, Inc.', 'me.lyft.android', 'Lyft, Inc.', 'Lyft rider app', 'Rides originate in the rider app; review velocity tracks active-rider growth.'],
  ['NFLX', 'NETFLIX INC', '0001065280', 'netflix.com', 'XLC', 'streaming-platform', '363590051', 'Netflix, Inc.', 'com.netflix.mediaclient', 'Netflix, Inc.', 'Netflix app', 'Paid-member growth and engagement; review velocity tracks mobile sign-up waves and release reception.'],
  ['HIMS', 'Hims & Hers Health, Inc.', '0001773751', 'hims.com', 'XLV', 'telehealth', '1455690574', 'Hims, Inc. (CA)', 'com.himshers.hims', 'Hims & Hers', 'Hims app', 'Subscriber onboarding runs through the app and web; review velocity tracks subscriber inflow.'],
  ['CART', 'Maplebear Inc.', '0001579091', 'instacart.com', 'XLY', 'marketplace', '545599256', 'Maplebear Inc', 'com.instacart.client', 'Instacart', 'Instacart customer app', 'Orders originate in the customer app; review velocity tracks ordering activity.'],
]);

// Workday tenants verified by one read-only cxs probe each (200 + jobPostings[]).
// [ticker, tenant, wd, site, careersNote]
const WORKDAY_BOARDS = Object.freeze([
  ['ETSY', 'etsy', 'wd5', 'Etsy_Careers', 'cxs probe returned total 58 postings on 2026-10-02'],
  ['CHWY', 'chewy', 'wd5', 'External', 'cxs probe returned total 251 postings on 2026-10-02'],
  ['DKNG', 'draftkings', 'wd1', 'DraftKings', 'cxs probe returned total 76 postings on 2026-10-02'],
]);

const CONSUMER_CANDIDATES = Object.freeze([
  Object.freeze({ ticker: 'APP', source: 'appstore', sourceId: null, excludeReason: 'AppLovin publishes no consumer app under its own seller account (iTunes search 2026-10-02 returned only SDK/test utilities with ≤42 ratings); the 2025 games divestiture removed the consumer surface.' }),
  Object.freeze({ ticker: 'U', source: 'appstore', sourceId: 'com.unity3d.unityremote4', excludeReason: 'Unity Technologies ships only developer tools (Unity Remote, 218 ratings) — no consumer app whose review velocity reflects revenue.' }),
]);

function appstoreMappings(base, row) {
  const [ticker, companyName, cik, domain, benchmark, subsector, iosId, iosSeller, playPackage, playDeveloper, product, revenueConnection] = row;
  const company = { ...base, ticker, companyName, cik, subsector, benchmark, domain, source: 'appstore' };
  return [
    Object.freeze({
      ...company, mappingId: `${ticker}-appstore-ios`, platform: 'ios', sourceId: iosId, product: `${product} (iOS)`,
      sourceUrl: `https://apps.apple.com/us/app/id${iosId}`,
      ownershipEvidence: `iTunes lookup id ${iosId} on ${PROBE_DATE}: sellerName "${iosSeller}" matches the issuer.`,
      revenueConnection, monetizationWeight: 'medium',
    }),
    Object.freeze({
      ...company, mappingId: `${ticker}-appstore-android`, platform: 'android', sourceId: playPackage, product: `${product} (Android)`,
      sourceUrl: `https://play.google.com/store/apps/details?id=${playPackage}`,
      ownershipEvidence: `Play listing ${playPackage} returned 200 on ${PROBE_DATE} with developer "${playDeveloper}".`,
      revenueConnection, monetizationWeight: 'medium',
    }),
  ];
}

function workdayMapping(base, row, companies) {
  const [ticker, tenant, wd, site, note] = row;
  const c = companies.find((x) => x[0] === ticker);
  if (!c) throw new Error(`registry-consumer: Workday board for unknown company ${ticker}`);
  return Object.freeze({
    ...base, ticker, companyName: c[1], cik: c[2], subsector: c[5], benchmark: c[4], domain: c[3],
    source: 'workday', mappingId: `${ticker}-workday`, sourceId: `${tenant}/${wd}/${site}`, product: `${c[1]} hiring mix`,
    sourceUrl: `https://${tenant}.${wd}.myworkdayjobs.com/${site}`,
    ownershipEvidence: `Workday tenant "${tenant}" site "${site}" — ${note}.`,
    revenueConnection: 'Posting mix is management intent about go-to-market vs product investment — not completed hiring.',
    monetizationWeight: 'low',
  });
}

// base: the shared point-in-time fields (mappingConfidence, verifiedAt, activeFrom, version…).
function buildConsumerMappings(base) {
  const apps = CONSUMER_APPS.flatMap((row) => appstoreMappings(base, row));
  const boards = WORKDAY_BOARDS.map((row) => workdayMapping(base, row, CONSUMER_APPS));
  return Object.freeze([...apps, ...boards]);
}

module.exports = { PROBE_DATE, CONSUMER_APPS, WORKDAY_BOARDS, CONSUMER_CANDIDATES, buildConsumerMappings };
