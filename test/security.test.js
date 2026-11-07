// Safety rules: blocked links (SSRF), who may use the backend, and what the page can see.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startServer, api } = require('./helpers/serverProcess');

process.env.BLOTATO_MOCK = 'true';
delete process.env.PREFLIGHT_ALLOW_PRIVATE_MEDIA;
const { validateMediaUrl, BlockedUrlError } = require('../mediaFetcher');
const { explainError } = require('../errorExplainer');

test.describe('links refused before anything is sent', () => {
  const blocked = [
    'http://localhost/x.png',
    'http://LOCALHOST./x.png',
    'http://app.localhost/x.png',
    'http://127.0.0.1/x.png',
    'http://127.1/x.png',
    'http://2130706433/x.png',
    'http://0x7f000001/x.png',
    'http://0.0.0.0/x.png',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/x',
    'http://10.0.0.5/x.png',
    'http://172.16.4.4/x.png',
    'http://192.168.1.1/x.png',
    'http://100.64.0.1/x.png',
    'http://[fd00::1]/x.png',
    'http://[fe80::1]/x.png',
    'http://router/x.png',
    'http://printer.local/x.png',
    'https://example.com:8443/x.png',
    'http://user:secret@example.com/x.png',
    'file:///C:/Windows/win.ini',
    'ftp://example.com/x.png',
    'javascript:alert(1)',
  ];
  for (const link of blocked) {
    test(link, () => assert.throws(() => validateMediaUrl(link), BlockedUrlError));
  }
  test('private addresses are caught in every written form, and public ones are not', () => {
    const { isBlockedAddress } = require('../mediaFetcher');
    for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '192.168.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'fe80::1', 'fd00::1']) {
      assert.strictEqual(isBlockedAddress(address), true, `${address} should be blocked`);
    }
    for (const address of ['8.8.8.8', '104.26.4.30', '172.67.74.163', '146.75.17.91', '::ffff:8.8.8.8', '2606:4700::1111']) {
      assert.strictEqual(isBlockedAddress(address), false, `${address} should be allowed`);
    }
  });
  test('normal public links are allowed', () => {
    assert.doesNotThrow(() => validateMediaUrl('https://picsum.photos/1080/1080'));
    assert.doesNotThrow(() => validateMediaUrl('http://example.com:80/a.jpg'));
  });
});

test.describe('the running app', () => {
  let app;
  test.before(async () => { app = await startServer({ port: 3103, env: { BLOTATO_MOCK: 'true', PREFLIGHT_ALLOW_PRIVATE_MEDIA: '' } }); });
  test.after(() => app.stop());

  const reachable = async (link) => {
    const { data } = await api(app.base, '/api/preflight', { caption: 'x', mediaUrl: link, platforms: ['instagram'] });
    return data.checks.find((check) => check.name === 'Media link is reachable');
  };

  test('blocks its own address and cloud metadata addresses', async () => {
    for (const link of ['http://127.0.0.1:3103/api/config', 'http://169.254.169.254/latest/meta-data/']) {
      const row = await reachable(link);
      assert.strictEqual(row.status, 'fail');
      assert.match(row.reason, /blocked for safety/);
    }
  });

  test('blocks a public name that secretly points to this computer (checked when connecting)', async () => {
    const row = await reachable('http://localtest.me/x.png');
    assert.strictEqual(row.status, 'fail');
    assert.ok(/private or internal address/.test(row.reason) || /could not be found/.test(row.reason), row.reason);
  });

  test('every redirect is checked: a redirect to a private address is refused', async () => {
    const { openMedia } = require('../mediaFetcher');
    const targets = ['http://127.0.0.1/secret', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://localhost/x', 'file:///C:/Windows/win.ini'];
    const redirector = http.createServer((req, res) => {
      res.writeHead(302, { location: decodeURIComponent(req.url.slice(1)) });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    try {
      for (const target of targets) {
        const first = `http://127.0.0.1:${redirector.address().port}/${encodeURIComponent(target)}`;
        await assert.rejects(openMedia(first, AbortSignal.timeout(5000), { trustedFirstUrl: first }), /blocked for safety|not a valid web link/, target);
      }
    } finally {
      redirector.close();
    }
  });

  test('refuses requests that are not from this app (another website, or a fake host name)', async () => {
    const evilOrigin = await api(app.base, '/api/health', undefined, { Origin: 'https://evil.example' });
    assert.strictEqual(evilOrigin.status, 403);
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: 3103, path: '/api/health', headers: { Host: 'evil.example:3103' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.strictEqual(status, 403);
  });

  test('sends safety headers with the page', async () => {
    const { headers } = await api(app.base, '/');
    assert.match(headers.get('content-security-policy'), /default-src 'self'/);
    assert.strictEqual(headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(headers.get('x-powered-by'), null);
  });

  test('refuses to send without a passed preflight', async () => {
    const result = await api(app.base, '/api/send', { caption: 'x', mediaUrl: 'https://picsum.photos/10', platforms: ['instagram'] });
    assert.strictEqual(result.status, 409);
  });

  test('broken JSON gets a short message, not internal details', async () => {
    const response = await fetch(`${app.base}/api/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(await response.json(), { message: 'That request could not be understood.' });
  });
});

test.describe('error explanations', () => {
  const cases = [
    ['Unauthorized', 401, /Settings > API/],
    ['Authorization failed - please check your credentials', undefined, /Settings > API/],
    ['Wrong Blotato API Key', undefined, /Settings > API/],
    ['Failed to fetch media URL: 403 Forbidden', undefined, /direct public file link/],
    ['Failed to read media metadata. Is the file accessible and a valid media file?', undefined, /direct public file link/],
    ['Could not upload media to storage', undefined, /direct public file link/],
    ['The aspect ratio is not supported', undefined, /Resize the media/],
    ['The service is receiving too many requests from you', 429, /Wait one minute/],
    ['Unsupported media format: mov,mp4,m4a,3gp,3g2,mj2', undefined, /real MP4/],
    ['Gateway Timeout', 504, /publish the same post twice/],
    ['API key is missing: BLOTATO_API_KEY is empty in .env', 401, /paste your key/],
    ['Something brand new', undefined, /my\.blotato\.com\/failed/],
  ];
  for (const [message, status, fix] of cases) {
    test(message, () => assert.match(explainError(message, status).fix, fix));
  }
});
