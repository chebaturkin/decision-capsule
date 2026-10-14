const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = path.join(__dirname, '../lib/i18n.js');
function runtime(extra = {}) {
  assert.ok(fs.existsSync(source), 'the project owns a locale runtime');
  const context = { URL, console, navigator: { languages: ['de-DE', 'en-US'] }, location: { href: 'https://example.test/?keep=1#editor' }, ...extra };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context);
  return context.I18n;
}
test('locale precedence, first supported browser preference and safe fallback', () => {
  const i = runtime();
  assert.equal(i.resolveLocale({ query: 'ru', saved: 'en', languages: ['en-US'] }), 'ru');
  assert.equal(i.resolveLocale({ query: 'bad', saved: 'ru', languages: ['en-US'] }), 'ru');
  assert.equal(i.resolveLocale({ query: '', saved: '', languages: ['fr', 'ru-RU', 'en-US'] }), 'ru');
  assert.equal(i.resolveLocale({ languages: ['de'] }), 'en');
});
test('blocked storage and history keep switching usable and preserve the URL', () => {
  const i = runtime({ localStorage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } }, history: { replaceState() { throw Error('blocked'); } } });
  assert.equal(i.locale, 'en');
  assert.doesNotThrow(() => i.setLocale('ru'));
  assert.equal(i.locale, 'ru');
});
test('dictionaries have matching keys and interpolation tokens', () => {
  const i = runtime();
  assert.ok(Object.keys(i.messages.ru).length > 20);
  assert.deepEqual(Object.keys(i.messages.en).sort(), Object.keys(i.messages.ru).sort());
  for (const key of Object.keys(i.messages.ru)) {
    const tokens = value => [...value.matchAll(/\{\d+\}/g)].map(x => x[0]).sort();
    assert.deepEqual(tokens(i.messages.en[key]), tokens(i.messages.ru[key]), key);
  }
});
test('owned saved interface messages follow the locale without changing unknown content', () => {
  const i = runtime();
  const key = Object.keys(i.messages.ru).find(key => !i.messages.ru[key].includes('{'));
  i.setLocale('ru');
  assert.equal(i.owned(i.messages.en[key]), i.messages.ru[key]);
  assert.equal(i.owned('my own {0} text / мой текст'), 'my own {0} text / мой текст');
});
test('interpolated interface messages switch without changing their supplied values', () => {
  const i = runtime();
  const key = Object.keys(i.messages.ru).find(key => i.messages.ru[key].startsWith('добавлено:'));
  const english = i.t(key, ['my text / мой текст', 2]);
  i.setLocale('ru');
  assert.equal(i.owned(english), i.t(key, ['my text / мой текст', 2]));
});

test('choosing the active language saves the choice without rebuilding the app', () => {
  let changes = 0;
  let saved;
  let address;
  const i = runtime({ localStorage: { getItem() { return null; }, setItem(key, value) { saved = value; } }, history: { replaceState(state, title, url) { address = url; } } });
  i.subscribe(() => changes++);
  i.setLocale('en');
  assert.equal(changes, 0);
  assert.equal(saved, 'en');
  assert.equal(new URL(address).searchParams.get('keep'), '1');
  assert.equal(new URL(address).hash, '#editor');
  i.setLocale('ru');
  assert.equal(changes, 1);
});
