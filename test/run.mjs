import {createRequire} from 'node:module';
import {execSync} from 'node:child_process';
let pw; try { pw = createRequire(import.meta.url)('playwright'); } catch { pw = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'); }
const {chromium} = pw;
import {fileURLToPath} from 'node:url';
const url = 'file://' + fileURLToPath(new URL('./harness.html', import.meta.url));
const browser = await chromium.launch({...(process.env.CHROME_PATH ?? '/usr/bin/google-chrome' ? {executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome'} : {}), args: ['--no-sandbox']});
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const cfg = {storage_entity: 'todo.messenger', people: [
  {person: 'person.carl', speaker: 'media_player.office', notify: 'mobile_app_carls_phone'},
  {person: 'person.claire', speaker: 'media_player.office', notify: 'mobile_app_cph2307'},
  {person: 'person.phoebe', speaker: 'media_player.phoebe'}],
  rooms: [{name: 'Kitchen', icon: '🍳', speaker: 'media_player.kitchen'}]};

async function page(w, h) {
  const p = await browser.newPage({viewport: {width: w, height: h}});
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url); p.errs = errs; return p;
}
const mount = (p, config, opts = {}) => p.evaluate(([config, opts]) => {
  document.getElementById('host').innerHTML = '';
  const c = document.createElement('ha-messenger-card'); c.setConfig(config); c.hass = makeHass(opts);
  c.style.height = '640px'; document.getElementById('host').append(c); window.card = c;
}, [config, opts]);
const sr = (p, js, arg) => p.evaluate(js, arg);

// 1. desktop render + text send to Claire (home -> speaker)
let p = await page(1200, 760);
await mount(p, {...cfg, height: 620});
await p.waitForTimeout(150);
const threads = await sr(p, () => [...card.shadowRoot.querySelectorAll('.list .item .nm')].map(e => e.textContent));
ok(JSON.stringify(threads) === JSON.stringify(['Everyone', 'Claire', 'Phoebe', 'Kitchen']), 'threads list excludes me: ' + threads.join(', '));
ok(await sr(p, () => card.shadowRoot.querySelector('.chat-head .nm').textContent) === 'Claire', 'opens first chat');
ok(await sr(p, () => !!card.shadowRoot.querySelector('.via')), 'speaker/phone switch shown for Claire');
await sr(p, () => { const i = card.shadowRoot.getElementById('input'); i.value = 'Dinner is ready'; i.dispatchEvent(new Event('input')); card.shadowRoot.getElementById('sendBtn').click(); });
await p.waitForTimeout(200);
let calls = await sr(p, () => calls);
const tts = calls.find(c => c.domain === 'tts');
ok(tts && tts.target.entity_id === 'tts.google_translate_en_com' && tts.data.media_player_entity_id === 'media_player.office' && tts.data.message === 'Carl says, Dinner is ready', 'speaks on Claire\'s speaker via tts.speak');
ok(!calls.some(c => c.domain === 'notify'), 'no phone ping when home');
const add = calls.find(c => c.domain === 'todo' && c.service === 'add_item');
const rec = JSON.parse(add.data.description);
ok(rec.hm === 2 && rec.to.id === 'person.claire' && rec.from.user === 'u-carl' && rec.via === 'speaker', 'saved record shape');
ok(add.data.item.startsWith('Carl Hussain → Claire: Dinner'), 'readable to-do title: ' + add.data.item);
ok(await sr(p, () => card.shadowRoot.querySelectorAll('.row.mine').length) === 1, 'message bubble shows');
ok((await sr(p, () => card.shadowRoot.querySelector('.status')?.textContent || '')).includes('Sent'), 'status says Sent');
await p.screenshot({path: fileURLToPath(new URL('./shot-desktop.png', import.meta.url))});

// 2. Claire replies (as her account) - appears in Carl's chat; reactions; read receipt
await sr(p, () => { const h = makeHass({user: 'u-claire', userName: 'Claire'}); window.claire = document.createElement('ha-messenger-card'); claire.setConfig(card.config); claire.hass = h; document.body.append(claire); });
await p.waitForTimeout(100);
ok(await sr(p, () => claire.shadowRoot.querySelector('.chat-head .nm').textContent) === 'Carl Hussain', 'Claire sees chat with Carl');
ok(await sr(p, () => claire.shadowRoot.querySelectorAll('.row.theirs').length) === 1, 'Claire sees Carl\'s message');
await sr(p, () => { claire._lastInteract = Date.now(); claire._maybeWriteSeen(); const i = claire.shadowRoot.getElementById('input'); i.value = 'On my way 👍'; i.dispatchEvent(new Event('input')); claire.shadowRoot.getElementById('sendBtn').click(); });
await p.waitForTimeout(250);
ok(await sr(p, () => card.shadowRoot.querySelectorAll('.row.theirs').length) === 1, 'Carl sees Claire\'s reply live');
ok(await sr(p, () => card.shadowRoot.querySelectorAll('.list .item.unread').length) === 0, 'no unread for the open chat');
ok(await sr(p, () => !!card.shadowRoot.querySelector('.seen')), 'Seen receipt shows under Carl\'s message');
const mid = await sr(p, () => card._msgs[0].id);
await sr(p, (id) => card._react(id, '❤️'), mid);
await p.waitForTimeout(100);
await sr(p, (id) => claire._react(id, '❤️'), mid);
await p.waitForTimeout(100);
ok(await sr(p, () => card.shadowRoot.querySelector('.rx')?.textContent.replace(/\s/g, '')) === '❤️2', 'two reactions stored separately');
await sr(p, (id) => card._react(id, '❤️'), mid);
await p.waitForTimeout(100);
ok(await sr(p, () => card.shadowRoot.querySelector('.rx')?.textContent.replace(/\s/g, '')) === '❤️', 'removing my reaction keeps hers');
await sr(p, () => { window.confirm = () => true; return card._deleteMessage(card._msgs[0].id); });
await p.waitForTimeout(100);
ok(await sr(p, () => card._msgs.length === 1 && !store.items.some(i => i.description.includes('"rx"'))), 'delete removes message and its reactions');
ok(p.errs.length === 0, 'no page errors: ' + p.errs.join(' | '));
await p.close();

// 3. Claire away -> phone; Everyone with quiet hours & chime; failure + retry
p = await page(1200, 760);
await mount(p, {...cfg, quiet_hours: {enabled: true, start: '00:00', end: '23:59', days: [1,2,3,4,5,6,7]}}, {claireAway: true, chime: true});
await p.waitForTimeout(120);
ok((await sr(p, () => card.shadowRoot.getElementById('quiet').textContent)).includes('chime'), 'quiet hours banner');
await sr(p, () => { const i = card.shadowRoot.getElementById('input'); i.value = 'Bring milk'; i.dispatchEvent(new Event('input')); card.shadowRoot.getElementById('sendBtn').click(); });
await p.waitForTimeout(200);
calls = await sr(p, () => calls);
const n = calls.find(c => c.domain === 'notify');
ok(n && n.service === 'mobile_app_cph2307' && n.data.message === 'Bring milk' && !calls.some(c => c.domain === 'chime_tts'), 'away -> phone notification only');
await sr(p, () => { calls.length = 0; card._selectThread('all'); const i = card.shadowRoot.getElementById('input'); i.value = 'Bedtime'; i.dispatchEvent(new Event('input')); card.shadowRoot.getElementById('sendBtn').click(); });
await p.waitForTimeout(200);
calls = await sr(p, () => calls);
const chimes = calls.filter(c => c.domain === 'chime_tts');
ok(chimes.length && chimes.every(c => c.data.message === ''), 'quiet hours -> chime only on speakers (' + chimes.map(c => c.target.entity_id).join(',') + ')');
ok(!chimes.some(c => c.target.entity_id === 'media_player.phoebe') && (await sr(p, () => card.shadowRoot.querySelector('.status').textContent)).includes('Phoebe'), 'offline speaker reported, rest delivered');
await sr(p, () => { calls.length = 0; card._urgent = true; const i = card.shadowRoot.getElementById('input'); i.value = 'Fire alarm test'; i.dispatchEvent(new Event('input')); card._failed = null; card.shadowRoot.getElementById('sendBtn').click(); });
await p.waitForTimeout(200);
calls = await sr(p, () => calls);
ok(calls.some(c => c.domain === 'chime_tts' && c.data.message.includes('Fire alarm')), 'urgent overrides quiet hours');
ok(calls.some(c => c.domain === 'notify' && c.data.data.priority === 'high'), 'urgent phone push is high priority');
ok(await sr(p, () => card._urgent === false), 'urgent switches itself off after sending');
ok(p.errs.length === 0, 'no page errors: ' + p.errs.join(' | '));
await p.close();

// 4. mobile layout, setup screen, non-admin hides mic
p = await page(390, 780);
await mount(p, cfg, {admin: false, user: 'u-phoebe', userName: 'Phoebe'});
await p.waitForTimeout(150);
ok(await sr(p, () => getComputedStyle(card.shadowRoot.querySelector('.side')).display) === 'none', 'mobile: sidebar hidden, strip used');
ok(await sr(p, () => card.shadowRoot.getElementById('micBtn').hidden), 'voice notes hidden for non-admin');
await sr(p, () => { const i = card.shadowRoot.getElementById('input'); i.value = 'hi'; i.dispatchEvent(new Event('input')); });
await p.screenshot({path: fileURLToPath(new URL('./shot-mobile.png', import.meta.url))});
await mount(p, {people: []}, {});
await p.waitForTimeout(80);
ok((await sr(p, () => card.shadowRoot.querySelector('.setup')?.textContent || '')).includes('Local To-do'), 'setup guidance when no storage');
ok(await sr(p, () => card.shadowRoot.getElementById('composer').hidden), 'composer hidden until set up');
ok(p.errs.length === 0, 'no page errors: ' + p.errs.join(' | '));
await p.close();

// 5. editor
p = await page(560, 1400);
await sr(p, () => {
  const ed = document.createElement('ha-messenger-card-editor'); window.ed = ed; window.lastCfg = null;
  ed.addEventListener('config-changed', e => { window.lastCfg = e.detail.config; ed.setConfig(e.detail.config); });
  ed.hass = makeHass({}); ed.setConfig({type: 'custom:ha-messenger-card'}); document.getElementById('ed').append(ed);
});
await p.waitForTimeout(150);
const secs = await sr(p, () => [...ed.shadowRoot.querySelectorAll('summary .t')].map(e => e.textContent));
ok(secs.length === 7, 'editor sections: ' + secs.join(' / '));
ok((await sr(p, () => ed.shadowRoot.querySelector('.note.warn')?.textContent || '')).includes('Local To-do'), 'editor guides storage setup');
await sr(p, () => { ed.shadowRoot.querySelectorAll('details')[1].open = true; [...ed.shadowRoot.querySelectorAll('button.add')].find(b => b.textContent.includes('all 3'))?.click(); });
await p.waitForTimeout(80);
let lc = await sr(p, () => lastCfg);
ok(lc?.people?.length === 3 && lc.people.find(x => x.person === 'person.claire')?.notify === 'mobile_app_cph2307' && lc.people.find(x => x.person === 'person.carl')?.notify === 'mobile_app_carls_phone', 'Add everyone matches phones automatically');
await sr(p, () => { [...ed.shadowRoot.querySelectorAll('button.add')].find(b => b.textContent.includes('room')).click(); });
await sr(p, () => { const forms = ed.shadowRoot.querySelectorAll('details')[2].querySelectorAll('ha-form'); forms[0].change('name', 'Kitchen'); });
lc = await sr(p, () => lastCfg);
ok(lc.rooms?.[0]?.name === 'Kitchen' && /^room_/.test(lc.rooms[0].id), 'room added with a stable id');
await sr(p, () => ed.shadowRoot.querySelector('ha-form').change('storage_entity', 'todo.messenger'));
lc = await sr(p, () => lastCfg);
ok(lc.storage_entity === 'todo.messenger', 'storage picked');
await sr(p, () => { const q = ed.shadowRoot.querySelectorAll('details')[4]; q.open = true; q.querySelector('ha-form').change('start', '21:30:00'); });
lc = await sr(p, () => lastCfg);
ok(lc.quiet_hours.start === '21:30', 'time picker value tidied to HH:MM');
await sr(p, () => { document.getElementById('host').innerHTML=''; const c = document.createElement('ha-messenger-card'); c.setConfig(lastCfg); c.hass = makeHass({}); c.style.height='500px'; document.getElementById('host').append(c); window.card = c; });
await p.waitForTimeout(100);
ok(await sr(p, () => card.shadowRoot.querySelectorAll('.strip .bub').length) === 4, 'card works with editor-made config');
await sr(p, () => ed.shadowRoot.querySelectorAll('details').forEach(d => d.open = true));
await p.screenshot({path: fileURLToPath(new URL('./shot-editor.png', import.meta.url)), fullPage: true});
ok(p.errs.length === 0, 'no page errors: ' + p.errs.join(' | '));
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
