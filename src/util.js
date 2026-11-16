// ---------------------------------------------------------------- shared helpers
const TAG = 'ha-messenger-card';
const EDITOR_TAG = 'ha-messenger-card-editor';
const VERSION = '__VERSION__';
const LS = 'ha-messenger';

const DEFAULT_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '🎉'];
const DEFAULT_QUICK = ['Dinner is ready', 'Please come downstairs', 'Leaving in 5 minutes'];
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

const DEFAULTS = {
  title: 'Messages',
  storage_entity: '',
  appearance: 'dark',
  height: '',
  open_path: '',
  people: [],
  rooms: [],
  broadcast: {enabled: true, name: 'Everyone', icon: '📢'},
  tts: {engine: '', language: '', voice: '', prefix_sender: true, chime_tts: 'auto', chime: 'bells', announce: true},
  quiet_hours: {enabled: false, start: '22:00', end: '07:00', days: [1, 2, 3, 4, 5, 6, 7]},
  features: {photos: true, voice_notes: true, reactions: true, read_receipts: true, urgent: true},
  quick_messages: DEFAULT_QUICK,
  emojis: DEFAULT_EMOJIS,
  max_messages: 300,
  retention_days: 90,
};

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const safeUrl = v => { try { const u = new URL(v, location.href); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const first = v => String(v || '').trim().split(/\s+/)[0] || '';
const slug = v => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'room';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clip = (v, n) => { const a = Array.from(String(v || '')); return a.length <= n ? a.join('') : a.slice(0, n - 1).join('') + '…'; };
const hueFor = name => { let h = 7; for (const c of norm(first(name))) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const uuid = () => globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
const lsGet = k => { try { return localStorage.getItem(`${LS}::${k}`); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(`${LS}::${k}`, v); } catch {} };
const hhmm = v => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
const isEntity = (v, domain) => typeof v === 'string' && new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(v);
const notifyName = v => { const s = String(v || '').replace(/^notify\./, ''); return /^[a-z0-9_]+$/.test(s) ? s : ''; };

// Fill defaults and tidy a user config so the rest of the card can trust its shape.
function normalizeConfig(raw = {}) {
  const c = {...DEFAULTS, ...raw};
  c.broadcast = {...DEFAULTS.broadcast, ...(raw.broadcast || {})};
  c.tts = {...DEFAULTS.tts, ...(raw.tts || {})};
  c.quiet_hours = {...DEFAULTS.quiet_hours, ...(raw.quiet_hours || {})};
  c.quiet_hours.start = hhmm(c.quiet_hours.start) || DEFAULTS.quiet_hours.start;
  c.quiet_hours.end = hhmm(c.quiet_hours.end) || DEFAULTS.quiet_hours.end;
  c.quiet_hours.days = (Array.isArray(c.quiet_hours.days) ? c.quiet_hours.days : DEFAULTS.quiet_hours.days).map(Number).filter(d => d >= 1 && d <= 7);
  c.features = {...DEFAULTS.features, ...(raw.features || {})};
  if (!Array.isArray(c.people)) throw new Error('people must be a list');
  if (!Array.isArray(c.rooms)) throw new Error('rooms must be a list');
  const seen = new Set();
  c.people = c.people.filter(p => p && isEntity(p.person, 'person')).filter(p => !seen.has(p.person) && seen.add(p.person)).map(p => ({
    quiet_hours: true, in_broadcast: true, broadcast_to: 'auto', phone_tts: false, ...p,
  }));
  const ids = new Set();
  c.rooms = c.rooms.filter(r => r && (r.name || r.id)).map(r => {
    let id = String(r.id || `room_${slug(r.name)}`);
    while (ids.has(id)) id += '_2';
    ids.add(id);
    return {icon: '🔊', quiet_hours: true, in_broadcast: true, ...r, id, name: r.name || id};
  });
  c.quick_messages = Array.isArray(c.quick_messages) ? c.quick_messages.map(String).filter(Boolean) : [];
  c.emojis = Array.isArray(c.emojis) && c.emojis.length ? c.emojis.map(String) : DEFAULT_EMOJIS;
  c.max_messages = Math.max(20, Number(c.max_messages) || 300);
  c.retention_days = Math.max(0, Number(c.retention_days) || 0);
  return c;
}

// Is "now" inside quiet hours? Days are ISO weekdays (Mon=1); an overnight window belongs to the day it started.
function inQuietHours(q, zone, now = new Date()) {
  if (!q?.enabled) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {...(zone ? {timeZone: zone} : {}), weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
    .formatToParts(now).map(p => [p.type, p.value]));
  const day = {Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7}[parts.weekday];
  const mins = v => { const [h, m] = hhmm(v).split(':').map(Number); return h * 60 + m; };
  const start = mins(q.start), end = mins(q.end), cur = Number(parts.hour) * 60 + Number(parts.minute);
  if (start === end) return false;
  if (start < end) return q.days.includes(day) && cur >= start && cur < end;
  if (cur >= start) return q.days.includes(day);
  if (cur < end) return q.days.includes(day === 1 ? 7 : day - 1);
  return false;
}

const I = {
  send: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6l-.01 6.53L15 12 3.39 13.87z"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13.2 2 4.6 13.4h6.2L9.8 22l8.6-11.4h-6.2z"/></svg>',
  smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2"/><circle cx="9" cy="9.5" r=".8" fill="currentColor"/><circle cx="15" cy="9.5" r=".8" fill="currentColor"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
};
