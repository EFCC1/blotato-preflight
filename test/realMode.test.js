// Tests the REAL-mode code path with Blotato replaced by a local stand-in, so no post can be created.
// It checks every request against Blotato's OpenAPI file (saved in test/openapi.snapshot.json).
const STUB_KEY = 'stub-key-not-real=';
process.env.BLOTATO_MOCK = 'false';
process.env.BLOTATO_API_KEY = STUB_KEY; // Ends in "=", which must survive.
process.env.PORT = '3104';

const test = require('node:test');
const assert = require('node:assert');
const spec = require('./openapi.snapshot.json');
const stub = require('./helpers/blotatoStub').install({ validKey: STUB_KEY });
const { api } = require('./helpers/serverProcess');

const logged = [];
const originalLog = console.log;
console.log = (...parts) => { logged.push(parts.join(' ')); };
const server = require('../server');
const base = 'http://127.0.0.1:3104';
const media = 'https://picsum.photos/1080/1350';

test.after(() => {
  console.log = originalLog;
  stub.restore();
  server.close();
});

// Finds the schema the OpenAPI file gives for a request body, following "$ref" links.
const resolve = (node) => (node && node.$ref ? node.$ref.split('/').slice(1).reduce((value, key) => value[key], spec) : node);

function checkAgainstSpec(call) {
  const specPath = call.pathname.replace(/^\/v2\/posts\/[^/]+$/, '/v2/posts/{postSubmissionId}');
  const operation = spec.paths[specPath] && spec.paths[specPath][call.method.toLowerCase()];
  assert.ok(operation, `${call.method} ${call.pathname} is not in Blotato's OpenAPI file`);
  if (!call.body) return;

  const schema = resolve(operation.requestBody.content['application/json'].schema);
  (schema.required || []).forEach((field) => assert.ok(field in call.body, `missing required "${field}"`));
  if (call.pathname !== '/v2/posts') return;

  const postSchema = resolve(schema.properties.post);
  postSchema.required.forEach((field) => assert.ok(field in call.body.post, `missing required "post.${field}"`));
  const { content, target } = call.body.post;
  assert.ok(typeof content.text === 'string' && Array.isArray(content.mediaUrls) && content.platform);
  const targetSchema = resolve(postSchema.properties.target).oneOf.map(resolve).find((option) => option.properties.targetType.enum.includes(target.targetType));
  assert.ok(targetSchema, `targetType "${target.targetType}" is not in the OpenAPI file`);
  targetSchema.required.forEach((field) => assert.ok(field in target, `missing required "post.target.${field}"`));
  Object.entries(target).forEach(([field, value]) => {
    const fieldSchema = targetSchema.properties[field];
    assert.ok(fieldSchema, `"post.target.${field}" is not in the OpenAPI file`);
    if (fieldSchema.enum) assert.ok(fieldSchema.enum.includes(value), `${field}=${value} is not allowed`);
    if (fieldSchema.type === 'boolean') assert.strictEqual(typeof value, 'boolean');
  });
}

const post = { caption: 'Real mode test', mediaUrl: media, platforms: ['instagram', 'tiktok', 'linkedin'] };
const accountIds = { instagram: 'ig-2', tiktok: 'tt-1', linkedin: 'li-1' };

test('real mode shows as real, with no mock scenarios and no fake Blotato', async () => {
  const { data } = await api(base, '/api/health');
  assert.strictEqual(data.mock, false);
  assert.deepStrictEqual(data.scenarios, []);
  assert.ok(!JSON.stringify(data).includes(STUB_KEY), 'the key must never reach the page');
  assert.strictEqual((await api(base, '/mock-blotato/v2/users/me/accounts')).status, 404);
});

test('/api/health reports the mode, and /api/accounts lists accounts without the key', async () => {
  const health = await api(base, '/api/health');
  assert.strictEqual(health.data.ok, true);
  assert.strictEqual(health.data.mock, false);
  const { status, data } = await api(base, '/api/accounts');
  assert.strictEqual(status, 200);
  assert.strictEqual(data.accounts.length, 4);
  data.accounts.forEach((account) => assert.deepStrictEqual(Object.keys(account).sort(), ['fullname', 'id', 'platform', 'username']));
  assert.ok(!JSON.stringify(data).includes(STUB_KEY));
});

test('private links are blocked in real mode, even with the test switch set', async () => {
  process.env.PREFLIGHT_ALLOW_PRIVATE_MEDIA = 'true';
  const { data } = await api(base, '/api/preflight', { ...post, mediaUrl: 'http://127.0.0.1:3104/style.css' });
  assert.match(data.checks.find((check) => check.name === 'Media link is reachable').reason, /blocked for safety/);
});

