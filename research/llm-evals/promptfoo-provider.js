'use strict';
// promptfoo custom provider shim (promptfoo is NOT a dependency; see README.md).
// promptfoo passes `vars.family` + `vars.caseId`; this provider ignores the rendered prompt
// text and runs the case through the site's own request builders (families.js) exactly as
// `run.js --live` does, returning the full per-case result as JSON for promptfoo-assert.js.
//
// Usage: npx promptfoo@latest eval -c research/llm-evals/promptfooconfig.yaml

const { FAMILIES } = require('./families');
const { loadFamilyCases, runCaseLive } = require('./run');

class SiteRequestBuilderProvider {
  constructor(options = {}) {
    this.providerId = (options && options.id) || 'site-request-builders';
    this.rubric = !!(options && options.config && options.config.rubric);
  }

  id() { return this.providerId; }

  async callApi(_prompt, context) {
    const vars = (context && context.vars) || {};
    const adapter = FAMILIES[vars.family];
    if (!adapter) return { error: `unknown family ${vars.family}` };
    const c = loadFamilyCases(vars.family).cases.find(x => x.id === vars.caseId);
    if (!c) return { error: `unknown case ${vars.family}/${vars.caseId}` };
    if (!process.env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY not set' };
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const result = await runCaseLive(adapter, c, { client, rubric: this.rubric });
    return { output: JSON.stringify(result), cost: result.usd || 0 };
  }
}

module.exports = SiteRequestBuilderProvider;
