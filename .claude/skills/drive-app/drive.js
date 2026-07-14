#!/usr/bin/env node
'use strict';
// Drive a tab of the Market News App in a real headless browser and report render health.
//
//   node .claude/skills/drive-app/drive.js <tab> [baseUrl]
//     <tab>     data-tab name (default: evolve). e.g. today, ghost, scoreboard, custom
//     [baseUrl] default https://market-news-app-chi.vercel.app (pass a preview/localhost URL to drive elsewhere)
//
// Prints console/page errors, render hazards (literal undefined / unresolved ${…} /
// [object Object] / NaN), a screenshot path (in the OS temp dir), and the visible section
// text. Exit 0 = clean; 1 = something to look at. The render happens client-side, so this
// catches leaks that backend curl and the data-layer render-guard cannot.

const path = require('path');
const fs = require('fs');
const os = require('os');

// Prefer a normal resolve; else self-locate Playwright from the `npx playwright` cache so it
// works without installing playwright into the project's node_modules.
function loadPlaywright() {
  try { return require('playwright'); } catch { /* not in project */ }
  const npx = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npx)) {
    for (const d of fs.readdirSync(npx)) {
      try { return require(path.join(npx, d, 'node_modules', 'playwright')); } catch { /* keep looking */ }
    }
  }
  console.error('Playwright not found. Run:  npx playwright install chromium');
  process.exit(2);
}

const tab = process.argv[2] || 'evolve';
const baseUrl = (process.argv[3] || 'https://market-news-app-chi.vercel.app').replace(/\/$/, '');
const { chromium } = loadPlaywright();

(async () => {
  const shot = path.join(os.tmpdir(), `drive-${tab}.png`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 200)));

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  const nav = await page.evaluate((t) => {
    if (typeof window.showTab === 'function') { window.showTab(t); return 'showTab'; }
    const el = document.querySelector(`[data-tab="${t}"]`); if (el) { el.click(); return 'click'; }
    return 'none';
  }, tab);

  const sel = '#' + tab;
  // Wait until the section finishes loading (compose/loading message cleared), up to 45s.
  try {
    await page.waitForFunction((s) => {
      const el = document.querySelector(s); if (!el) return false;
      const t = el.innerText || '';
      return t.length > 40 && !/composing|calibrating…|loading…/i.test(t);
    }, sel, { timeout: 45000 });
  } catch { /* capture whatever rendered */ }
  await page.waitForTimeout(1500);

  const el = await page.$(sel);
  const text = el ? (await el.innerText()).trim() : `(no ${sel} section found)`;
  const html = el ? await el.innerHTML() : '';
  const hazards = {
    undefinedLeak: /\bundefined\b/.test(text),
    templateLeak: html.includes('${'),
    objectLeak: /\[object Object\]/.test(text),
    nan: /\bNaN\b/.test(text),
  };
  await page.screenshot({ path: shot });
  const clean = !!el && errors.length === 0 && !Object.values(hazards).some(Boolean);

  console.log(`tab=${tab}  nav=${nav}  url=${baseUrl}`);
  console.log('console errors:', errors.length, errors.slice(0, 3));
  console.log('render hazards:', JSON.stringify(hazards));
  console.log('screenshot:', shot, '(open it and look — a blank frame is a failed launch)');
  console.log('--- visible text (first 1000) ---\n' + text.slice(0, 1000));
  await browser.close();
  process.exit(clean ? 0 : 1);
})().catch((e) => { console.error('DRIVE FAILED:', e.message); process.exit(1); });
