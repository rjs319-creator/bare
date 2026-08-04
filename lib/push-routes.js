'use strict';
// WEB PUSH HTTP OPS — thin route layer over lib/push-notify (feature-flagged: everything
// degrades to an honest not-configured response unless VAPID env + the web-push dependency
// are present; see that module for the storage/validation/cleanup contracts).
//
//   op=pushsubscribe   (POST { subscription }) — store a browser PushSubscription
//   op=pushunsubscribe (POST { endpoint })     — remove it (also called on permission revoke)
//   op=pushstatus      (GET)                   — configuration + counts + the VAPID PUBLIC
//                                                key (public by design — the browser needs it
//                                                as applicationServerKey; the PRIVATE key
//                                                never leaves the server environment)
//
// Subscriptions are capability URLs: they are stored server-side, never echoed back in any
// list/status response.

const push = require('./push-notify');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch { return {}; }
}

async function runPushOp(req, res) {
  const op = req.query.op;
  res.setHeader('Cache-Control', 'no-store');

  if (op === 'pushstatus') {
    const status = await push.status();
    return res.json({
      ok: true, ...status,
      vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
  const body = await readBody(req);

  if (op === 'pushsubscribe') {
    const out = await push.addSubscription(body.subscription || body);
    return res.status(out.ok ? 200 : 400).json(out);
  }
  if (op === 'pushunsubscribe') {
    const out = await push.removeSubscription(body.endpoint || (body.subscription && body.subscription.endpoint));
    return res.status(out.ok ? 200 : 400).json(out);
  }
  return res.status(400).json({ ok: false, error: `unknown push op ${op}` });
}

module.exports = { runPushOp };
