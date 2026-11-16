// ---------------------------------------------------------------- visual editor
// Built from Home Assistant's own <ha-form> so every picker looks and behaves like the rest of HA.
const S = {
  entity: (domain) => ({entity: {domain}}),
  text: {text: {}},
  bool: {boolean: {}},
  time: {time: {}},
};

class HaMessengerCardEditor extends HTMLElement {
  constructor() { super(); this._open = new Set(['general']); }

  setConfig(config) { this._config = JSON.parse(JSON.stringify(config || {})); this._render(); }
  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._render();
    else this.shadowRoot?.querySelectorAll('ha-form').forEach(f => { f.hass = hass; });
  }

  connectedCallback() { this._ensureHaForm().then(() => this._render()); }

  // ha-form is lazy-loaded by Home Assistant. Asking a built-in card for its editor pulls it in.
  async _ensureHaForm() {
    if (customElements.get('ha-form') && customElements.get('ha-entity-picker')) return;
    try {
      const helpers = await window.loadCardHelpers?.();
      const card = await helpers?.createCardElement({type: 'entities', entities: []});
      await card?.constructor?.getConfigElement?.();
    } catch {}
    await Promise.race([customElements.whenDefined('ha-form'), sleep(4000)]);
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {detail: {config: this._config}, bubbles: true, composed: true}));
  }
  _set(path, value) {
    const keys = path.split('.');
    let o = this._config;
    for (const k of keys.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {});
    if (value === undefined || value === '' || value === null) delete o[keys.at(-1)]; else o[keys.at(-1)] = value;
    this._fire();
  }

  _notifyOptions() {
    const svcs = Object.keys(this._hass?.services?.notify || {}).filter(s => !['notify', 'send_message', 'persistent_notification'].includes(s));
    return svcs.sort((a, b) => (b.startsWith('mobile_app_') - a.startsWith('mobile_app_')) || a.localeCompare(b)).map(s => ({value: s, label: s.replace(/^mobile_app_/, '📱 ').replace(/_/g, ' ')}));
  }
  _guessNotify(personId) {
    const st = this._hass?.states[personId];
    const trackers = st?.attributes?.device_trackers || [];
    const svcs = Object.keys(this._hass?.services?.notify || {});
    for (const t of trackers) { const s = `mobile_app_${t.replace(/^device_tracker\./, '')}`; if (svcs.includes(s)) return s; }
    const nm = norm(first(st?.attributes?.friendly_name));
    return svcs.find(s => s.startsWith('mobile_app_') && norm(s).includes(nm)) || '';
  }

  // ---- schemas
  _generalSchema() {
    return [
      {name: 'title', selector: S.text},
      {name: 'storage_entity', required: true, selector: S.entity('todo')},
      {type: 'grid', name: '', schema: [
        {name: 'appearance', selector: {select: {mode: 'dropdown', options: [{value: 'dark', label: 'Messenger dark'}, {value: 'theme', label: 'Follow my HA theme'}]}}},
        {name: 'height', selector: S.text},
      ]},
      {name: 'open_path', selector: S.text},
    ];
  }
  _personSchema() {
    return [
      {name: 'person', required: true, selector: S.entity('person')},
      {name: 'name', selector: S.text},
      {name: 'speaker', selector: S.entity('media_player')},
      {name: 'notify', selector: {select: {mode: 'dropdown', custom_value: true, options: this._notifyOptions()}}},
      {type: 'grid', name: '', schema: [
        {name: 'quiet_hours', selector: S.bool},
        {name: 'in_broadcast', selector: S.bool},
        {name: 'phone_tts', selector: S.bool},
      ]},
      {name: 'broadcast_to', selector: {select: {mode: 'dropdown', options: [
        {value: 'auto', label: 'Speaker when home, phone when away'}, {value: 'speaker', label: 'Speaker only'},
        {value: 'phone', label: 'Phone only'}, {value: 'both', label: 'Speaker and phone'}]}}},
    ];
  }
  _roomSchema() {
    return [
      {type: 'grid', name: '', schema: [{name: 'name', required: true, selector: S.text}, {name: 'icon', selector: S.text}]},
      {name: 'speaker', required: true, selector: S.entity('media_player')},
      {type: 'grid', name: '', schema: [{name: 'quiet_hours', selector: S.bool}, {name: 'in_broadcast', selector: S.bool}]},
    ];
  }
  _speechSchema() {
    const hasChime = !!this._hass?.services?.chime_tts;
    return [
      {name: 'engine', selector: S.entity('tts')},
      {type: 'grid', name: '', schema: [{name: 'language', selector: S.text}, {name: 'voice', selector: S.text}]},
      {name: 'prefix_sender', selector: S.bool},
      {name: 'chime_tts', selector: {select: {mode: 'dropdown', options: [
        {value: 'auto', label: hasChime ? 'Use Chime TTS (installed)' : 'Use Chime TTS if installed (not found)'},
        {value: 'off', label: 'Don\'t use Chime TTS'}]}}},
      ...(hasChime ? [{type: 'grid', name: '', schema: [{name: 'chime', selector: S.text}, {name: 'announce', selector: S.bool}]}] : []),
    ];
  }
  _quietSchema() {
    return [
      {name: 'enabled', selector: S.bool},
      {type: 'grid', name: '', schema: [{name: 'start', selector: S.time}, {name: 'end', selector: S.time}]},
      {name: 'days', selector: {select: {multiple: true, mode: 'list', options: WEEKDAYS.map(([v, l]) => ({value: String(v), label: l}))}}},
    ];
  }
  _featureSchema() {
    return [{type: 'grid', name: '', schema: [
      {name: 'photos', selector: S.bool}, {name: 'voice_notes', selector: S.bool}, {name: 'reactions', selector: S.bool},
      {name: 'read_receipts', selector: S.bool}, {name: 'urgent', selector: S.bool},
    ]}];
  }
  _extraSchema() {
    return [
      {name: 'quick_messages', selector: {text: {multiline: true}}},
      {name: 'emojis', selector: S.text},
      {type: 'grid', name: '', schema: [
        {name: 'max_messages', selector: {number: {min: 20, max: 2000, step: 10, mode: 'box'}}},
        {name: 'retention_days', selector: {number: {min: 0, max: 3650, step: 1, mode: 'box', unit_of_measurement: 'days'}}},
      ]},
      {type: 'grid', name: '', schema: [
        {name: 'b_enabled', selector: S.bool}, {name: 'b_name', selector: S.text}, {name: 'b_icon', selector: S.text},
      ]},
    ];
  }

  _label = s => ({
    title: 'Card title', storage_entity: 'Storage (Local To-do list)', appearance: 'Look', height: 'Height (e.g. 600 or 80vh)',
    open_path: 'Open this page from phone notifications (e.g. /lovelace/messages)',
    person: 'Person', name: s.name === 'name' && this._ctx === 'room' ? 'Room name' : 'Display name (optional)', speaker: 'Their speaker', notify: 'Their phone (notify action)',
    quiet_hours: 'Respect quiet hours', in_broadcast: `Include in "${this._config.broadcast?.name || 'Everyone'}"`, phone_tts: 'Speak aloud on phone (Android)',
    broadcast_to: 'How group messages reach them', icon: 'Emoji or mdi: icon',
    engine: 'Text-to-speech service', language: 'Language (optional, e.g. en-GB)', voice: 'Voice (optional)', prefix_sender: 'Say who it\'s from ("Carl says…")',
    chime_tts: 'Chime TTS', chime: 'Chime sound', announce: 'Duck music while speaking',
    enabled: 'Quiet hours on', start: 'From', end: 'Until', days: 'Days',
    photos: 'Photos', voice_notes: 'Voice notes (admins)', reactions: 'Reactions', read_receipts: 'Read receipts', urgent: 'Urgent button',
    quick_messages: 'Quick replies (one per line)', emojis: 'Reaction emojis (space separated)', max_messages: 'Messages to show',
    retention_days: 'Delete messages older than (0 = keep)', b_enabled: 'Group chat', b_name: 'Group name', b_icon: 'Group icon',
  }[s.name] ?? s.name);

  _helper = s => ({
    storage_entity: 'Every message, reaction and read receipt is stored here. Anyone who can open this list can read it.',
    notify: 'Picked automatically from their companion app when possible.',
    engine: 'Used when Chime TTS isn\'t installed, or to choose its voice platform.',
    retention_days: 'Old messages are tidied up automatically.',
  }[s.name]);

  _form(schema, data, onChange, ctx) {
    const f = document.createElement('ha-form');
    f.hass = this._hass; f.schema = schema; f.data = data;
    f.computeLabel = s => { this._ctx = ctx; return this._label(s); };
    f.computeHelper = s => this._helper(s);
    f.addEventListener('value-changed', e => { e.stopPropagation(); onChange(e.detail.value); });
    return f;
  }

  _section(id, title, sub, body) {
    const d = document.createElement('details');
    d.className = 'sec'; d.open = this._open.has(id);
    d.addEventListener('toggle', () => { if (d.open) this._open.add(id); else this._open.delete(id); });
    d.innerHTML = `<summary><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span></summary>`;
    const inner = document.createElement('div'); inner.className = 'body';
    body.forEach(b => inner.append(b)); d.append(inner);
    return d;
  }

  _listItem(kind, i, total, title, sub, form) {
    const box = document.createElement('div'); box.className = 'item';
    box.innerHTML = `<div class="ih"><span class="it">${esc(title)}</span><span class="is">${esc(sub)}</span>
      <button class="ib" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
      <button class="ib" data-act="down" ${i === total - 1 ? 'disabled' : ''} title="Move down">▼</button>
      <button class="ib del" data-act="del" title="Remove">✕</button></div>`;
    box.querySelector('.ih').addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
      const list = [...(this._config[kind] || [])];
      if (act === 'del') list.splice(i, 1);
      if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      this._config[kind] = list; this._fire(); this._render();
    });
    box.append(form);
    return box;
  }

  _btn(label, onClick, cls = '') { const b = document.createElement('button'); b.className = `add ${cls}`; b.textContent = label; b.addEventListener('click', onClick); return b; }
  _note(html, cls = '') { const n = document.createElement('div'); n.className = `note ${cls}`; n.innerHTML = html; return n; }

  _render() {
    if (!this._config || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({mode: 'open'});
    const root = this.shadowRoot;
    if (!customElements.get('ha-form')) { root.innerHTML = '<p style="padding:16px">Loading editor…</p>'; return; }
    const c = this._config, h = this._hass;
    root.innerHTML = `<style>${EDITOR_CSS}</style>`;
    const wrap = document.createElement('div'); wrap.className = 'ed'; root.append(wrap);

    // General + storage
    const gen = [this._form(this._generalSchema(), {title: 'Messages', appearance: 'dark', ...c}, v => {
      for (const k of ['title', 'storage_entity', 'appearance', 'height', 'open_path']) this._set(k, v[k]);
    })];
    const todos = Object.keys(h.states).filter(e => e.startsWith('todo.'));
    if (!c.storage_entity) {
      gen.unshift(this._note(`<b>Step 1:</b> messages are saved in a Local To-do list. ${todos.length ? 'Pick one below, or ' : ''}<a href="/config/integrations/dashboard/add?domain=local_todo" target="_blank" rel="noopener">create a new list called “Messenger”</a>, then come back and pick it.`, 'warn'));
    } else if (!h.states[c.storage_entity]) gen.unshift(this._note(`<code>${esc(c.storage_entity)}</code> wasn't found.`, 'warn'));
    else if (h.states[c.storage_entity]?.attributes?.supported_features != null && (h.states[c.storage_entity].attributes.supported_features & 1) === 0) {
      gen.unshift(this._note('This to-do list can\'t add items. Use a <b>Local To-do</b> list.', 'warn'));
    }
    wrap.append(this._section('general', 'General', c.storage_entity ? c.storage_entity : 'Choose where messages are stored', gen));

    // People
    const people = c.people || [];
    const peopleBody = people.map((p, i) => this._listItem('people', i, people.length,
      p.name || h.states[p.person]?.attributes?.friendly_name || p.person || 'New person',
      [p.speaker && '🔊', p.notify && '📱'].filter(Boolean).join(' ') || 'not set up',
      this._form(this._personSchema(), {quiet_hours: true, in_broadcast: true, phone_tts: false, broadcast_to: 'auto', ...p}, v => {
        const list = [...(this._config.people || [])];
        const prevPerson = list[i]?.person;
        const next = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null));
        if (next.person && next.person !== prevPerson && !next.notify) { const g = this._guessNotify(next.person); if (g) next.notify = g; }
        list[i] = next; this._config.people = list; this._fire();
        if (next.person !== prevPerson) this._render();
      }, 'person')));
    const allPeople = Object.keys(h.states).filter(e => e.startsWith('person.'));
    const missing = allPeople.filter(e => !people.some(p => p.person === e));
    if (missing.length) peopleBody.push(this._btn(`+ Add ${missing.length > 1 ? `all ${missing.length} people` : h.states[missing[0]]?.attributes?.friendly_name || 'person'}`, () => {
      this._config.people = [...people, ...missing.map(person => ({person, ...(this._guessNotify(person) ? {notify: this._guessNotify(person)} : {})}))];
      this._fire(); this._open.add('people'); this._render();
    }));
    peopleBody.push(this._btn('+ Add a person', () => { this._config.people = [...people, {person: ''}]; this._fire(); this._open.add('people'); this._render(); }, 'ghost'));
    peopleBody.unshift(this._note('Each person gets a private two-way chat. Messages go to their speaker when they\'re home and their phone when they\'re out. People log in with their own Home Assistant account; the card works out who is sending.'));
    wrap.append(this._section('people', 'People', `${people.length} ${people.length === 1 ? 'person' : 'people'}`, peopleBody));

    // Rooms
    const rooms = c.rooms || [];
    const roomBody = rooms.map((r, i) => this._listItem('rooms', i, rooms.length, `${r.icon && !String(r.icon).startsWith('mdi:') ? r.icon + ' ' : ''}${r.name || 'New room'}`, r.speaker ? '🔊' : 'no speaker',
      this._form(this._roomSchema(), {quiet_hours: true, in_broadcast: true, icon: '🔊', ...r}, v => {
        const list = [...(this._config.rooms || [])];
        list[i] = {...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null)), id: list[i]?.id || `room_${uuid().slice(0, 8)}`};
        this._config.rooms = list; this._fire();
      }, 'room')));
    roomBody.unshift(this._note('Rooms are shared chats that speak on a speaker, like “Kitchen” or “Kids’ room”.'));
    roomBody.push(this._btn('+ Add a room', () => { this._config.rooms = [...rooms, {id: `room_${uuid().slice(0, 8)}`, name: '', icon: '🔊'}]; this._fire(); this._open.add('rooms'); this._render(); }, 'ghost'));
    wrap.append(this._section('rooms', 'Rooms', `${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'}`, roomBody));

    // Speech
    const tts = {...DEFAULTS.tts, ...(c.tts || {})};
    const speech = [this._form(this._speechSchema(), tts, v => { this._config.tts = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null)); this._fire(); })];
    if (!Object.keys(h.states).some(e => e.startsWith('tts.'))) speech.unshift(this._note('No text-to-speech service found. Add one (for example Google Translate, Piper or Home Assistant Cloud) so speakers can read messages out.', 'warn'));
    wrap.append(this._section('speech', 'Speakers & voice', h.services?.chime_tts ? 'Chime TTS' : (tts.engine || 'automatic'), speech));

    // Quiet hours
    const q = {...DEFAULTS.quiet_hours, ...(c.quiet_hours || {})};
    wrap.append(this._section('quiet', 'Quiet hours', q.enabled ? `${hhmm(q.start)}–${hhmm(q.end)}` : 'off', [
      this._note('During quiet hours speakers chime instead of talking (with Chime TTS), or stay silent and send a phone alert instead. The Urgent button overrides it.'),
      this._form(this._quietSchema(), {...q, days: (q.days || []).map(String)}, v => {
        this._config.quiet_hours = {enabled: !!v.enabled, start: hhmm(v.start) || q.start, end: hhmm(v.end) || q.end, days: (v.days || []).map(Number).sort()};
        this._fire();
      }),
    ]));

    // Features & extras
    wrap.append(this._section('features', 'Features', Object.entries({...DEFAULTS.features, ...(c.features || {})}).filter(([, v]) => v).length + ' on', [
      this._form(this._featureSchema(), {...DEFAULTS.features, ...(c.features || {})}, v => { this._config.features = v; this._fire(); }),
    ]));
    const b = {...DEFAULTS.broadcast, ...(c.broadcast || {})};
    wrap.append(this._section('extras', 'Group chat, quick replies & tidy-up', '', [
      this._form(this._extraSchema(), {
        quick_messages: (c.quick_messages ?? DEFAULT_QUICK).join('\n'), emojis: (c.emojis ?? DEFAULT_EMOJIS).join(' '),
        max_messages: c.max_messages ?? DEFAULTS.max_messages, retention_days: c.retention_days ?? DEFAULTS.retention_days,
        b_enabled: b.enabled !== false, b_name: b.name, b_icon: b.icon,
      }, v => {
        this._config.quick_messages = String(v.quick_messages || '').split('\n').map(s => s.trim()).filter(Boolean);
        this._config.emojis = String(v.emojis || '').split(/\s+/).filter(Boolean);
        this._config.max_messages = Number(v.max_messages) || DEFAULTS.max_messages;
        this._config.retention_days = Number(v.retention_days) || 0;
        this._config.broadcast = {enabled: !!v.b_enabled, name: v.b_name || 'Everyone', icon: v.b_icon || '📢'};
        this._fire();
      }),
    ]));
    wrap.append(this._note(`HA Messenger ${VERSION} · <a href="https://github.com/carlosamus123/HA-Messenger" target="_blank" rel="noopener">docs</a> · <a href="https://ko-fi.com/northstarcreations" target="_blank" rel="noopener">☕ support on Ko-fi</a>`, 'foot'));
  }
}

