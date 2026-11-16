// ---------------------------------------------------------------- the card
class HaMessengerCard extends HTMLElement {
  constructor() {
    super();
    this._items = [];          // raw to-do items
    this._msgs = [];           // parsed messages, oldest first
    this._reactions = {};      // message id -> [{emoji, by, uid}]
    this._seenBy = {};         // person entity -> {ts, uid}
    this._pending = [];
    this._attachments = [];
    this._status = {};
    this._rendered = new Set();
    this._showTime = new Set();
    this._stick = true;
    this._urgent = false;
  }

  static getConfigElement() { return document.createElement(EDITOR_TAG); }
  static getStubConfig(hass) {
    const people = Object.keys(hass?.states || {}).filter(e => e.startsWith('person.')).slice(0, 4).map(person => ({person}));
    const storage = Object.keys(hass?.states || {}).find(e => e.startsWith('todo.') && /messeng|intercom|message/i.test(e)) || '';
    return {title: 'Messages', storage_entity: storage, people, rooms: []};
  }
  getCardSize() { return 12; }
  getGridOptions() { return {columns: 'full', rows: 'auto', min_rows: 6}; }

  setConfig(config) {
    if (!config) throw new Error('Missing configuration');
    this.config = normalizeConfig(config);
    this.setAttribute('appearance', this.config.appearance === 'theme' ? 'theme' : 'dark');
    this._threadList = null;
    if (this.shadowRoot) { this._applyHeight(); this._chromeSig = ''; this._resubscribe(); if (this._hass) this.hass = this._hass; }
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this.config) return;
    if (!this.shadowRoot) this._build();
    this._meCache = null;
    const me = this._me();
    if (this._meKey !== (me.id || 'anon')) {
      this._meKey = me.id || 'anon';
      this._threadList = null;
      this._loadSeen();
      this._active = this._initialThread();
      this._stick = true;
      this._chromeSig = '';
    }
    if (!this._unsub && !this._subscribing) this._subscribe();
    const s = this.config.storage_entity;
    if (this._polling && prev && prev.states[s] !== hass.states[s]) this._scheduleLoad(300);
    const sig = this._chromeSignature();
    if (sig !== this._chromeSig) { this._chromeSig = sig; this._renderThreads(); this._renderHeader(); this._renderStream(); }
    this._renderComposerState();
  }
  get hass() { return this._hass; }

  connectedCallback() {
    if (this._hass && this.shadowRoot && !this._unsub && !this._subscribing) this._subscribe();
    this._tick = setInterval(() => { if (this._hass) { this._chromeSig = ''; this.hass = this._hass; } }, 60000);
  }
  disconnectedCallback() {
    clearInterval(this._tick); clearTimeout(this._loadTimer);
    this._unsubscribe();
    if (this._audio) { this._audio.pause(); this._audio = null; }
  }

  // ---------------------------------------------------------------- storage (one Local To-do list)
  // Every message, reaction and read receipt is its own to-do item with a JSON description, so
  // two people reacting at once never overwrite each other. Live updates come from todo/item/subscribe.
  async _subscribe() {
    const entity = this.config.storage_entity;
    if (!this._hass || !isEntity(entity, 'todo') || !this._hass.states[entity]) { this._renderStream(); return; }
    this._subscribing = true;
    const token = this._subToken = (this._subToken || 0) + 1;
    try {
      const unsub = await this._hass.connection.subscribeMessage(msg => {
        if (token !== this._subToken) return;
        this._ingest(msg?.items || []);
      }, {type: 'todo/item/subscribe', entity_id: entity});
      if (token !== this._subToken) { unsub(); return; }
      this._unsub = unsub; this._polling = false;
    } catch (e) {
      // Older Home Assistant or a list that doesn't support live updates: fall back to polling.
      console.warn('[ha-messenger] live updates unavailable, polling instead', e);
      this._polling = true; this._unsub = () => {};
      this._scheduleLoad(0);
    } finally { this._subscribing = false; }
  }
  _unsubscribe() { this._subToken = (this._subToken || 0) + 1; try { this._unsub?.(); } catch {} this._unsub = null; }
  _resubscribe() { this._unsubscribe(); this._items = []; this._msgs = []; this._reactions = {}; this._seenBy = {}; this._loaded = false; if (this._hass) this._subscribe(); }
  _scheduleLoad(delay) { clearTimeout(this._loadTimer); this._loadTimer = setTimeout(() => this._load(), delay); }
  async _load() {
    const entity = this.config.storage_entity;
    if (!this._hass || !entity) return;
    try {
      const res = await this._hass.callWS({type: 'call_service', domain: 'todo', service: 'get_items', target: {entity_id: entity},
        service_data: {status: ['needs_action', 'completed']}, return_response: true});
      this._ingest((res?.response || res)?.[entity]?.items || []);
    } catch (e) { this._loadError = e.message || String(e); this._renderStream(); }
  }

  _ingest(items) {
    this._items = items;
    const msgs = [], rx = {}, seen = {};
    for (const it of items) {
      let d;
      try { d = JSON.parse(String(it.description || '')); } catch { continue; }
      if (!d || d.hm !== 2) continue;
      if (d.t === 'msg' && typeof d.id === 'string' && Number.isFinite(d.ts) && d.to?.kind) {
        msgs.push({id: d.id, uid: it.uid, ts: d.ts, from: d.from || {}, to: d.to, text: String(d.text || ''), img: d.img || '', voice: d.voice || '',
          urgent: !!d.urgent, quiet: !!d.quiet, via: d.via || ''});
      } else if (d.t === 'rx' && d.msg && d.emoji) {
        (rx[d.msg] ||= []).push({emoji: String(d.emoji), by: d.by || {}, uid: it.uid});
      } else if (d.t === 'seen' && d.person && Number.isFinite(d.ts)) {
        if (!seen[d.person] || seen[d.person].ts < d.ts) seen[d.person] = {ts: d.ts, uid: it.uid};
      }
    }
    msgs.sort((a, b) => a.ts - b.ts);
    this._msgs = msgs.slice(-this.config.max_messages);
    this._allMsgCount = msgs.length;
    this._reactions = rx; this._seenBy = seen; this._loaded = true; this._loadError = '';
    this._renderThreads(); this._renderStream();
    this._maybePrune(msgs, rx);
  }

  async _addItem(summary, payload) {
    await this._hass.callService('todo', 'add_item', {item: clip(summary, 200), description: JSON.stringify({hm: 2, ...payload})}, {entity_id: this.config.storage_entity});
  }
  async _removeItems(uids) {
    const list = uids.filter(Boolean);
    for (let i = 0; i < list.length; i += 50) {
      await this._hass.callService('todo', 'remove_item', {item: list.slice(i, i + 50)}, {entity_id: this.config.storage_entity});
    }
  }

  // Keep the list tidy: drop messages past the retention period (and their reactions). Runs at most every 6 hours per browser.
  async _maybePrune(msgs, rx) {
    const days = this.config.retention_days;
    if (!days || this._pruning) return;
    const key = `prune::${this.config.storage_entity}`;
    if (Date.now() - Number(lsGet(key) || 0) < 6 * 3600e3) return;
    lsSet(key, String(Date.now()));
    const cutoff = Date.now() - days * 864e5;
    const old = msgs.filter(m => m.ts < cutoff);
    const live = new Set(msgs.filter(m => m.ts >= cutoff).map(m => m.id));
    const orphanRx = Object.entries(rx).filter(([id]) => !live.has(id)).flatMap(([, list]) => list.map(r => r.uid));
    const uids = [...old.map(m => m.uid), ...orphanRx];
    if (!uids.length) return;
    this._pruning = true;
    try { await this._removeItems(uids); } catch (e) { console.warn('[ha-messenger] tidy-up failed', e); } finally { this._pruning = false; }
  }

  // ---------------------------------------------------------------- people & threads
  _personState(eid) { return this._hass?.states[eid] || null; }
  _personName(eid) { const p = this.config.people.find(x => x.person === eid); return p?.name || this._personState(eid)?.attributes?.friendly_name || String(eid || '').replace(/^person\./, ''); }
  _me() {
    if (this._meCache) return this._meCache;
    const user = this._hass?.user || {};
    let me = {id: user.id || null, name: user.name || 'Me', person: '', admin: !!user.is_admin};
    for (const [eid, st] of Object.entries(this._hass?.states || {})) {
      if (eid.startsWith('person.') && user.id && st.attributes?.user_id === user.id) { me = {...me, person: eid, name: this._personName(eid)}; break; }
    }
    return this._meCache = me;
  }
  _atHome(eid) { const st = this._personState(eid); return !!st && (st.state === 'home' || (st.attributes?.in_zones || []).includes('zone.home')); }

  _threads() {
    const me = this._me();
    if (this._threadList && this._threadKey === me.person) return this._threadList;
    const c = this.config, list = [];
    if (c.broadcast.enabled !== false) list.push({id: 'all', kind: 'all', name: c.broadcast.name || 'Everyone', icon: c.broadcast.icon || '📢'});
    for (const p of c.people) if (p.person !== me.person) list.push({id: `chat:${p.person}`, kind: 'chat', name: this._personName(p.person), icon: '👤', person: p.person, entry: p});
    for (const r of c.rooms) list.push({id: `room:${r.id}`, kind: 'room', name: r.name, icon: r.icon || '🔊', entry: r});
    this._threadKey = me.person;
    return this._threadList = list;
  }
  _thread(id) { return this._threads().find(t => t.id === id) || this._threads()[0] || null; }
  _initialThread() {
    const saved = lsGet(`thread::${this._meKey}`);
    const list = this._threads();
    return (list.find(t => t.id === saved) || list.find(t => t.kind === 'chat') || list[0])?.id || null;
  }

  _isMine(m, me = this._me()) {
    if (m.pending) return true;
    if (m.from?.user && me.id) return m.from.user === me.id;
    return !!me.person && m.from?.person === me.person;
  }
  _inThread(m, th, me = this._me()) {
    if (!th) return false;
    if (th.kind === 'all') return m.to.kind === 'all';
    if (th.kind === 'room') return m.to.kind === 'room' && m.to.id === th.entry.id;
    if (m.to.kind !== 'person') return false;
    if (this._isMine(m, me)) return m.to.id === th.person;
    return !!me.person && m.to.id === me.person && m.from?.person === th.person;
  }
  _threadMsgs(th, me = this._me()) {
    const out = this._msgs.filter(m => this._inThread(m, th, me));
    for (const p of this._pending) if (p.threadId === th.id) out.push(p);
    return out;
  }

  // Where a direct message goes right now: speaker when they're home, phone when away, unless the sender pinned one.
  _viaPref(th) { return lsGet(`via::${this._meKey}::${th.person}`) || 'auto'; }
  _setVia(th, v) { lsSet(`via::${this._meKey}::${th.person}`, v); }
  _routeFor(p, pref = 'auto') {
    const hasSpk = isEntity(p.speaker, 'media_player'), hasPhone = !!notifyName(p.notify);
    if (pref === 'both') return {speaker: hasSpk, phone: hasPhone};
    if (pref === 'speaker' && hasSpk) return {speaker: true, phone: false};
    if (pref === 'phone' && hasPhone) return {speaker: false, phone: true};
    if (hasSpk && (this._atHome(p.person) || !hasPhone)) return {speaker: true, phone: false};
    return {speaker: false, phone: hasPhone};
  }

  _quietNow() { try { return inQuietHours(this.config.quiet_hours, this._hass?.config?.time_zone); } catch { return false; } }
  _chimeTts() { const m = this.config.tts.chime_tts; return m !== 'off' && !!this._hass?.services?.chime_tts?.say && (m === 'on' || m === 'auto'); }
  _ttsEngine() { const e = this.config.tts.engine; if (isEntity(e, 'tts')) return e; return Object.keys(this._hass?.states || {}).find(k => k.startsWith('tts.')) || ''; }

  _presence(th) {
    const q = this._quietNow() && !this._urgent, until = this.config.quiet_hours.end;
    if (th.kind === 'all') {
      const n = this.config.people.filter(p => p.in_broadcast !== false && p.person !== this._me().person).length + this.config.rooms.filter(r => r.in_broadcast !== false).length;
      return {dot: 'live', text: `${n} ${n === 1 ? 'person or room' : 'people & rooms'}`};
    }
    if (th.kind === 'room') {
      const st = this._hass.states[th.entry.speaker];
      if (!st || ['unavailable', 'unknown'].includes(st.state)) return {dot: 'off', text: 'Speaker offline'};
      if (q && th.entry.quiet_hours !== false) return {dot: 'quiet', text: `Quiet hours until ${until}`};
      return {dot: st.state === 'playing' ? 'live' : 'on', text: st.state === 'playing' ? 'Speaker playing' : 'Speaker ready'};
    }
    const p = th.entry, home = this._atHome(p.person), r = this._routeFor(p, this._viaPref(th));
    if (!r.speaker && !r.phone) return {dot: 'off', text: 'No speaker or phone set up'};
    const quiet = q && p.quiet_hours !== false;
    const where = r.speaker ? 'speaker' : 'phone';
    return {dot: quiet ? 'quiet' : home ? 'on' : 'away', text: `${home ? 'At home' : 'Away'} · to ${where}${quiet ? ` · quiet until ${until}` : ''}`};
  }

  _avatar(th, size = 44, ring = '') {
    const st = th.kind === 'chat' ? this._personState(th.person) : null;
    const pic = st?.attributes?.entity_picture;
    const hue = th.kind === 'all' ? 190 : hueFor(th.name);
    const pres = this._presence(th);
    const icon = String(th.icon || '');
    const inner = pic ? `<img src="${esc(pic)}" alt="" loading="lazy">`
      : th.kind === 'chat' ? `<span class="ini">${esc((first(th.name)[0] || '?').toUpperCase())}</span>`
      : icon.startsWith('mdi:') ? `<ha-icon icon="${esc(icon)}"></ha-icon>` : `<span class="emo">${esc(icon)}</span>`;
    return `<span class="av ${ring} k-${th.kind}" style="--s:${size}px;--h:${hue}">${inner}<i class="pd pd-${pres.dot}"></i></span>`;
  }
  _senderAvatar(from, size = 28) {
    const pic = from?.person ? this._personState(from.person)?.attributes?.entity_picture : '';
    const name = from?.name || 'Someone';
    return `<span class="av sm" style="--s:${size}px;--h:${hueFor(name)}">${pic ? `<img src="${esc(pic)}" alt="" loading="lazy">` : `<span class="ini">${esc((first(name)[0] || '?').toUpperCase())}</span>`}</span>`;
  }

  _preview(m) { return m.voice ? '🎤 Voice note' : m.img ? '📷 Photo' : m.text; }
  _shortTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (now - d < 6 * 864e5) return d.toLocaleDateString([], {weekday: 'short'});
    return d.toLocaleDateString([], {day: 'numeric', month: 'short'});
  }
  _dayLabel(ts) {
    const d = new Date(ts), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    const t = d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (d.toDateString() === now.toDateString()) return `Today ${t}`;
    if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
    if (now - d < 6 * 864e5) return `${d.toLocaleDateString([], {weekday: 'long'})} ${t}`;
    return `${d.toLocaleDateString([], {weekday: 'short', day: 'numeric', month: 'short'})} ${t}`;
  }

  // ---------------------------------------------------------------- unread & read receipts
  _loadSeen() {
    try { this._seen = JSON.parse(lsGet(`seen::${this._meKey}`) || 'null'); } catch { this._seen = null; }
    if (!this._seen || typeof this._seen !== 'object') { this._seen = {__init: Date.now()}; this._saveSeen(); }
  }
  _saveSeen() { lsSet(`seen::${this._meKey}`, JSON.stringify(this._seen)); }
  _unread(th, me) {
    if (th.id === this._active && document.visibilityState === 'visible') return 0;
    const since = this._seen[th.id] || this._seen.__init || 0;
    return this._msgs.filter(m => m.ts > since && !this._isMine(m, me) && this._inThread(m, th, me)).length;
  }
  _markSeen() {
    const th = this._thread(this._active); if (!th) return;
    this._seen[th.id] = Math.max(Date.now(), ...this._threadMsgs(th).map(m => m.ts));
    this._saveSeen();
  }
  async _maybeWriteSeen() {
    const th = this._thread(this._active), me = this._me();
    if (!this.config.features.read_receipts || th?.kind !== 'chat' || !me.person || this._seenWriting || !this._hass || !this._loaded) return;
    if (document.visibilityState !== 'visible' || Date.now() - (this._lastInteract || 0) > 120000) return;
    const newest = Math.max(0, ...this._threadMsgs(th, me).filter(m => !m.pending && !this._isMine(m, me)).map(m => m.ts));
    const mine = this._seenBy[me.person];
    if (!newest || (mine && newest <= mine.ts)) return;
    this._seenWriting = true;
    const payload = {t: 'seen', person: me.person, user: me.id, ts: Date.now()};
    try {
      if (mine?.uid) await this._hass.callService('todo', 'update_item', {item: mine.uid, description: JSON.stringify({hm: 2, ...payload})}, {entity_id: this.config.storage_entity});
      else await this._addItem(`Read receipt · ${me.name}`, payload);
    } catch (e) { console.warn('[ha-messenger] could not save read receipt', e); }
    finally { setTimeout(() => { this._seenWriting = false; }, 1500); }
  }

  // ---------------------------------------------------------------- DOM
  _build() {
    this.attachShadow({mode: 'open'});
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>
      <ha-card>
        <div class="hm" id="hm">
          <aside class="side">
            <div class="side-head"><div><div class="side-title" id="title"></div><div class="side-sub">Household messages</div></div><span id="meAv"></span></div>
            <div class="list" id="list" role="listbox" aria-label="Conversations"></div>
          </aside>
          <section class="chat" id="chat">
            <div class="strip" id="strip" role="tablist" aria-label="Conversations"></div>
            <header class="chat-head" id="head"></header>
            <div class="stream-wrap">
              <div class="stream" id="stream" aria-live="polite"></div>
              <button class="jump" id="jump" hidden aria-label="Jump to newest">${I.down}<span>New messages</span></button>
              <div class="drop" id="drop" hidden><div>${I.photo}<span>Drop to attach photo</span></div></div>
            </div>
            <div class="quiet" id="quiet" hidden></div>
            <div class="tray" id="tray"></div>
            <footer class="composer" id="composer">
              <div class="c-row" id="cRow">
                <button class="cbtn" id="photoBtn" aria-label="Add photo" title="Add photo">${I.photo}</button>
                <button class="cbtn" id="micBtn" aria-label="Record voice note" title="Voice note">${I.mic}</button>
                <div class="field" id="field">
                  <textarea id="input" rows="1" enterkeyhint="send" placeholder="Message" aria-label="Message"></textarea>
                  <button class="urgent" id="urgentBtn" role="switch" aria-checked="false" title="Urgent: speak even in quiet hours">
                    <span class="u-ic">${I.bolt}</span><span class="u-tx">Urgent</span><span class="u-sw"><i></i></span>
                  </button>
                </div>
                <button class="sendbtn" id="sendBtn" aria-label="Send" disabled>${I.send}</button>
              </div>
              <div class="r-row" id="rRow" hidden>
                <button class="cbtn danger" id="recCancel" aria-label="Discard voice note">${I.trash}</button>
                <div class="rec-pill" id="recPill"><i class="rec-dot"></i><span class="rec-bars">${'<b></b>'.repeat(12)}</span><span class="rec-time" id="recTime">0:00</span><audio id="recAudio" controls hidden></audio></div>
                <button class="sendbtn" id="recAction" aria-label="Stop recording">${I.stop}</button>
              </div>
              <input type="file" id="file" accept="image/*" multiple hidden>
            </footer>
          </section>
          <div class="picker" id="picker" hidden role="menu"></div>
          <div class="lightbox" id="lightbox" hidden><button class="lb-x" aria-label="Close">${I.x}</button><img alt=""></div>
        </div>
      </ha-card>`;
    this._applyHeight();
    this._wire();
  }
  _applyHeight() {
    const card = this.shadowRoot?.querySelector('ha-card'); if (!card) return;
    const h = this.config.height;
    card.style.height = typeof h === 'number' || /^\d+$/.test(String(h)) ? `${h}px` : (h || 'calc(100dvh - var(--header-height, 56px) - 20px)');
    this.shadowRoot.getElementById('title').textContent = this.config.title;
  }

  _wire() {
    const $ = id => this.shadowRoot.getElementById(id);
    const input = $('input');
    const coarse = matchMedia('(pointer: coarse)').matches;
    input.addEventListener('input', () => { this._autosize(); this._renderComposerState(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (!coarse || e.ctrlKey || e.metaKey)) { e.preventDefault(); this._send(); }
    });
    $('sendBtn').addEventListener('click', () => this._send());
    $('urgentBtn').addEventListener('click', () => { this._urgent = !this._urgent; this._chromeSig = ''; this.hass = this._hass; });
    $('photoBtn').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', e => { for (const f of e.target.files || []) this._addImage(f); e.target.value = ''; });
    $('micBtn').addEventListener('click', () => this._startRecording());
    $('recCancel').addEventListener('click', () => this._cancelRecording());
    $('recAction').addEventListener('click', () => this._voice?.recording ? this._stopRecording() : this._sendVoice());

    $('hm').addEventListener('paste', e => {
      if (!this.config.features.photos) return;
      const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault(); files.forEach(f => this._addImage(f)); input.focus();
    });
    const chat = $('chat');
    let depth = 0;
    chat.addEventListener('dragenter', e => { if (this.config.features.photos && [...(e.dataTransfer?.types || [])].includes('Files')) { depth++; $('drop').hidden = false; } });
    chat.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
    chat.addEventListener('dragover', e => e.preventDefault());
    chat.addEventListener('drop', e => {
      e.preventDefault(); depth = 0; $('drop').hidden = true;
      if (this.config.features.photos) [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/')).forEach(f => this._addImage(f));
    });

    const active = () => { this._lastInteract = Date.now(); clearTimeout(this._seenDeb); this._seenDeb = setTimeout(() => this._maybeWriteSeen(), 400); };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) this.shadowRoot.addEventListener(ev, active, {passive: true});
    const stream = $('stream');
    stream.addEventListener('scroll', () => {
      this._stick = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
      if (this._stick) $('jump').hidden = true;
      this._closePicker();
    }, {passive: true});
    $('jump').addEventListener('click', () => this._scrollBottom(true));
    stream.addEventListener('click', e => this._onStreamClick(e));
    stream.addEventListener('contextmenu', e => {
      const b = e.target.closest('.bubble'); if (!b || e.target.closest('a')) return;
      e.preventDefault(); this._openPicker(b.closest('.row'));
    });
    let lp = null;
    stream.addEventListener('pointerdown', e => {
      const b = e.target.closest('.bubble'); if (!b || e.pointerType === 'mouse') return;
      lp = {t: setTimeout(() => { this._suppressClick = true; this._openPicker(b.closest('.row')); navigator.vibrate?.(12); }, 430), sx: e.clientX, sy: e.clientY};
    });
    const cancelLp = e => { if (!lp) return; if (e.type === 'pointermove' && Math.hypot(e.clientX - lp.sx, e.clientY - lp.sy) < 8) return; clearTimeout(lp.t); lp = null; };
    ['pointerup', 'pointercancel', 'pointermove'].forEach(t => stream.addEventListener(t, cancelLp));

    $('picker').addEventListener('click', e => {
      if (e.target.closest('button[data-delete]')) { const id = this._pickerFor; this._closePicker(); this._deleteMessage(id); return; }
      const b = e.target.closest('button[data-e]'); if (!b) return;
      this._react(this._pickerFor, b.dataset.e); this._closePicker();
    });
    this.shadowRoot.addEventListener('pointerdown', e => {
      if (!$('picker').hidden && !e.composedPath().includes($('picker')) && !e.target.closest?.('.bubble')) this._closePicker();
    });
    $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });
    this.shadowRoot.addEventListener('keydown', e => { if (e.key === 'Escape') { $('lightbox').hidden = true; this._closePicker(); } });

    const pick = e => { const b = e.target.closest('[data-thread]'); if (b) this._selectThread(b.dataset.thread); };
    $('list').addEventListener('click', pick);
    $('strip').addEventListener('click', pick);
    $('head').addEventListener('click', e => {
      const b = e.target.closest('[data-via]'); if (!b) return;
      const th = this._thread(this._active); if (th?.kind !== 'chat') return;
      this._setVia(th, b.dataset.via); this._chromeSig = ''; this.hass = this._hass;
    });
    $('tray').addEventListener('click', e => {
      const q = e.target.closest('[data-quick]');
      if (q) { input.value = q.dataset.quick; this._autosize(); this._renderComposerState(); input.focus(); return; }
      const rm = e.target.closest('[data-rm]'); if (rm) this._removeAttachment(rm.dataset.rm);
    });
    $('quiet').addEventListener('click', e => { if (e.target.closest('[data-urgent]')) { this._urgent = true; this._chromeSig = ''; this.hass = this._hass; } });
    this._onVis = () => { if (document.visibilityState === 'visible' && this._hass) { this._markSeen(); this._renderThreads(); } };
    document.addEventListener('visibilitychange', this._onVis);
  }

  _onStreamClick(e) {
    if (this._suppressClick) { this._suppressClick = false; return; }
    const $ = id => this.shadowRoot.getElementById(id);
    const img = e.target.closest('.bubble.media img');
    if (img) { const lb = $('lightbox'); lb.querySelector('img').src = img.src; lb.hidden = false; return; }
    const vp = e.target.closest('.vp'); if (vp) { this._playVoice(vp); return; }
    if (e.target.closest('[data-retry]')) { this._retry(); return; }
    if (e.target.closest('[data-dismiss]')) { this._failed = null; delete this._status[this._active]; this._renderStream(); this._renderComposerState(); return; }
    const act = e.target.closest('.act'); if (act) { this._openPicker(act.closest('.row')); return; }
    const bubble = e.target.closest('.bubble');
    if (bubble) { const row = bubble.closest('.row'), id = row.dataset.id; if (!this._showTime.delete(id)) this._showTime.add(id); row.classList.toggle('show-time'); }
  }

  _selectThread(id) {
    if (id === this._active) return;
    this._active = id; lsSet(`thread::${this._meKey}`, id);
    this._stick = true; this._rendered.clear(); this._closePicker();
    this._chromeSig = this._chromeSignature();
    this._renderThreads(); this._renderHeader(); this._renderStream(); this._renderComposerState();
    this.shadowRoot.querySelector(`.strip [data-thread="${CSS.escape(id)}"]`)?.scrollIntoView({behavior: 'smooth', inline: 'center', block: 'nearest'});
    if (!matchMedia('(pointer: coarse)').matches) this.shadowRoot.getElementById('input').focus();
  }
  _autosize() { const t = this.shadowRoot.getElementById('input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 132)}px`; }

  // ---------------------------------------------------------------- rendering
  _chromeSignature() {
    const h = this._hass, ids = [];
    for (const p of this.config.people) ids.push(p.person, p.speaker);
    for (const r of this.config.rooms) ids.push(r.speaker);
    return JSON.stringify([this._active, this._me().id, this._urgent, this._quietNow(), this.config.storage_entity && !!h.states[this.config.storage_entity],
      this._threads().filter(t => t.kind === 'chat').map(t => this._viaPref(t)),
      ids.filter(Boolean).map(e => `${h.states[e]?.state}|${h.states[e]?.attributes?.entity_picture || ''}`)]);
  }

  _renderThreads() {
    const root = this.shadowRoot; if (!root || !this._hass) return;
    const me = this._me();
    const rank = th => th.kind === 'all' ? 0 : th.kind === 'chat' ? 1 : 2;
    const rows = this._threads().map(th => {
      const msgs = this._threadMsgs(th, me), last = msgs[msgs.length - 1];
      return {th, last, unread: this._unread(th, me), ts: last ? last.ts : 0};
    }).sort((a, b) => rank(a.th) - rank(b.th) || b.ts - a.ts);
    let lastRank = 0;
    root.getElementById('list').innerHTML = rows.map(({th, last, unread, ts}) => {
      const sep = rank(th) === 2 && lastRank !== 2 ? '<div class="sect">Rooms</div>' : '';
      lastRank = rank(th);
      const who = !last ? '' : this._isMine(last, me) ? 'You: ' : th.kind !== 'chat' ? `${first(last.from?.name)}: ` : '';
      const pv = last ? who + this._preview(last) : this._presence(th).text;
      return `${sep}<button class="item ${th.id === this._active ? 'on' : ''} ${unread ? 'unread' : ''}" data-thread="${esc(th.id)}" role="option" aria-selected="${th.id === this._active}">
        ${this._avatar(th, 50)}
        <span class="meta"><span class="r1"><span class="nm">${esc(th.name)}</span><span class="tm">${esc(this._shortTime(ts))}</span></span>
        <span class="r1"><span class="pv">${esc(pv)}</span>${unread ? `<span class="badge">${unread > 9 ? '9+' : unread}</span>` : ''}</span></span>
      </button>`;
    }).join('');
    root.getElementById('strip').innerHTML = rows.map(({th, unread}) => `<button class="bub ${th.id === this._active ? 'on' : ''}" data-thread="${esc(th.id)}" role="tab" aria-selected="${th.id === this._active}" aria-label="${esc(th.name)}${unread ? `, ${unread} unread` : ''}">
        ${this._avatar(th, 54, th.id === this._active ? 'sel' : '')}${unread ? `<span class="badge">${unread > 9 ? '9+' : unread}</span>` : ''}
        <span class="lbl">${esc(th.name)}</span></button>`).join('');
    root.getElementById('meAv').innerHTML = this._senderAvatar({name: me.name, person: me.person}, 36);
  }

  _renderHeader() {
    const root = this.shadowRoot; if (!root || !this._hass) return;
    const th = this._thread(this._active);
    if (!th) { root.getElementById('head').innerHTML = ''; return; }
    const pres = this._presence(th);
    let via = '';
    if (th.kind === 'chat' && isEntity(th.entry.speaker, 'media_player') && notifyName(th.entry.notify)) {
      const v = this._viaPref(th);
      const opt = (k, label, title) => `<button data-via="${k}" class="${v === k ? 'on' : ''}" title="${esc(title)}">${label}</button>`;
      via = `<div class="via" role="group" aria-label="Send to">${opt('auto', 'Auto', 'Speaker when home, phone when away')}${opt('speaker', `${I.speaker}<span>Speaker</span>`, 'Always their speaker')}${opt('phone', '📱<span>Phone</span>', 'Always their phone')}</div>`;
    }
    root.getElementById('head').innerHTML = `${this._avatar(th, 42)}
      <div class="who"><div class="nm">${esc(th.name)}</div><div class="st">${esc(pres.text)}</div></div>
      ${via}<span class="u-flag">${I.bolt}Urgent on</span>`;
  }

  _renderComposerState() {
    const root = this.shadowRoot; if (!root || !this._hass) return;
    const $ = id => root.getElementById(id);
    const th = this._thread(this._active), f = this.config.features, me = this._me();
    const ready = this._ready();
    const urgent = this._urgent && f.urgent;
    const text = $('input').value.trim();
    const uploading = this._attachments.some(a => a.status === 'uploading');
    $('hm').classList.toggle('urgent', urgent);
    $('hm').classList.toggle('typing', !!text || this._attachments.length > 0);
    $('composer').hidden = !ready || !th;
    $('input').placeholder = !th ? 'Message' : urgent ? `Urgent message to ${th.kind === 'all' ? 'everyone' : th.name}…` : `Message ${th.kind === 'all' ? 'everyone' : th.name}…`;
    $('urgentBtn').hidden = !f.urgent;
    $('urgentBtn').setAttribute('aria-checked', String(urgent));
    $('urgentBtn').disabled = !!this._sending;
    $('photoBtn').hidden = !f.photos;
    $('micBtn').hidden = !f.voice_notes || !me.admin;
    const send = $('sendBtn');
    send.disabled = !!this._sending || !!(this._failed && !this._failed.saved) || uploading || (!text && !this._attachments.some(a => a.status === 'ready'));
    send.classList.toggle('busy', !!this._sending);

    let quietHtml = '';
    if (th && this._quietNow() && !urgent) {
      const affected = this._recipientsFor(th).filter(x => x.quiet_hours !== false);
      if (affected.length) {
        const until = esc(this.config.quiet_hours.end);
        const how = this._chimeTts() ? 'a soft chime instead of speech' : 'a silent message (and a phone alert if they have one)';
        quietHtml = `${I.moon}<span>Quiet hours until ${until} — ${esc(th.kind === 'all' ? 'speakers' : th.name)} will get ${how}.</span>${f.urgent ? '<button data-urgent>⚡ Make urgent</button>' : ''}`;
      }
    }
    if ($('quiet').innerHTML !== quietHtml) $('quiet').innerHTML = quietHtml;
    $('quiet').hidden = !quietHtml;
    this._renderTray(!text && !this._attachments.length);
  }

  _renderTray(showQuick) {
    const tray = this.shadowRoot.getElementById('tray');
    const sig = JSON.stringify([showQuick, this._ready(), this._attachments.map(a => [a.id, a.status])]);
    if (sig === this._traySig) return;
    this._traySig = sig;
    if (this._attachments.length) {
      tray.innerHTML = this._attachments.map(a => `<div class="att ${a.status === 'uploading' ? 'up' : a.status === 'error' ? 'err' : ''}">
        <img src="${esc(a.preview)}" alt="">${a.status === 'uploading' ? '<i class="spin"></i>' : ''}
        <button class="rm" data-rm="${esc(a.id)}" aria-label="Remove photo">${I.x}</button></div>`).join('');
    } else if (showQuick && this._ready()) {
      tray.innerHTML = this.config.quick_messages.map(q => `<button class="chip" data-quick="${esc(q)}">${esc(q)}</button>`).join('');
    } else tray.innerHTML = '';
  }

  _ready() { const e = this.config.storage_entity; return !!(isEntity(e, 'todo') && this._hass?.states[e]); }

  _setupHtml() {
    const e = this.config.storage_entity;
    if (!e) return `<div class="setup"><div class="nm">Almost there 👋</div><p>Messages are saved in a Home Assistant to-do list. Add a <b>Local To-do</b> list (Settings → Devices &amp; services → Add integration → Local To-do), then pick it in this card's settings under <b>Storage</b>.</p></div>`;
    if (!this._hass.states[e]) return `<div class="setup"><div class="nm">To-do list not found</div><p><code>${esc(e)}</code> doesn't exist. Pick a Local To-do list in this card's settings.</p></div>`;
    if (!this._threads().length) return `<div class="setup"><div class="nm">No conversations yet</div><p>Add people or rooms in this card's settings.</p></div>`;
    return '';
  }

  _renderStream(forceBottom = false) {
    const root = this.shadowRoot; if (!root || !this._hass) return;
    const stream = root.getElementById('stream');
    const setup = this._setupHtml();
    if (setup) { stream.innerHTML = setup; return; }
    const me = this._me(), th = this._thread(this._active);
    const msgs = this._threadMsgs(th, me);
    const f = this.config.features;
    if (!msgs.length) {
      const p = th.kind === 'chat' ? th.entry : null;
      const hint = !this._loaded ? (this._loadError ? `Couldn't load messages: ${esc(this._loadError)}` : 'Loading messages…')
        : th.kind === 'all' ? 'Messages here go to every speaker and phone in the house.'
        : th.kind === 'room' ? `Messages here are spoken on the ${esc(th.name)} speaker.`
        : `Say hello 👋 — ${esc(first(th.name))} hears it ${p.speaker && p.notify ? 'on their speaker at home, or their phone when out' : p.speaker ? 'on their speaker' : 'on their phone'}.`;
      stream.innerHTML = `<div class="empty">${this._avatar(th, 84)}<div class="nm">${esc(th.name)}</div><p>${hint}</p></div>`;
      this._lastNewest = 0;
      return;
    }
    const GAP = 30 * 60e3, GROUP = 4 * 60e3;
    let seenIdx = -1, seenHtml = '';
    if (th.kind === 'chat' && f.read_receipts) {
      for (let k = msgs.length - 1; k >= 0; k--) if (this._isMine(msgs[k], me) && !msgs[k].pending) { seenIdx = k; break; }
      const peer = this._seenBy[th.person];
      if (seenIdx >= 0 && peer && peer.ts >= msgs[seenIdx].ts) seenHtml = `<span class="seen">${this._senderAvatar({name: th.name, person: th.person}, 14)}Seen ${esc(this._shortTime(peer.ts))}</span>`;
      else seenIdx = -1;
    }
    const keyOf = m => this._isMine(m, me) ? '__me' : (m.from?.user || norm(m.from?.name) || 'x');
    const firstRender = !this._rendered.size;
    let html = '';
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i], prev = msgs[i - 1], next = msgs[i + 1];
      const key = keyOf(m), mine = key === '__me';
      const divider = !prev || m.ts - prev.ts > GAP || new Date(m.ts).toDateString() !== new Date(prev.ts).toDateString();
      if (divider) html += `<div class="day">${esc(this._dayLabel(m.ts))}</div>`;
      const gs = divider || keyOf(prev) !== key || m.ts - prev.ts > GROUP;
      const ge = !next || next.ts - m.ts > GAP || keyOf(next) !== key || next.ts - m.ts > GROUP || new Date(next.ts).toDateString() !== new Date(m.ts).toDateString();
      const id = m.id;
      let content, cls = 'bubble';
      const emojiOnly = !m.img && !m.voice && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s){1,8}$/u.test(m.text.trim()) && /\p{Extended_Pictographic}/u.test(m.text);
      if (m.voice) {
        content = `<div class="voice" data-media="${esc(m.voice)}"><button class="vp" aria-label="Play voice note">${I.play}</button><span class="wave">${Array.from({length: 22}, (_, k) => `<b style="height:${30 + Math.round(60 * Math.abs(Math.sin((k + 1) * (id.length % 7 + 1.3))))}%"></b>`).join('')}</span><span class="vl">Voice</span></div>`;
      } else if (m.img) {
        cls += ' media'; content = `<img src="${esc(safeUrl(m.img))}" alt="Photo" loading="lazy">`;
      } else { if (emojiOnly) cls += ' big'; content = esc(m.text); }
      let rxHtml = '';
      const rx = f.reactions ? (this._reactions[id] || []) : [];
      if (rx.length) {
        const g = {}; rx.forEach(r => { g[r.emoji] = (g[r.emoji] || 0) + 1; });
        rxHtml = `<span class="rx" title="${esc(rx.map(r => `${first(r.by?.name) || 'Someone'} ${r.emoji}`).join(', '))}">${Object.keys(g).slice(0, 4).map(esc).join('')}${rx.length > 1 ? `<span class="n">${rx.length}</span>` : ''}</span>`;
      }
      const whoLabel = gs && !mine && th.kind !== 'chat' ? `<div class="who-l" style="--h:${hueFor(m.from?.name)}"><b>${esc(first(m.from?.name) || 'Someone')}</b></div>` : '';
      const viaTag = th.kind === 'chat' && mine && ge && !m.pending && m.via ? `<span class="tag v">${m.via === 'phone' ? '📱 Phone' : m.via === 'both' ? `${I.speaker}Speaker + 📱` : `${I.speaker}Speaker`}${m.quiet ? ' · quiet' : ''}</span>` : '';
      const tags = `${m.urgent ? `<span class="tag u">${I.bolt}Urgent</span>` : ''}${viaTag || (m.quiet && ge ? `<span class="tag q">${I.moon}Quiet hours</span>` : '')}`;
      const anim = !firstRender && !this._rendered.has(id) ? ' in' : '';
      const grp = gs && ge ? 'gs ge' : gs ? 'gs' : ge ? 'ge' : 'gm';
      html += `<div class="row ${mine ? 'mine' : 'theirs'} ${grp}${m.urgent ? ' is-urgent' : ''}${m.pending ? ' pending' : ''}${this._showTime.has(id) ? ' show-time' : ''}${anim}" data-id="${esc(id)}">
        <span class="avs">${!mine && ge ? this._senderAvatar(m.from) : ''}</span>
        <div class="col">${whoLabel}<div class="${cls}">${content}</div>${rxHtml}${tags}${i === seenIdx ? seenHtml : ''}<span class="stamp">${esc(this._dayLabel(m.ts))}${m.pending ? ' · Sending…' : ''}</span></div>
        ${f.reactions && !m.pending ? `<span class="acts"><button class="act" aria-label="React">${I.smile}</button></span>` : ''}
      </div>`;
    }
    const st = this._status[th.id];
    if (st) {
      html += st.bad
        ? `<div class="status bad">${esc(st.text)}${this._failed ? `<button data-retry>${I.retry}Retry</button><button data-dismiss>Dismiss</button>` : ''}</div>`
        : `<div class="status">${st.busy ? '' : `<span class="ok">${I.check}</span>`}${esc(st.text)}</div>`;
    }
    const newest = msgs[msgs.length - 1].ts;
    const grew = this._lastNewest && newest > this._lastNewest;
    this._lastNewest = newest;
    const prevTop = stream.scrollTop;
    stream.innerHTML = html;
    msgs.forEach(m => this._rendered.add(m.id));
    if (forceBottom || this._stick) this._scrollBottom(false);
    else { stream.scrollTop = prevTop; if (grew) root.getElementById('jump').hidden = false; }
    stream.querySelectorAll('.bubble.media img').forEach(img => {
      img.addEventListener('load', () => { if (this._stick) this._scrollBottom(false); }, {once: true});
      img.addEventListener('error', () => { img.closest('.bubble').classList.remove('media'); img.replaceWith(document.createTextNode('📷 Photo unavailable')); }, {once: true});
    });
    if (document.visibilityState === 'visible') { this._markSeen(); this._maybeWriteSeen(); }
  }

  _scrollBottom(smooth) {
    const s = this.shadowRoot.getElementById('stream');
    requestAnimationFrame(() => { s.scrollTo({top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto'}); this._stick = true; this.shadowRoot.getElementById('jump').hidden = true; });
  }

  // ---------------------------------------------------------------- reactions & deleting
  _openPicker(row) {
    if (!row || row.classList.contains('pending')) return;
    const picker = this.shadowRoot.getElementById('picker');
    const hm = this.shadowRoot.getElementById('hm').getBoundingClientRect();
    const b = row.querySelector('.bubble').getBoundingClientRect();
    this._pickerFor = row.dataset.id;
    const me = this._me();
    const mineSet = new Set((this._reactions[this._pickerFor] || []).filter(r => r.by?.user === me.id).map(r => r.emoji));
    let html = this.config.features.reactions ? this.config.emojis.map(e => `<button data-e="${esc(e)}" class="${mineSet.has(e) ? 'mine' : ''}" aria-label="React ${esc(e)}">${esc(e)}</button>`).join('') : '';
    const msg = this._msgs.find(m => m.id === this._pickerFor);
    if (msg && (this._isMine(msg) || me.admin)) html += `<button data-delete aria-label="Delete message" title="Delete message" style="color:#ff6b6b">${I.trash}</button>`;
    if (!html) return;
    picker.innerHTML = html; picker.hidden = false;
    const w = picker.offsetWidth, h = picker.offsetHeight;
    let left = row.classList.contains('mine') ? b.right - hm.left - w : b.left - hm.left;
    left = Math.max(8, Math.min(left, hm.width - w - 8));
    let top = b.top - hm.top - h - 8;
    if (top < 8) top = b.bottom - hm.top + 8;
    picker.style.left = `${left}px`; picker.style.top = `${top}px`;
  }
  _closePicker() { const p = this.shadowRoot?.getElementById('picker'); if (p) p.hidden = true; }

  async _react(msgId, emoji) {
    const me = this._me();
    const existing = (this._reactions[msgId] || []).find(r => r.emoji === emoji && r.by?.user === me.id);
    // optimistic
    const list = (this._reactions[msgId] || []).filter(r => r !== existing);
    if (!existing) list.push({emoji, by: {user: me.id, name: me.name}, uid: null});
    this._reactions = {...this._reactions, [msgId]: list};
    this._renderStream();
    try {
      if (existing?.uid) await this._removeItems([existing.uid]);
      else if (!existing) await this._addItem(`Reaction ${emoji} · ${me.name}`, {t: 'rx', msg: msgId, emoji, by: {user: me.id, person: me.person, name: me.name}, ts: Date.now()});
    } catch (e) { this._setStatus(this._active, {bad: true, text: 'Reaction could not be saved.'}); }
    if (this._polling) this._scheduleLoad(500);
  }

  async _deleteMessage(id) {
    const m = this._msgs.find(x => x.id === id);
    if (!m || (!this._isMine(m) && !this._me().admin)) return;
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await this._removeItems([m.uid, ...(this._reactions[id] || []).map(r => r.uid)]);
      if (this._polling) this._scheduleLoad(300);
    } catch (e) { this._setStatus(this._active, {bad: true, text: 'Message could not be deleted.'}); }
  }

  // ---------------------------------------------------------------- sending
  _setStatus(threadId, st) { if (st) this._status[threadId] = st; else delete this._status[threadId]; if (threadId === this._active) this._renderStream(); }

  // Everyone a thread delivers to, as {kind, entry}. "Everyone" skips the sender.
  _recipientsFor(th) {
    const me = this._me();
    if (th.kind === 'chat') return [th.entry];
    if (th.kind === 'room') return [th.entry];
    return [...this.config.people.filter(p => p.in_broadcast !== false && p.person !== me.person), ...this.config.rooms.filter(r => r.in_broadcast !== false)];
  }

  // Turn one message into the Home Assistant actions that deliver it.
  _plan(th, {text, kind = 'text', urgent}) {
    const me = this._me(), c = this.config, quietNow = this._quietNow() && !urgent;
    const chime = this._chimeTts(), engine = this._ttsEngine();
    const spoken = c.tts.prefix_sender ? `${first(me.name)} says, ${text}` : text;
    const title = th.kind === 'all' ? `📢 ${first(me.name)} to ${c.broadcast.name || 'everyone'}` : th.kind === 'room' ? `💬 ${first(me.name)} · ${th.name}` : `💬 ${first(me.name)}`;
    const phoneBody = kind === 'image' ? '📷 Sent a photo' : kind === 'voice' ? '🎤 Sent a voice note — open Messages to play' : text;
    const announce = kind === 'image' ? `${first(me.name)} sent a photo` : kind === 'voice' ? `${first(me.name)} sent a voice note` : spoken;
    const jobs = [], speakers = new Set(), phones = new Set();
    let anyQuiet = false, via = '';
    const speak = (entity, label, quiet) => {
      if (speakers.has(entity)) return; speakers.add(entity);
      if (quiet) {
        if (chime) jobs.push({label: `${label} · chime`, domain: 'chime_tts', service: 'say', target: {entity_id: entity}, data: {chime_path: c.tts.chime || 'bells', message: '', announce: c.tts.announce}});
        return;
      }
      const opts = {...(c.tts.voice ? {voice: c.tts.voice} : {})};
      if (chime) {
        jobs.push({label, domain: 'chime_tts', service: 'say', target: {entity_id: entity}, data: {message: announce, chime_path: c.tts.chime || 'bells', announce: c.tts.announce,
          ...(engine ? {tts_platform: engine} : {}), ...(c.tts.language ? {language: c.tts.language} : {}), ...(Object.keys(opts).length ? {options: opts} : {})}});
      } else {
        if (!engine) throw new Error('No text-to-speech service found. Pick one in the card settings.');
        jobs.push({label, domain: 'tts', service: 'speak', target: {entity_id: engine}, data: {media_player_entity_id: entity, message: announce, cache: true,
          ...(c.tts.language ? {language: c.tts.language} : {}), ...(Object.keys(opts).length ? {options: opts} : {})}});
      }
    };
    const notify = (svc, label, p, quiet) => {
      if (phones.has(svc)) return; phones.add(svc);
      const data = {tag: `ha-messenger-${th.id}`, group: 'ha-messenger', ...(c.open_path ? {url: c.open_path, clickAction: c.open_path} : {}),
        ...(urgent ? {priority: 'high', ttl: 0, push: {'interruption-level': 'time-sensitive'}} : {})};
      if (kind === 'image' && text) data.image = text;
      if (p?.phone_tts && kind === 'text' && !quiet) {
        jobs.push({label: `${label} · spoken`, domain: 'notify', service: svc, data: {message: 'TTS', data: {...data, tts_text: spoken, ...(urgent ? {media_stream: 'alarm_stream_max'} : {})}}});
      } else jobs.push({label, domain: 'notify', service: svc, data: {title, message: phoneBody, data}});
    };
    for (const r of this._recipientsFor(th)) {
      const quiet = quietNow && r.quiet_hours !== false;
      anyQuiet ||= quiet;
      if (r.person) {
        const name = this._personName(r.person);
        const route = this._routeFor(r, th.kind === 'chat' ? this._viaPref(th) : (r.broadcast_to || 'auto'));
        // A photo can't be shown on a speaker, so it always goes to their phone too.
        if (kind === 'image' && notifyName(r.notify)) route.phone = true;
        // Quiet speaker without chime = nothing audible, so make sure their phone hears about it.
        if (route.speaker && quiet && !chime && notifyName(r.notify)) route.phone = true;
        if (route.speaker && isEntity(r.speaker, 'media_player') && kind !== 'image') speak(r.speaker, `${name} · speaker`, quiet);
        if (route.phone && notifyName(r.notify)) notify(notifyName(r.notify), `${name} · phone`, r, quiet);
        if (th.kind === 'chat') via = route.speaker && route.phone ? 'both' : route.phone ? 'phone' : 'speaker';
      } else if (isEntity(r.speaker, 'media_player') && kind !== 'image') speak(r.speaker, r.name, quiet);
    }
    return {jobs, quiet: anyQuiet, via};
  }

  async _run(jobs) {
    const h = this._hass;
    const results = await Promise.allSettled(jobs.map(async j => {
      if (h.services && !h.services[j.domain]?.[j.service]) throw new Error(j.domain === 'notify' ? 'phone not found' : 'action not available');
      const ent = j.domain === 'tts' ? j.data.media_player_entity_id : j.target?.entity_id;
      if (j.domain !== 'notify' && ent) { const st = h.states[ent]; if (!st || ['unavailable', 'unknown'].includes(st.state)) throw new Error('speaker offline'); }
      await h.callService(j.domain, j.service, j.data, j.domain === 'notify' ? undefined : j.target);
    }));
    const failed = [];
    results.forEach((r, i) => { if (r.status === 'rejected') failed.push({...jobs[i], error: String(r.reason?.message || r.reason)}); });
    return {ok: jobs.length - failed.length, failed};
  }

  _record(th, extra) {
    const me = this._me();
    const to = th.kind === 'all' ? {kind: 'all', id: 'all', name: th.name} : th.kind === 'room' ? {kind: 'room', id: th.entry.id, name: th.name} : {kind: 'person', id: th.person, name: th.name};
    return {t: 'msg', id: uuid(), ts: Date.now(), from: {user: me.id, person: me.person || null, name: me.name}, to, ...extra};
  }

  async _send() {
    if (!this._hass || this._sending || (this._failed && !this._failed.saved) || !this._ready()) return;
    if (this._failed?.saved) this._failed = null;
    const input = this.shadowRoot.getElementById('input');
    const text = input.value.trim();
    const images = this._attachments.filter(a => a.status === 'ready');
    if (!text && !images.length) return;
    const th = this._thread(this._active); if (!th) return;
    const me = this._me(), now = Date.now(), urgent = this._urgent && this.config.features.urgent;
    const pend = [
      ...images.map((a, i) => ({id: `p-img-${now}-${i}`, pending: true, threadId: th.id, from: {user: me.id, name: me.name}, to: {}, text: '', img: a.url, ts: now + i})),
      ...(text ? [{id: `p-${now}`, pending: true, threadId: th.id, from: {user: me.id, name: me.name}, to: {}, text, urgent, ts: now + 10}] : []),
    ];
    this._pending.push(...pend);
    input.value = ''; this._autosize();
    this._attachments = this._attachments.filter(a => a.status !== 'ready');
    this._sending = true; this._stick = true;
    this._status[th.id] = {busy: true, text: 'Sending…'};
    this._renderComposerState(); this._renderStream(true); this._renderThreads();
    const done = [], problems = [];
    try {
      for (const a of images) {
        const plan = this._plan(th, {text: a.url, kind: 'image', urgent});
        await this._addItem(`${me.name} → ${th.name}: 📷 Photo`, this._record(th, {img: a.url, urgent, quiet: plan.quiet, via: plan.via}));
        const r = await this._run(plan.jobs);
        done.push(...plan.jobs.filter(j => !r.failed.some(f => f.label === j.label)).map(j => j.label));
        problems.push(...r.failed);
      }
      if (text) {
        const plan = this._plan(th, {text, urgent});
        if (!plan.jobs.length && th.kind !== 'all') throw new Error('No speaker or phone is set up for this conversation.');
        const r = await this._run(plan.jobs);
        if (plan.jobs.length && !r.ok) {
          this._failed = {th, text, urgent, plan, jobs: r.failed};
          throw new Error(r.failed.map(j => `${j.label.split(' · ')[0]} (${j.error})`).join(', '));
        }
        await this._addItem(`${me.name} → ${th.name}: ${text}`, this._record(th, {text, urgent, quiet: plan.quiet, via: plan.via}));
        done.push(...plan.jobs.filter(j => !r.failed.includes(j)).map(j => j.label));
        if (r.failed.length) { problems.push(...r.failed); this._failed = {th, text, urgent, plan, jobs: r.failed, saved: true}; }
      }
      if (urgent) this._urgent = false;
      this._status[th.id] = problems.length
        ? {bad: true, text: `Sent, but not to: ${problems.map(j => `${j.label.split(' · ')[0]} (${j.error})`).join(', ')}`}
        : {text: done.length ? `Sent · ${done.length <= 2 ? done.join(' · ') : `${done.length} speakers & phones`}` : 'Saved'};
    } catch (e) {
      this._status[th.id] = {bad: true, text: `Not sent: ${e.message || e}`};
      if (text && !input.value) { input.value = text; this._autosize(); this._failed = this._failed?.saved ? this._failed : null; }
    } finally {
      this._sending = false;
      this._pending = this._pending.filter(p => !pend.includes(p));
      this._chromeSig = ''; if (this._hass) this.hass = this._hass;
      this._renderStream(true);
      if (this._polling) this._scheduleLoad(400);
    }
  }

  async _retry() {
    const f = this._failed; if (!f || this._sending) return;
    this._sending = true; this._setStatus(f.th.id, {busy: true, text: 'Retrying…'}); this._renderComposerState();
    try {
      const r = await this._run(f.jobs);
      if (r.failed.length) { this._failed = {...f, jobs: r.failed}; this._setStatus(f.th.id, {bad: true, text: `Still not delivered to: ${r.failed.map(j => j.label.split(' · ')[0]).join(', ')}`}); return; }
      if (!f.saved) {
        await this._addItem(`${this._me().name} → ${f.th.name}: ${f.text}`, this._record(f.th, {text: f.text, urgent: f.urgent, quiet: f.plan.quiet, via: f.plan.via}));
        const input = this.shadowRoot.getElementById('input'); if (input.value.trim() === f.text) { input.value = ''; this._autosize(); }
      }
      this._failed = null; this._setStatus(f.th.id, {text: 'Sent'});
    } catch (e) { this._setStatus(f.th.id, {bad: true, text: `Could not finish: ${e.message || e}`}); }
    finally { this._sending = false; this._renderComposerState(); this._renderStream(); }
  }

  // ---------------------------------------------------------------- photos
  async _shrink(file) {
    if (file.size < 1.6e6 || file.type === 'image/gif' || typeof createImageBitmap !== 'function') return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
      return blob && blob.size < file.size ? new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', {type: 'image/jpeg'}) : file;
    } catch { return file; }
  }
  async _addImage(file) {
    if (!file?.type?.startsWith('image/') || this._attachments.length >= 6 || !this.config.features.photos) return;
    const att = {id: uuid(), status: 'uploading', preview: URL.createObjectURL(file), url: ''};
    this._attachments.push(att); this._renderComposerState();
    try {
      const small = await this._shrink(file);
      const fd = new FormData();
      fd.append('file', small, small.name || `photo-${Date.now()}.jpg`);
      const resp = await this._hass.fetchWithAuth('/api/image/upload', {method: 'POST', body: fd});
      if (!resp.ok) throw new Error(resp.status === 401 || resp.status === 403 ? 'your account is not allowed to upload' : `upload failed (${resp.status})`);
      const data = await resp.json();
      att.url = `/api/image/serve/${data.id}/original`; att.status = 'ready';
    } catch (e) {
      att.status = 'error';
      this._setStatus(this._active, {bad: true, text: `Photo upload failed: ${e.message || e}`});
    }
    if (this._attachments.includes(att)) this._renderComposerState();
  }
  _removeAttachment(id) {
    const a = this._attachments.find(x => x.id === id); if (a) URL.revokeObjectURL(a.preview);
    this._attachments = this._attachments.filter(x => x.id !== id); this._renderComposerState();
  }

  // ---------------------------------------------------------------- voice notes (admin accounts: HA only lets admins upload media)
  async _startRecording() {
    if (this._voice || !this.config.features.voice_notes) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { this._setStatus(this._active, {bad: true, text: 'Voice notes need microphone access (HTTPS) in this browser.'}); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(v => MediaRecorder.isTypeSupported?.(v)) || '';
      const rec = new MediaRecorder(stream, mime ? {mimeType: mime} : undefined);
      const v = {recording: true, rec, stream, chunks: [], started: Date.now(), timer: null, blob: null, url: null};
      this._voice = v;
      rec.addEventListener('dataavailable', e => { if (e.data?.size) v.chunks.push(e.data); });
      rec.addEventListener('stop', () => this._finishRecording(v));
      rec.start();
      const $ = id => this.shadowRoot.getElementById(id);
      $('cRow').hidden = true; $('rRow').hidden = false; $('recPill').classList.remove('done');
      $('recAction').innerHTML = I.stop; $('recAction').setAttribute('aria-label', 'Stop recording');
      const tick = () => { const s = Math.min(60, Math.floor((Date.now() - v.started) / 1000)); $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s >= 60) this._stopRecording(); };
      v.timer = setInterval(tick, 250); tick();
    } catch (e) { this._setStatus(this._active, {bad: true, text: `Microphone unavailable: ${e.message || e}`}); }
  }
  _stopRecording() { const v = this._voice; if (v?.recording) { v.recording = false; clearInterval(v.timer); v.rec.stop(); v.stream.getTracks().forEach(t => t.stop()); } }
  _cancelRecording() { const v = this._voice; if (!v) return; v.cancelled = true; if (v.recording) this._stopRecording(); else this._resetVoice(); }
  _finishRecording(v) {
    if (v.cancelled) return this._resetVoice();
    v.blob = new Blob(v.chunks, {type: v.rec.mimeType || 'audio/webm'});
    if (v.blob.size > 10 * 1024 * 1024) { this._setStatus(this._active, {bad: true, text: 'Voice note is larger than 10 MB.'}); return this._resetVoice(); }
    v.url = URL.createObjectURL(v.blob);
    const $ = id => this.shadowRoot.getElementById(id);
    $('recPill').classList.add('done'); $('recAudio').src = v.url; $('recAudio').hidden = false;
    $('recAction').innerHTML = I.send; $('recAction').setAttribute('aria-label', 'Send voice note');
  }
  _resetVoice() {
    const v = this._voice; if (v?.url) URL.revokeObjectURL(v.url); this._voice = null;
    const $ = id => this.shadowRoot.getElementById(id);
    $('cRow').hidden = false; $('rRow').hidden = true; $('recAudio').hidden = true; $('recAudio').removeAttribute('src'); $('recPill').classList.remove('done');
  }
  async _sendVoice() {
    const v = this._voice; if (!v?.blob || this._sending) return;
    const th = this._thread(this._active), me = this._me();
    this._sending = true; this._renderComposerState();
    this._setStatus(th.id, {busy: true, text: 'Sending voice note…'});
    try {
      const fd = new FormData();
      fd.append('media_content_id', 'media-source://media_source/local/.');
      const ext = v.blob.type.includes('mp4') ? 'm4a' : v.blob.type.includes('ogg') ? 'ogg' : 'webm';
      fd.append('file', v.blob, `messenger-${Date.now()}.${ext}`);
      const resp = await this._hass.fetchWithAuth('/api/media_source/local_source/upload', {method: 'POST', body: fd});
      if (!resp.ok) throw new Error(resp.status === 401 ? 'only admin accounts can upload voice notes' : `upload failed (${resp.status})`);
      const mediaId = (await resp.json()).media_content_id;
      if (!mediaId) throw new Error('upload did not return a media ID');
      const plan = this._plan(th, {kind: 'voice', urgent: this._urgent});
      await this._addItem(`${me.name} → ${th.name}: 🎤 Voice note`, this._record(th, {voice: mediaId, quiet: plan.quiet, via: plan.via}));
      const r = await this._run(plan.jobs);
      this._status[th.id] = r.failed.length ? {bad: true, text: `Voice note saved, but ${r.failed.length} alert(s) failed`} : {text: 'Voice note sent'};
      this._resetVoice();
    } catch (e) { this._status[th.id] = {bad: true, text: `Voice note failed: ${e.message || e}`}; }
    finally { this._sending = false; this._renderComposerState(); this._renderStream(true); if (this._polling) this._scheduleLoad(400); }
  }
  async _playVoice(btn) {
    const box = btn.closest('.voice');
    if (this._audio && this._audioBox === box) {
      if (this._audio.paused) { await this._audio.play(); box.classList.add('playing'); btn.innerHTML = I.pause; }
      else { this._audio.pause(); box.classList.remove('playing'); btn.innerHTML = I.play; }
      return;
    }
    if (this._audio) { this._audio.pause(); this._audioBox?.classList.remove('playing'); const ob = this._audioBox?.querySelector('.vp'); if (ob) ob.innerHTML = I.play; }
    try {
      const res = await this._hass.callWS({type: 'media_source/resolve_media', media_content_id: box.dataset.media});
      if (!res?.url) throw new Error('could not find the recording');
      const a = new Audio(this._hass.hassUrl ? this._hass.hassUrl(res.url) : res.url);
      this._audio = a; this._audioBox = box;
      const vl = box.querySelector('.vl');
      a.addEventListener('timeupdate', () => { const s = Math.floor(a.currentTime); vl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; });
      a.addEventListener('ended', () => { box.classList.remove('playing'); btn.innerHTML = I.play; vl.textContent = 'Voice'; this._audio = null; });
      await a.play(); box.classList.add('playing'); btn.innerHTML = I.pause;
    } catch (e) { this._setStatus(this._active, {bad: true, text: `Couldn't play voice note: ${e.message || e}`}); }
  }
}