test('full real-mode flow: preflight, confirmation, upload, publish, status', async (t) => {
  const preflight = await api(base, '/api/preflight', post);
  assert.strictEqual(preflight.data.allPassed, true, JSON.stringify(preflight.data.checks, null, 1));
  const token = preflight.data.preflightToken;
  const callsBefore = stub.calls.length;

  await t.test('sending without ticking the confirmation is refused, and nothing reaches Blotato', async () => {
    const refused = await api(base, '/api/send', { ...post, preflightToken: token, accountIds });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.data.message, /confirmation/);
    assert.strictEqual(stub.calls.length, callsBefore);
  });

  await t.test('sending without a passed preflight is refused', async () => {
    const refused = await api(base, '/api/send', { ...post, confirmPublish: true, preflightToken: 'made-up', accountIds });
    assert.strictEqual(refused.status, 409);
  });

  const preflight2 = await api(base, '/api/preflight', post);
  await t.test('a post changed after preflight is refused', async () => {
    const refused = await api(base, '/api/send', { ...post, caption: 'changed', confirmPublish: true, preflightToken: preflight2.data.preflightToken, accountIds });
    assert.strictEqual(refused.status, 409);
  });

  const preflight3 = await api(base, '/api/preflight', post);
  const before = stub.calls.length;
  const sent = await api(base, '/api/send', { ...post, confirmPublish: true, preflightToken: preflight3.data.preflightToken, accountIds });

  await t.test('the post is sent in the right order: accounts, upload, then one post per platform', async () => {
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.data));
    const sequence = stub.calls.slice(before).map((call) => `${call.method} ${call.pathname}`);
    assert.deepStrictEqual(sequence, ['GET /v2/users/me/accounts', 'POST /v2/media', 'POST /v2/posts', 'POST /v2/posts', 'POST /v2/posts']);
  });

  await t.test('every request matches the OpenAPI file and uses the key header', () => {
    stub.calls.slice(before).forEach((call) => {
      checkAgainstSpec(call);
      assert.strictEqual(call.key, STUB_KEY, 'key is sent exactly as written, including the "="');
    });
  });

  await t.test('the upload uses the public link, and posts use the Blotato link it returns', () => {
    const calls = stub.calls.slice(before);
    assert.deepStrictEqual(calls[1].body, { url: media });
    calls.slice(2).forEach((call) => assert.deepStrictEqual(call.body.post.content.mediaUrls, ['https://database.blotato.io/stub/1.jpg']));
  });

  await t.test('the chosen accounts are used, and TikTok gets the safe defaults', () => {
    const posts = stub.calls.slice(before + 2).map((call) => call.body.post);
    assert.deepStrictEqual(posts.map((item) => item.accountId), ['ig-2', 'tt-1', 'li-1']);
    assert.deepStrictEqual(posts[1].target, {
      targetType: 'tiktok', privacyLevel: 'SELF_ONLY', disabledComments: false, disabledDuet: false,
      disabledStitch: false, isBrandedContent: false, isYourBrand: false, isAiGenerated: false,
    });
  });

  await t.test('status checks reach "published" with the public link', async () => {
    const id = sent.data.results[0].postSubmissionId;
    assert.strictEqual((await api(base, `/api/status/${id}`)).data.status, 'in-progress');
    const done = (await api(base, `/api/status/${id}`)).data;
    assert.strictEqual(done.status, 'published');
    assert.match(done.publicUrl, /^https:\/\/example\.com\/stub-post\//);
  });

  await t.test('a passed preflight can only be used once', async () => {
    const again = await api(base, '/api/send', { ...post, confirmPublish: true, preflightToken: preflight3.data.preflightToken, accountIds });
    assert.strictEqual(again.status, 409);
  });

  await t.test('with two Instagram accounts and none chosen, nothing is guessed', async () => {
    const fresh = await api(base, '/api/preflight', { ...post, platforms: ['instagram'] });
    const result = await api(base, '/api/send', { ...post, platforms: ['instagram'], confirmPublish: true, preflightToken: fresh.data.preflightToken });
    assert.strictEqual(result.data.results[0].state, 'failed');
    assert.match(result.data.results[0].explanation.rawMessage, /Account not found/);
  });
});

test('the key never appears in the logs, and the logs show it hidden', () => {
  const all = logged.join('\n');
  assert.ok(all.includes('[Blotato REAL] REQUEST  GET https://backend.blotato.com/v2/users/me/accounts'));
  assert.ok(all.includes('"blotato-api-key": "[HIDDEN]"'));
  assert.ok(!all.includes(STUB_KEY.replace('=', '')), 'the key must never be printed');
});

test('a bad post ID is refused before reaching Blotato', async () => {
  const before = stub.calls.length;
  assert.strictEqual((await api(base, '/api/status/..%2F..%2Fusers')).status, 400);
  assert.strictEqual(stub.calls.length, before);
});
