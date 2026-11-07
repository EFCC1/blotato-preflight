// Runs each mock scenario through the backend, the same way the page does.
const test = require('node:test');
const assert = require('node:assert');
const fixtures = require('./helpers/fixtures');
const { startServer, api } = require('./helpers/serverProcess');

let media;
let app;
let link;

test.before(async () => {
  media = await fixtures.start();
  link = `http://127.0.0.1:${media.port}/f/square.png`;
  app = await startServer({ port: 3105, env: { BLOTATO_MOCK: 'true', PREFLIGHT_ALLOW_PRIVATE_MEDIA: 'true' } });
});
test.after(async () => {
  await app.stop();
  media.server.close();
});

const platforms = ['instagram', 'tiktok', 'linkedin'];
const accountIds = { instagram: 'mock-instagram-2', tiktok: 'mock-tiktok-1', linkedin: 'mock-linkedin-1' };

// Preflight with "success", then send with the chosen scenario, then check the status like the page does.
async function sendWith(scenario) {
  const post = { caption: `Test ${scenario}`, mediaUrl: link, platforms };
  const preflight = await api(app.base, '/api/preflight', { ...post, mockScenario: 'success' });
  assert.strictEqual(preflight.data.allPassed, true);
  const sent = await api(app.base, '/api/send', { ...post, mockScenario: scenario, preflightToken: preflight.data.preflightToken, accountIds });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent.data));

  const finals = [];
  for (const result of sent.data.results) {
    if (result.state === 'failed') {
      finals.push({ state: 'failed', ...result.explanation });
      continue;
    }
    let status;
    for (let poll = 1; poll <= 24; poll += 1) {
      status = (await api(app.base, `/api/status/${result.postSubmissionId}`)).data;
      if (status.status !== 'in-progress') break;
    }
    finals.push({ state: status.status, publicUrl: status.publicUrl, ...(status.explanation || {}) });
  }
  return finals;
}

test('1. Success: published with a link on every platform', async () => {
  const finals = await sendWith('success');
  finals.forEach((final) => {
    assert.strictEqual(final.state, 'published');
    assert.match(final.publicUrl, /^https:\/\/example\.com\/mock-post\//);
  });
});

test('2. Wrong API key at send time: failed with the key fix', async () => {
  const finals = await sendWith('wrong-api-key');
  finals.forEach((final) => {
    assert.strictEqual(final.state, 'failed');
    assert.strictEqual(final.rawMessage, 'Authorization failed - please check your credentials');
    assert.match(final.fix, /Settings > API/);
  });
});

test('2. Wrong API key chosen before preflight: the account check fails and blocks sending', async () => {
  const { data } = await api(app.base, '/api/preflight', { caption: 'x', mediaUrl: link, platforms, mockScenario: 'wrong-api-key' });
  assert.strictEqual(data.allPassed, false);
  assert.strictEqual(data.preflightToken, undefined);
  const account = data.checks.find((check) => check.name === 'Connected account: Instagram');
  assert.strictEqual(account.status, 'fail');
  assert.match(account.reason, /Settings > API/);
});

const lateFailures = [
  ['3. Media fetch failed', 'media-fetch-failed', 'Failed to fetch media URL: 403 Forbidden', /direct public file link/],
  ['4. Bad media file', 'bad-media-file', 'Failed to read media metadata. Is the file accessible and a valid media file?', /direct public file link/],
  ['5. Aspect ratio', 'aspect-ratio', 'The aspect ratio is not supported', /Resize the media/],
];
for (const [name, scenario, message, fix] of lateFailures) {
  test(`${name}: in progress, then failed with the right fix`, async () => {
    const finals = await sendWith(scenario);
    finals.forEach((final) => {
      assert.strictEqual(final.state, 'failed');
      assert.strictEqual(final.rawMessage, message);
      assert.match(final.fix, fix);
    });
  });
}

test('6. Rate limit: failed with the wait-a-minute fix', async () => {
  const finals = await sendWith('rate-limit');
  finals.forEach((final) => {
    assert.strictEqual(final.state, 'failed');
    assert.strictEqual(final.rawMessage, 'The service is receiving too many requests from you');
    assert.match(final.fix, /Wait one minute/);
  });
});

test('7. Stuck: still in progress after 24 status checks, so the page times out', async () => {
  const finals = await sendWith('stuck');
  finals.forEach((final) => assert.strictEqual(final.state, 'in-progress'));
});

test('8. Only Instagram connected: TikTok and LinkedIn fail the account check', async () => {
  const { data } = await api(app.base, '/api/preflight', { caption: 'x', mediaUrl: link, platforms, mockScenario: 'no-tiktok-linkedin-account' });
  assert.strictEqual(data.allPassed, false);
  const byName = Object.fromEntries(data.checks.map((check) => [check.name, check.status]));
  assert.strictEqual(byName['Connected account: Instagram'], 'pass');
  assert.strictEqual(byName['Connected account: TikTok'], 'fail');
  assert.strictEqual(byName['Connected account: LinkedIn'], 'fail');
});

test('mock mode never contacts the real Blotato', () => {
  assert.ok(app.output().includes('[Blotato MOCK]'));
  assert.ok(!app.output().includes('backend.blotato.com'), 'no request may go to backend.blotato.com in mock mode');
  assert.ok(!app.output().includes('[Blotato REAL]'));
});

test('the account picked on the page is the one posted to', () => {
  assert.ok(app.output().includes('"accountId": "mock-instagram-2"'));
});