const EDITOR_CSS = `
  .ed { display:flex; flex-direction:column; gap:10px; }
  .sec { border:1px solid var(--divider-color); border-radius:12px; background:var(--card-background-color); overflow:hidden; }
  .sec > summary { list-style:none; cursor:pointer; padding:14px 16px; display:flex; align-items:baseline; gap:10px; }
  .sec > summary::-webkit-details-marker { display:none; }
  .sec > summary::before { content:'›'; display:inline-block; transition:transform .15s; color:var(--secondary-text-color); font-size:18px; line-height:1; }
  .sec[open] > summary::before { transform:rotate(90deg); }
  .sec .t { font-weight:600; font-size:15px; }
  .sec .s { margin-left:auto; color:var(--secondary-text-color); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:55%; }
  .body { padding:0 16px 16px; display:flex; flex-direction:column; gap:12px; }
  .item { border:1px solid var(--divider-color); border-radius:10px; padding:10px 12px 12px; background:var(--secondary-background-color, transparent); }
  .ih { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
  .it { font-weight:600; }
  .is { color:var(--secondary-text-color); font-size:12px; margin-right:auto; }
  .ib { border:0; background:none; color:var(--secondary-text-color); cursor:pointer; padding:4px 7px; border-radius:6px; font-size:12px; }
  .ib:hover:not(:disabled) { background:var(--divider-color); color:var(--primary-text-color); }
  .ib:disabled { opacity:.3; cursor:default; }
  .ib.del:hover { color:var(--error-color, #db4437); }
  .add { align-self:flex-start; border:1px solid var(--primary-color); color:var(--primary-color); background:none; border-radius:18px; padding:7px 14px; cursor:pointer; font:inherit; font-weight:500; }
  .add:hover { background:rgba(var(--rgb-primary-color, 3,169,244), .08); }
  .add.ghost { border-style:dashed; }
  .note { font-size:13px; line-height:1.45; color:var(--secondary-text-color); }
  .note.warn { color:var(--primary-text-color); background:rgba(var(--rgb-warning-color, 255,166,0), .14); border-left:3px solid var(--warning-color, #ffa600); padding:10px 12px; border-radius:6px; }
  .note.foot { text-align:center; font-size:12px; padding:4px; }
  .note a { color:var(--primary-color); }
  code { background:var(--secondary-background-color); padding:1px 5px; border-radius:4px; }
`;
