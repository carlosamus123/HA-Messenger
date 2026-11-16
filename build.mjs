// Joins src/ into one HACS-ready file: dist/ha-messenger-card.js
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const src = f => readFileSync(new URL(`./src/${f}`, import.meta.url), 'utf8');
const css = src('styles.css').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const out = `/*! HA Messenger ${pkg.version} | MIT | https://github.com/carlosamus123/HA-Messenger */
(() => {
'use strict';
if (customElements.get('ha-messenger-card')) return;
${src('util.js').replace('__VERSION__', pkg.version)}
const STYLES = \`${css}\`;
${src('card.js')}
${src('editor.js')}
customElements.define(TAG, HaMessengerCard);
customElements.define(EDITOR_TAG, HaMessengerCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({type: TAG, name: 'HA Messenger', preview: false, documentationURL: 'https://github.com/carlosamus123/HA-Messenger',
  description: 'A household messenger: private chats, rooms, group messages to speakers and phones, photos, voice notes, reactions and quiet hours.'});
console.info(\`%c HA-MESSENGER %c \${VERSION} \`, 'background:#5b5cf6;color:#fff;border-radius:4px 0 0 4px;padding:2px 6px', 'background:#1c2c38;color:#fff;border-radius:0 4px 4px 0;padding:2px 6px');
})();
`;
mkdirSync(new URL('./dist/', import.meta.url), {recursive: true});
writeFileSync(new URL('./dist/ha-messenger-card.js', import.meta.url), out);
console.log(`built dist/ha-messenger-card.js ${pkg.version} (${(out.length / 1024).toFixed(1)} KB)`);
