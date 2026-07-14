---
name: drive-app
description: Launch and drive the Market News App in a real headless browser (Playwright) to confirm a tab renders — reports console errors, render hazards, and a screenshot. Use to verify a change works in the live UI, not just the backend.
---

# Drive the app — verify the RENDERED frontend

This app is a deployed Vercel serverless API + a vanilla-JS SPA under `public/` (no build,
ES-module `public/js/*.js`, hand-drawn canvas charts). The UI renders **client-side** by
injecting payloads into `innerHTML` template strings, so a leak (`undefined`, an unresolved
`${…}`, `[object Object]`, `NaN`, or an unrounded float like `319.7099999999999`) shows up
only on the actual page. Backend `curl` and the data-layer render-guard
(`test/render-guard.test.js`) do **not** catch client render leaks. "Running it" = loading
the real page in a browser and driving a tab. This is the app's standing lesson: verify the
rendered frontend, not just backend curl.

## Prerequisite

Playwright + chromium. Check: `npx playwright --version`. If the browser isn't installed:
`npx playwright install chromium`. The driver **self-locates** the Playwright module from the
`npx` cache, so it does not need to be in the project's `node_modules`.

## Run

```
node .claude/skills/drive-app/drive.js <tab> [baseUrl]
```

- `<tab>` — a `data-tab` name (default `evolve`). Find others with `grep -o 'data-tab="[^"]*"' public/index.html` or `TAB_GROUPS` in `public/js/app.js` (e.g. `today`, `ghost`, `scoreboard`, `custom`, `xalerts`).
- `[baseUrl]` — default prod `https://market-news-app-chi.vercel.app`. Pass a preview or `http://localhost:3000` to drive elsewhere.

It navigates via `window.showTab(tab)` (falls back to clicking `[data-tab]`), waits up to 45s
for the section to finish loading, then reports:

- console errors + page errors
- render hazards: literal `undefined`, unresolved `${…}`, `[object Object]`, `NaN`
- a **screenshot** path in the OS temp dir — open it with the Read tool and look; a blank frame is a failed launch
- the visible section text (first 1000 chars)

Exit code `0` = clean (section present, no errors, no hazards); `1` = something to look at.

## After driving

If you find a render leak, fix it at the render site in `public/js/*.js`, then:

```
node --input-type=module --check < public/js/<file>.js   # ES-module parse (node --check alone MISSES module-parse errors)
```

and re-drive. Ship the fix on a branch → PR → merge (auto-deploys), then re-drive prod to confirm.

## Notes

- Deploys are auto-triggered on merge to `main`; `op=version` returns the serving git SHA — poll it to know when a fix is live before re-driving.
- The screenshot is written to the OS temp dir (not the repo), so nothing binary gets committed.
