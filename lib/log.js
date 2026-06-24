// Structured logging — emits one JSON line per event so Vercel function logs are
// greppable (filter by level/ctx) instead of bare strings or, worse, nothing.
// Replaces silent `catch {}` swallows in the data layer so external-API failures
// leave a trace. Each helper also RETURNS the record (handy for tests / callers).

function emit(level, context, msgOrErr, extra) {
  const msg = typeof msgOrErr === 'string' ? msgOrErr : String((msgOrErr && msgOrErr.message) || msgOrErr);
  const rec = { level, ctx: context, msg, ...(extra || {}), at: new Date().toISOString() };
  const line = JSON.stringify(rec);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return rec;
}

const logError = (context, err, extra) => emit('error', context, err, extra);
const logWarn = (context, msg, extra) => emit('warn', context, msg, extra);
const logInfo = (context, msg, extra) => emit('info', context, msg, extra);

module.exports = { logError, logWarn, logInfo };
