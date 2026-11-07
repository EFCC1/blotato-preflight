// server.js
// The backend: serves the web page and answers its requests.

const crypto = require('crypto');
const path = require('path');
const { PORT, allowPrivateMedia } = require('./config');
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
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
function postFingerprint({ caption, mediaUrl, platforms }) {
  return JSON.stringify([String(caption || ''), String(mediaUrl || '').trim(), [...platforms].sort()]);
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
  });
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
    const result = await runPreflight(body);
    if (result.allPassed) result.preflightToken = rememberPassedPreflight(body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Sends the post. Each platform gets its own result, because one can fail while another works.
app.post('/api/send', async (req, res) => {
  const { caption, mediaUrl, platforms, mockScenario, preflightToken, confirmPublish, accountIds } = req.body || {};
  const chosen = (Array.isArray(platforms) ? platforms : []).filter((platform) => Object.hasOwn(PLATFORM_RULES, platform));
  if (chosen.length === 0 || typeof mediaUrl !== 'string' || !mediaUrl.trim()) {
    return res.status(400).json({ message: 'A media link and at least one platform are needed.' });
  }

  // Real posts need a clear "yes" from the person using the page.
  if (!blotato.isMockMode() && confirmPublish !== true) {
    return res.status(400).json({ message: 'Real publishing needs your confirmation. Tick the confirmation box first.' });
  }

  // No passed preflight for exactly this post means no publishing. Each pass works once.
  const record = passedPreflights.get(preflightToken);
  passedPreflights.delete(preflightToken);
  if (!record || record.expiresAt < Date.now() || record.fingerprint !== postFingerprint({ caption, mediaUrl, platforms: chosen })) {
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
    blotatoMediaUrl = await blotato.uploadMedia(mediaUrl.trim());
  } catch (error) {
    return res.json({ results: chosen.map((platform) => failure(platform, error)) });
  }

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
