// Structured logging — emits one JSON line per event so Vercel function logs are
// greppable (filter by level/ctx) instead of bare strings or, worse, nothing.
// Replaces silent `catch {}` swallows in the data layer so external-API failures
// leave a trace. Each helper also RETURNS the record (handy for tests / callers).

// REQUEST CONTEXT — so a log line names the op that caused it, not just the module that
// emitted it. `no daily data` warnings identify the fetcher (screener.fetchDailyHistory)
// but not the caller, which is why tracing the 22:00Z 504s to a specific op required
// inference twice, and was wrong once. AsyncLocalStorage rather than a module-level
// variable because Fluid Compute runs concurrent requests in ONE process, where a global
// "current op" would mis-attribute under exactly the load that matters.
const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();

// Keys the ambient context must never control — they describe the emitting call site.
const RESERVED = new Set(['level', 'ctx', 'msg', 'at']);

function ambient() {
  const store = requestContext.getStore();
  if (!store) return null;
  const safe = {};
  for (const [k, v] of Object.entries(store)) if (!RESERVED.has(k)) safe[k] = v;
  return safe;
}

// Run `fn` with `context` merged into every log line emitted inside it, including across
// awaits. Returns whatever fn returns.
function withLogContext(context, fn) {
  return requestContext.run({ ...(context || {}) }, fn);
}

function emit(level, context, msgOrErr, extra) {
  const msg = typeof msgOrErr === 'string' ? msgOrErr : String((msgOrErr && msgOrErr.message) || msgOrErr);
  // Order matters: ambient context fills in, an explicit `extra` from the call site wins.
  const rec = { level, ctx: context, msg, ...ambient(), ...(extra || {}), at: new Date().toISOString() };
  const line = JSON.stringify(rec);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return rec;
}

const logError = (context, err, extra) => emit('error', context, err, extra);
const logWarn = (context, msg, extra) => emit('warn', context, msg, extra);
const logInfo = (context, msg, extra) => emit('info', context, msg, extra);

module.exports = { logError, logWarn, logInfo, withLogContext };
