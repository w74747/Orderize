import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from '../src/lib/translate.js';

const pool = (ok = true) => ({ query: async () => ({ rowCount: ok ? 1 : 0 }) });

test('DeepL: free key host, auth header, AR/EN-GB codes', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ translations: [{ text: 'Chicken shawarma' }] }), { status: 200 });
  });
  const tr = createTranslator({ DEEPL_API_KEY: 'abcdefghijk:fx' }, { warn() {} });
  assert.deepEqual(await tr.translate(pool(), 'r', ['شاورما دجاج'], 'ar', 'en'), ['Chicken shawarma']);
  assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(calls[0].opts.headers.authorization, 'DeepL-Auth-Key abcdefghijk:fx');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { text: ['شاورما دجاج'], source_lang: 'AR', target_lang: 'EN-GB' });
});

test('over the daily quota or on provider errors nothing is translated', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
  const tr = createTranslator({ GOOGLE_TRANSLATE_API_KEY: 'k'.repeat(20) }, { warn() {} });
  assert.equal(await tr.translate(pool(false), 'r', ['x'], 'en', 'ar'), null);
  assert.equal(await tr.translate(pool(), 'r', ['x'], 'en', 'ar'), null);
  assert.equal(createTranslator({}, {}).enabled, false);
});
