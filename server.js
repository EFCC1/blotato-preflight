// server.js
// The backend: serves the web page and answers its requests.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PORT, allowPrivateMedia, maxUploadBytes } = require('./config');
const express = require('express');
const blotato = require('./blotatoClient');
const { createMockRouter } = require('./mockBlotato');
const { runPreflight } = require('./preflight');
const { explainError } = require('./errorExplainer');
const { PLATFORM_RULES } = require('./platformRules');

const PREFLIGHT_VALID_MS = 10 * 60 * 1000; // A passed preflight can be used for 10 minutes.
const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

const app = express();
app.disable('x-powered-by');

// Only this app's own page may talk to the backend. This stops another website open
// in your browser from quietly using it to publish posts.
app.use((req, res, next) => {
  const origin = req.get('origin');
  const originIsOurs = !origin || ALLOWED_HOSTS.some((host) => origin === `http://${host}`);
  if (!ALLOWED_HOSTS.includes(req.get('host')) || !originIsOurs) {
    return res.status(403).json({ message: 'Requests are only accepted from this app on this computer.' });
  }
  next();
});

// Tells the browser to run only this app's own files on the page.
app.use((req, res, next) => {
  res.set({
    // Google Fonts is allowed only for the Inter font (its stylesheet and font files). Nothing else from outside.
    // blob: lets the page preview a chosen file (image thumbnail or a video's first frame) before upload.
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The fake Blotato only exists in mock mode.
if (blotato.isMockMode()) app.use('/mock-blotato/v2', createMockRouter());

// Passed preflights, each usable once. This is what makes "failed checks block publishing"
// a real rule: the backend refuses to send a post that didn't pass, whatever the page does.
const passedPreflights = new Map();

// A fingerprint of the post, so a post changed after preflight can't use its pass.
// The media part is the link for a pasted URL, or the upload's id for an uploaded file.
function postFingerprint({ caption, source, mediaUrl, uploadId, platforms }) {
  const media = source === 'upload' ? `upload:${uploadId || ''}` : `url:${String(mediaUrl || '').trim()}`;
  return JSON.stringify([String(caption || ''), media, [...platforms].sort()]);
}

// Uploaded files waiting to be sent. Each is saved under a random name, then deleted after it is
// sent, or after one hour if it is never sent. Nothing here is ever shared or committed to git.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const UPLOAD_TTL_MS = 60 * 60 * 1000; // One hour.
const uploads = new Map(); // uploadId -> { path, filename, size, createdAt, timer }

function deleteUpload(uploadId) {
  const record = uploads.get(uploadId);
  if (!record) return;
  clearTimeout(record.timer);
  uploads.delete(uploadId);
  fs.promises.rm(record.path, { force: true }).catch(() => {});
}

// For preflight: the stored file for an upload, { missing: true } if it's gone, or undefined for a link.
function resolveUpload(body) {
  if (body.source !== 'upload') return undefined;
  return uploads.get(body.uploadId) || { missing: true };
}

// A friendly size for the "too big" message, e.g. "1024 MB" or "1 KB".
function describeMax(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function rememberPassedPreflight(body) {
  const now = Date.now();
  for (const [token, record] of passedPreflights) {
    if (record.expiresAt < now) passedPreflights.delete(token);
  }
  const token = crypto.randomUUID();
  passedPreflights.set(token, { fingerprint: postFingerprint(body), expiresAt: now + PREFLIGHT_VALID_MS });
  return token;
}

// Says the app is running, which mode it is in, and which platforms and scenarios to show. It never includes the key.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mock: blotato.isMockMode(),
    hasApiKey: blotato.isMockMode() || blotato.hasApiKey(),
    scenarios: blotato.mockScenarios,
    platforms: Object.entries(PLATFORM_RULES).map(([id, rules]) => ({ id, label: rules.label })),
    maxUploadBytes,
  });
});

// Receives an uploaded file as raw bytes (the file name comes in the X-Filename header). Prefers
// no extra package: express.raw() is built into Express. The file is saved under a random name.
app.post('/api/uploads', express.raw({ type: '*/*', limit: maxUploadBytes }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ message: 'No file was received. Choose an image or video file and try again.' });
  }
  const rawName = decodeURIComponent(String(req.get('x-filename') || 'upload'));
  const filename = (rawName.replace(/[^\w.\-]/g, '_').slice(-120)) || 'upload';
  const uploadId = crypto.randomUUID();
  const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);
  try {
    await fs.promises.writeFile(filePath, req.body);
  } catch (error) {
    return res.status(500).json({ message: 'The file could not be saved on this computer. Try again.' });
  }
  const timer = setTimeout(() => deleteUpload(uploadId), UPLOAD_TTL_MS);
  timer.unref(); // Never keep the app alive just to wait for this cleanup.
  uploads.set(uploadId, { path: filePath, filename, size: req.body.length, createdAt: Date.now(), timer });
  res.status(201).json({ uploadId, filename, size: req.body.length });
});

