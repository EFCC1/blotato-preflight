// Runs every preflight case through the real backend, using the test media website.
const test = require('node:test');
const assert = require('node:assert');
const fixtures = require('./helpers/fixtures');
const { linkCases, captionCases, extraCases } = require('./helpers/cases');
const { startServer, api } = require('./helpers/serverProcess');

let media;
let app;
let F;

test.before(async () => {
  media = await fixtures.start();
  F = `http://127.0.0.1:${media.port}`;
  app = await startServer({ port: 3101, env: { BLOTATO_MOCK: 'true', PREFLIGHT_ALLOW_PRIVATE_MEDIA: 'true' } });
});
test.after(async () => {
  await app.stop();
  media.server.close();
});

function runCase([name, link, platforms, expected, mustContain, caption = 'Hello 😀']) {
  test(name, async () => {
    const { data } = await api(app.base, '/api/preflight', { caption, mediaUrl: link, platforms, mockScenario: 'success' });
    const text = data.checks.map((check) => `${check.status}: ${check.name} - ${check.reason}`).join('\n');
    assert.strictEqual(data.allPassed, expected, `allPassed should be ${expected}\n${text}`);
    assert.ok(text.includes(mustContain), `results should mention "${mustContain}"\n${text}`);
    assert.strictEqual(Boolean(data.preflightToken), expected, 'a pass token is given only when allowed to send');
    // A row may only say "pass" if it says what was checked.
    data.checks.forEach((check) => assert.ok(check.reason.length > 10, `${check.name} has no reason`));
  });
}

test.describe('the original 24 link cases', () => {
  // Built lazily because the port of the test website is only known after it starts.
  test('all link cases', async (t) => {
    for (const testCase of linkCases(F)) {
      await t.test(testCase[0], async () => {
        const [, link, platforms, expected, mustContain] = testCase;
        const { data } = await api(app.base, '/api/preflight', { caption: 'Hello 😀', mediaUrl: link, platforms, mockScenario: 'success' });
        const text = data.checks.map((check) => `${check.status}: ${check.name} - ${check.reason}`).join('\n');
        assert.strictEqual(data.allPassed, expected, `allPassed should be ${expected}\n${text}`);
        assert.ok(text.includes(mustContain), `results should mention "${mustContain}"\n${text}`);
      });
    }
  });
});

test.describe('the original 4 caption cases', () => {
  for (const [name, length, platform, expected] of captionCases) {
    test(name, async () => {
      const { data } = await api(app.base, '/api/preflight', { caption: 'x'.repeat(length), mediaUrl: `${F}/f/square.png`, platforms: [platform] });
      const caption = data.checks.find((check) => check.name.startsWith('Caption'));
      assert.strictEqual(data.allPassed, expected, caption.reason);
    });
  }
});

test.describe('new cases added by the audit', () => {
  test('all extra cases', async (t) => {
    for (const testCase of extraCases(F)) {
      await t.test(testCase[0], async () => {
        const [, link, platforms, expected, mustContain, caption = 'Hello'] = testCase;
        const { data } = await api(app.base, '/api/preflight', { caption, mediaUrl: link, platforms, mockScenario: 'success' });
        const text = data.checks.map((check) => `${check.status}: ${check.name} - ${check.reason}`).join('\n');
        assert.strictEqual(data.allPassed, expected, `allPassed should be ${expected}\n${text}`);
        assert.ok(text.includes(mustContain), `results should mention "${mustContain}"\n${text}`);
      });
    }
  });

  test('every platform gets its own account, format, size, ratio and caption rows', async () => {
    const { data } = await api(app.base, '/api/preflight', { caption: 'Hi', mediaUrl: `${F}/f/square.png`, platforms: ['instagram', 'tiktok', 'linkedin'] });
    for (const label of ['Instagram', 'TikTok', 'LinkedIn']) {
      for (const row of ['Connected account', 'File format', 'File size', 'Aspect ratio', 'Caption']) {
        assert.ok(data.checks.some((check) => check.name === `${row}: ${label}`), `missing row "${row}: ${label}"`);
      }
    }
  });

  test('the page gets only id, username and name for each account', async () => {
    const { data } = await api(app.base, '/api/preflight', { caption: 'Hi', mediaUrl: `${F}/f/square.png`, platforms: ['instagram'] });
    assert.strictEqual(data.accounts.instagram.length, 2);
    data.accounts.instagram.forEach((account) => assert.deepStrictEqual(Object.keys(account).sort(), ['fullname', 'id', 'username']));
  });
});

test('without FFmpeg, video checks are marked skipped, not passed', async () => {
  const noFfmpeg = await startServer({ port: 3102, env: { BLOTATO_MOCK: 'true', PREFLIGHT_ALLOW_PRIVATE_MEDIA: 'true', PATH: '', Path: '' } });
  try {
    const { data } = await api(noFfmpeg.base, '/api/preflight', { caption: 'x', mediaUrl: `${F}/f/tall.mp4`, platforms: ['instagram'] });
    const byName = Object.fromEntries(data.checks.map((check) => [check.name, check]));
    assert.strictEqual(byName['Aspect ratio: Instagram'].status, 'skipped');
    assert.match(byName['Aspect ratio: Instagram'].reason, /FFmpeg is not installed/);
    assert.strictEqual(byName['Media type'].status, 'skipped');
    assert.strictEqual(data.allPassed, true, 'a skipped check does not block sending');
  } finally {
    await noFfmpeg.stop();
  }
});

// Keep runCase referenced for readers who want single cases.
module.exports = { runCase };
