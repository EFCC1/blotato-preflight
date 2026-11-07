// What happens in real mode with a wrong key or no key. Blotato is replaced by a local stand-in.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, api } = require('./helpers/serverProcess');

const post = { caption: 'x', mediaUrl: 'https://picsum.photos/1080/1080', platforms: ['instagram'] };

test('a wrong key fails the account check with the key fix, and nothing is published', async () => {
  // startStubbedRealServer uses the stand-in's key, so override it with a different one here.
  const app = await startServer({ port: 3106, script: 'test/helpers/wrongKeyServer.js' });
  try {
    const { data } = await api(app.base, '/api/preflight', post);
    const account = data.checks.find((check) => check.name === 'Connected account: Instagram');
    assert.strictEqual(account.status, 'fail');
    assert.match(account.reason, /did not accept your API key/);
    assert.match(account.reason, /Settings > API/);
    assert.strictEqual(data.allPassed, false);
    assert.ok(!app.output().includes('POST /v2/posts'), 'no publish request may be made');
    assert.ok(!app.output().includes('a-wrong-key'), 'the key must never be printed');
  } finally {
    await app.stop();
  }
});

test('a missing key blocks real mode without contacting Blotato', async () => {
  const app = await startServer({ port: 3107, env: { BLOTATO_MOCK: 'false', BLOTATO_API_KEY: '' } });
  try {
    const { data } = await api(app.base, '/api/preflight', post);
    assert.match(app.output(), /BLOTATO_API_KEY is empty/); // The startup warning

    const account = data.checks.find((check) => check.name === 'Connected account: Instagram');
    assert.strictEqual(account.status, 'fail');
    assert.match(account.reason, /no API key/);
    assert.strictEqual(data.allPassed, false);
    assert.ok(!app.output().includes('REQUEST '), 'no request may go to Blotato');
    assert.ok(app.output().includes('NOT SENT'));
  } finally {
    await app.stop();
  }
});

test('the app starts in mock mode unless BLOTATO_MOCK is exactly false', () => {
  const { parseMockMode } = require('../config');
  assert.strictEqual(parseMockMode(undefined), true);
  assert.strictEqual(parseMockMode(''), true);
  assert.strictEqual(parseMockMode('true'), true);
  assert.strictEqual(parseMockMode('flase'), true);
  assert.strictEqual(parseMockMode('false'), false);
  assert.strictEqual(parseMockMode(' FALSE '), false);
});