// Lists the connected social accounts. Only the id, platform, username and name are sent to the page.
app.get('/api/accounts', async (req, res) => {
  try {
    const items = await blotato.listAccounts();
    res.json({ accounts: items.map(({ id, platform, username, fullname }) => ({ id, platform, username, fullname })) });
  } catch (error) {
    res.status(502).json({ message: 'Could not load your accounts from Blotato.', explanation: explainError(error.message, error.httpStatus) });
  }
});

app.post('/api/preflight', async (req, res, next) => {
  try {
    const body = req.body || {};
    blotato.setMockScenario(body.mockScenario);
    const result = await runPreflight({ ...body, upload: resolveUpload(body) });
    if (result.allPassed) result.preflightToken = rememberPassedPreflight(body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Sends the post. Each platform gets its own result, because one can fail while another works.
app.post('/api/send', async (req, res) => {
  const { caption, mediaUrl, platforms, source, uploadId, mockScenario, preflightToken, confirmPublish, accountIds, scheduledTime } = req.body || {};
  const chosen = (Array.isArray(platforms) ? platforms : []).filter((platform) => Object.hasOwn(PLATFORM_RULES, platform));
  const isUpload = source === 'upload';
  if (chosen.length === 0) {
    return res.status(400).json({ message: 'At least one platform is needed.' });
  }
  let uploadRecord;
  if (isUpload) {
    uploadRecord = uploadId && uploads.get(uploadId);
    if (!uploadRecord) {
      return res.status(409).json({ message: 'The uploaded file is no longer available. Upload it again, run Preflight, then send.' });
    }
  } else if (typeof mediaUrl !== 'string' || !mediaUrl.trim()) {
    return res.status(400).json({ message: 'A media link and at least one platform are needed.' });
  }

  // Optional schedule. Checked before the preflight pass is used, so a mistake here doesn't waste it.
  let scheduledUtc;
  if (scheduledTime !== undefined && scheduledTime !== null && scheduledTime !== '') {
    const when = typeof scheduledTime === 'string' ? new Date(scheduledTime) : new Date(NaN);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ message: 'The scheduled time is not a valid date and time. Pick it again.' });
    }
    if (when.getTime() <= Date.now()) {
      return res.status(400).json({ message: 'The scheduled time is in the past. Pick a time in the future.' });
    }
    scheduledUtc = when.toISOString().replace(/\.\d{3}Z$/, 'Z'); // UTC ISO 8601, e.g. 2026-11-10T15:30:00Z
  }

  // Real posts need a clear "yes" from the person using the page.
  if (!blotato.isMockMode() && confirmPublish !== true) {
    return res.status(400).json({ message: 'Real publishing needs your confirmation. Tick the confirmation box first.' });
  }

  // No passed preflight for exactly this post means no publishing. Each pass works once.
  const record = passedPreflights.get(preflightToken);
  passedPreflights.delete(preflightToken);
  if (!record || record.expiresAt < Date.now() || record.fingerprint !== postFingerprint({ caption, source, mediaUrl, uploadId, platforms: chosen })) {
    return res.status(409).json({ message: 'This post has no valid passed preflight. Run Preflight again, then send.' });
  }

  const failure = (platform, error) => ({
    platform,
    state: 'failed',
    explanation: explainError(error.message, error.httpStatus),
  });

  blotato.setMockScenario(mockScenario);

  let accounts;
  let blotatoMediaUrl;
  try {
    accounts = await blotato.listAccounts();
    // Upload the file (or copy the link) to Blotato once, then reuse that one URL for every platform.
    blotatoMediaUrl = isUpload
      ? await blotato.uploadMediaFile({ filePath: uploadRecord.path, filename: uploadRecord.filename })
      : await blotato.uploadMedia(mediaUrl.trim());
  } catch (error) {
    return res.json({ results: chosen.map((platform) => failure(platform, error)) });
  }
  // The bytes are now on Blotato, so the temporary local copy is no longer needed.
  if (isUpload) deleteUpload(uploadId);

  const results = [];
  for (const platform of chosen) {
    const matches = accounts.filter((item) => item.platform === platform);
    const wantedId = accountIds && accountIds[platform];
    // With several accounts, only post to the one the person chose. Never guess.
    const account = wantedId ? matches.find((item) => item.id === wantedId) : matches.length === 1 ? matches[0] : null;
    if (!account) {
      results.push(failure(platform, new Error(`Account not found for ${PLATFORM_RULES[platform].label}.`)));
      continue;
    }
    try {
      const postSubmissionId = await blotato.publishPost({
        accountId: account.id,
        text: String(caption || ''),
        mediaUrls: [blotatoMediaUrl],
        platform,
        scheduledTime: scheduledUtc,
      });
      results.push({ platform, state: 'in-progress', postSubmissionId, account: account.username });
    } catch (error) {
      results.push(failure(platform, error));
    }
  }
  res.json({ results });
});

// The page asks this every 5 seconds to follow one post.
app.get('/api/status/:postSubmissionId', async (req, res) => {
  if (!/^[\w-]{1,100}$/.test(req.params.postSubmissionId)) {
    return res.status(400).json({ message: 'That is not a valid post ID.' });
  }
  try {
    const status = await blotato.getPostStatus(req.params.postSubmissionId);
    if (status.status === 'failed') status.explanation = explainError(status.errorMessage);
    res.json(status);
  } catch (error) {
    res.status(502).json({
      lookupFailed: true,
      httpStatus: error.httpStatus || null,
      explanation: explainError(error.message, error.httpStatus),
    });
  }
});

// Any unexpected crash becomes a short readable message. The details stay in the terminal, not on the page.
app.use((error, req, res, next) => {
  // A file bigger than any platform allows: say so clearly, with the limit.
  if (error.type === 'entity.too.large' || error.status === 413) {
    return res.status(413).json({ message: `That file is too big. The largest size any platform allows is ${describeMax(maxUploadBytes)}. Choose a smaller file.` });
  }
  const status = error.status || 500;
  if (status >= 500) console.error(`[${new Date().toISOString()}] Server error:`, error);
  res.status(status).json({ message: status >= 500 ? 'Something went wrong in the app. Check the terminal window for details.' : 'That request could not be understood.' });
});

// 127.0.0.1 means only this computer can open the app, which protects your API key.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Blotato Preflight is running at http://localhost:${PORT}`);
  console.log(`Mode: ${blotato.isMockMode() ? 'MOCK (fake Blotato, nothing is really posted)' : 'REAL (posts really are published)'}`);
  if (!blotato.isMockMode() && !blotato.hasApiKey()) {
    console.warn('Warning: BLOTATO_API_KEY is empty in .env, so publishing is blocked until you add it.');
  }
  if (allowPrivateMedia) {
    console.warn('Warning: test setting PREFLIGHT_ALLOW_PRIVATE_MEDIA is on, so private links are NOT blocked. Do not use this normally.');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The app may already be running in another window: close it and try again.`);
    console.error('Or choose another port: open .env, set PORT=3001 (any free number), save, and run npm start again.');
    process.exit(1);
  }
  throw error;
});

module.exports = server;
