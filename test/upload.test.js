// Uploading a file: the /api/uploads endpoint, preflight on the uploaded file, the "too big" and
// non-media messages, and the mock presigned upload flow (POST /media/uploads then PUT the bytes).
const test = require('node:test');
const assert = require('node:assert');
const fixtures = require('./helpers/fixtures');
const { startServer, api } = require('./helpers/serverProcess');

// A small upload limit so one test can prove the "too big" message without a huge file.
const MAX_BYTES = 256 * 1024;

let media;
let app;
let imageBytes;

test.before(async () => {
  media = await fixtures.start();
  // A real 1080x1080 image, fetched from the test media website, to upload as raw bytes.
  imageBytes = Buffer.from(await (await fetch(`http://127.0.0.1:${media.port}/f/square.png`)).arrayBuffer());
  app = await startServer({
    port: 3108,
    env: { BLOTATO_MOCK: 'true', PREFLIGHT_ALLOW_PRIVATE_MEDIA: 'true', PREFLIGHT_MAX_UPLOAD_BYTES: String(MAX_BYTES) },
  });
});
test.after(async () => {
  await app.stop();
  media.server.close();
});

// Posts raw bytes to /api/uploads the same way the page does.
async function upload(bytes, filename, type) {
  const response = await fetch(`${app.base}/api/uploads`, {
    method: 'POST',
    headers: { 'X-Filename': encodeURIComponent(filename), 'Content-Type': type },
    body: bytes,
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : {} };
}

test('a valid uploaded image passes preflight, then sends through the presigned flow to Published', async () => {
  const up = await upload(imageBytes, 'square.png', 'image/png');
  assert.strictEqual(up.status, 201);
  assert.ok(up.data.uploadId, 'an uploadId is returned');

  const platforms = ['instagram', 'tiktok', 'linkedin'];
  const post = { caption: 'Hello', platforms, source: 'upload', uploadId: up.data.uploadId };
  const pf = await api(app.base, '/api/preflight', { ...post, mockScenario: 'success' });
  const text = pf.data.checks.map((c) => `${c.status}: ${c.name}`).join('\n');
  assert.strictEqual(pf.data.allPassed, true, text);

  // The link-only checks are shown as "not needed", not run, for an uploaded file.
  const reachable = pf.data.checks.find((c) => c.name === 'Media link is reachable');
  assert.strictEqual(reachable.status, 'skipped');
  assert.match(reachable.reason, /Not needed/);
  // The file type is confirmed by reading inside the file.
  const mediaType = pf.data.checks.find((c) => c.name === 'Media type');
  assert.strictEqual(mediaType.status, 'pass');
  assert.match(mediaType.reason, /real image/);

  const accountIds = { instagram: 'mock-instagram-1', tiktok: 'mock-tiktok-1', linkedin: 'mock-linkedin-1' };
  const send = await api(app.base, '/api/send', { ...post, mockScenario: 'success', preflightToken: pf.data.preflightToken, accountIds });
  assert.strictEqual(send.status, 200, JSON.stringify(send.data));
  assert.strictEqual(send.data.results.length, 3);

  for (const result of send.data.results) {
    assert.strictEqual(result.state, 'in-progress', JSON.stringify(result));
    let status;
    for (let poll = 1; poll <= 24; poll += 1) {
      status = (await api(app.base, `/api/status/${result.postSubmissionId}`)).data;
      if (status.status !== 'in-progress') break;
    }
    assert.strictEqual(status.status, 'published', JSON.stringify(status));
    assert.match(status.publicUrl, /mock-post/);
  }
});

test('a file bigger than the limit is rejected with a clear message', async () => {
  const tooBig = Buffer.alloc(MAX_BYTES + 1024, 1); // Just over the limit.
  const up = await upload(tooBig, 'big.png', 'image/png');
  assert.strictEqual(up.status, 413);
  assert.match(up.data.message, /too big/i);
  assert.match(up.data.message, /\d+\s?(KB|MB)/); // Names the limit, e.g. "256 KB".
});

test('a non-media file is accepted as bytes but fails the media-type check', async () => {
  const up = await upload(Buffer.from('just some text, not media at all'), 'notes.txt', 'text/plain');
  assert.strictEqual(up.status, 201);

  const pf = await api(app.base, '/api/preflight', { caption: 'hi', platforms: ['instagram'], source: 'upload', uploadId: up.data.uploadId, mockScenario: 'success' });
  assert.strictEqual(pf.data.allPassed, false);
  const mediaType = pf.data.checks.find((c) => c.name === 'Media type');
  assert.strictEqual(mediaType.status, 'fail');
  assert.match(mediaType.reason, /could not be read as an image or a video/);
});

test('the mock presigned flow returns a presigned URL and a public URL, and the PUT is accepted', async () => {
  const response = await fetch(`${app.base}/mock-blotato/v2/media/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'blotato-api-key': 'mock' },
    body: JSON.stringify({ filename: 'clip.mp4' }),
  });
  assert.strictEqual(response.status, 201);
  const data = await response.json();
  assert.match(data.presignedUrl, /\/media\/put\//, 'returns a presigned PUT URL');
  assert.match(data.publicUrl, /blotato\.io/, 'returns a blotato.io public URL');

  // The presigned URL accepts the raw bytes with a PUT and needs no API key.
  const put = await fetch(data.presignedUrl, { method: 'PUT', body: Buffer.from('fake file bytes') });
  assert.strictEqual(put.status, 200);
});
