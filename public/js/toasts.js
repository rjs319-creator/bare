// 🔔 IN-APP TOASTS — a thin wrapper over the vendored Notyf (public/js/vendor/notyf-3.10.0.min.js,
// classic script → window.Notyf; its stylesheet is inlined in app.css). Two jobs:
//   • toast(kind, message) for any module (session-board grade changes, push mirror, SW update).
//   • initServiceWorkerMessages(): the SW posts {type:'push'} when a Web Push lands while a tab is
//     open and {type:'sw-activated'} when a new worker VERSION takes over → toasts.
// Everything degrades silently when Notyf is absent (tests, blocked script) — a toast is never
// worth an exception.
const DURATION_MS = 7000;
const TYPES = [
  { type: 'info', background: '#111e38', icon: false, duration: DURATION_MS, dismissible: true },
  { type: 'good', background: '#0f3d2a', icon: false, duration: DURATION_MS, dismissible: true },
  { type: 'warn', background: '#4a2f0a', icon: false, duration: DURATION_MS, dismissible: true },
  { type: 'update', background: '#0d1628', icon: false, duration: 0, dismissible: true, ripple: false },
];

let instance = null;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function notyf() {
  if (instance) return instance;
  const Notyf = globalThis.Notyf;
  if (typeof Notyf !== 'function' || typeof document === 'undefined') return null;
  try {
    instance = new Notyf({ position: { x: 'right', y: 'top' }, types: TYPES });
    return instance;
  } catch { return null; }
}

/**
 * @param {'info'|'good'|'warn'|'update'} kind
 * @param {string} message  plain text (escaped); `title` is bolded in front of it
 * @returns {object|null} the Notyf notification (has .on('click', fn)) or null
 */
export function toast(kind, message, { title = '', onClick = null } = {}) {
  const n = notyf();
  if (!n) return null;
  const type = TYPES.some((t) => t.type === kind) ? kind : 'info';
  const html = `${title ? `<b>${esc(title)}</b> ` : ''}${esc(message)}`;
  try {
    const note = n.open({ type, message: html });
    if (onClick && note && typeof note.on === 'function') note.on('click', () => { try { onClick(); } catch {} });
    return note;
  } catch { return null; }
}

// Pure: turn a service-worker message into a toast spec (or null). Exported for tests.
export function toastForSwMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'push') {
    const body = String(data.body || '').trim();
    const title = String(data.title || 'Market Signal').trim();
    return { kind: data.kind === 'early_watch' ? 'info' : 'good', title, message: body || 'New alert', url: data.url || null };
  }
  if (data.type === 'sw-activated' && data.isUpdate) {
    return { kind: 'update', title: 'Update ready', message: `Version ${String(data.version || '').slice(0, 24)} is installed — tap to reload.`, reload: true };
  }
  return null;
}

export function initServiceWorkerMessages({ onReload = () => location.reload(), onOpenUrl = (u) => { location.hash = String(u).replace(/^[^#]*/, ''); } } = {}) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const spec = toastForSwMessage(ev && ev.data);
    if (!spec) return;
    const onClick = spec.reload ? onReload : (spec.url ? () => onOpenUrl(spec.url) : null);
    toast(spec.kind, spec.message, { title: spec.title, onClick });
  });
  return true;
}
