// blotatoClient.js
// Every call to Blotato goes through this file. The only difference between mock
// and real is the web address below, so both modes run exactly the same code.
// Request and response shapes follow https://backend.blotato.com/openapi.json

const fs = require('fs');
const { PORT, mockMode } = require('./config');
const mock = require('./mockBlotato');

const REAL_BASE_URL = 'https://backend.blotato.com/v2';
const MOCK_BASE_URL = `http://127.0.0.1:${PORT}/mock-blotato/v2`;
const REQUEST_TIMEOUT_MS = 60000; // Uploads can be slow, so give Blotato up to a minute.

const baseUrl = mockMode ? MOCK_BASE_URL : REAL_BASE_URL;
// The key is used exactly as written in .env, never trimmed, so a key ending in "=" stays whole.
const apiKey = String(process.env.BLOTATO_API_KEY || '');

// An error that remembers the web status code (like 401) as well as the message.
class BlotatoError extends Error {
  constructor(message, httpStatus) {
    super(hideKey(message)); // Error text reaches the page, so the key must never be in it.
    this.httpStatus = httpStatus;
  }
}

// Removes the API key from anything we print, even if it appears inside a message.
function hideKey(text) {
  return apiKey ? String(text).split(apiKey).join('[HIDDEN]') : String(text);
}

function log(label, details) {
  const mode = mockMode ? 'MOCK' : 'REAL';
  console.log(`[${new Date().toISOString()}] [Blotato ${mode}] ${label}\n${hideKey(JSON.stringify(details, null, 2))}\n`);
}

// Sends one request to Blotato, logs both directions, and returns the JSON answer.
async function callBlotato(method, path, body) {
  // In real mode with no key, stop here: there is no point contacting Blotato.
  if (!mockMode && !apiKey) {
    log(`NOT SENT  ${method} ${path}`, { reason: 'BLOTATO_API_KEY is empty' });
    throw new BlotatoError('API key is missing: BLOTATO_API_KEY is empty in .env', 401);
  }

  const url = `${baseUrl}${path}`;
  log(`REQUEST  ${method} ${url}`, {
    headers: { 'blotato-api-key': apiKey ? '[HIDDEN]' : '(empty)', 'Content-Type': 'application/json' },
    body: body === undefined ? null : body,
  });

  let response;
  let responseText;
  try {
    response = await fetch(url, {
      method,
      headers: { 'blotato-api-key': apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    responseText = await response.text();
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'Blotato did not answer in time' : `Could not reach Blotato: ${(error.cause && error.cause.code) || error.message}`;
    log(`NETWORK ERROR  ${method} ${url}`, { error: reason });
    throw new BlotatoError(reason);
  }

  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { message: `Blotato sent a reply that is not JSON: ${responseText.slice(0, 200)}` };
  }
  log(`RESPONSE ${response.status} ${method} ${url}`, data);

  if (!response.ok) {
    throw new BlotatoError(data.message || `Blotato answered with status ${response.status}`, response.status);
  }
  return data;
}

// Tells the fake Blotato which result to force. Does nothing in real mode.
function setMockScenario(scenarioId) {
  if (mockMode) mock.setScenario(scenarioId);
}

// Returns [{ id, platform, fullname, username }]. The "id" is the accountId used to post.
async function listAccounts() {
  const data = await callBlotato('GET', '/users/me/accounts');
  return data.items;
}

// Copies the public link onto Blotato's own domain and returns the new link to use when posting.
// The OpenAPI file requires this. The help docs call it optional, so doing it satisfies both.
// Links already on Blotato are used as they are.
async function uploadMedia(mediaUrl) {
  if (new URL(mediaUrl).hostname.endsWith('.blotato.io')) return mediaUrl;
  const data = await callBlotato('POST', '/media', { url: mediaUrl });
  return data.url;
}

// The Content-Type sent with the raw file, worked out from the file's ending.
const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
function contentTypeFromFilename(filename) {
  const ext = String(filename).split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// Uploads a LOCAL file using Blotato's presigned flow (OpenAPI: POST /v2/media/uploads):
//   1. Ask for a one-time upload URL, giving the file name.
//   2. PUT the raw bytes straight to that URL (no API key: the URL itself is the permission).
//   3. Use the returned public URL when posting.
// Returns the public URL. The file is uploaded once, then used for every platform.
async function uploadMediaFile({ filePath, filename }) {
  const bytes = await fs.promises.readFile(filePath);
  const { presignedUrl, publicUrl } = await callBlotato('POST', '/media/uploads', { filename });

  log('PUT (raw file bytes)', { url: presignedUrl, bytes: bytes.length, contentType: contentTypeFromFilename(filename) });
  let response;
  try {
    response = await fetch(presignedUrl, {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': contentTypeFromFilename(filename) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'Uploading the file to Blotato timed out' : `Could not upload the file to Blotato: ${(error.cause && error.cause.code) || error.message}`;
    throw new BlotatoError(reason);
  }
  if (!response.ok) {
    throw new BlotatoError(`Uploading the file to Blotato failed with status ${response.status}.`, response.status);
  }
  return publicUrl;
}

function buildTarget(platform) {
  if (platform === 'tiktok') {
    return {
      targetType: 'tiktok',
      privacyLevel: 'SELF_ONLY', // Only you can see the post, a safe default.
      disabledComments: false,
      disabledDuet: false,
      disabledStitch: false,
      isBrandedContent: false,
      isYourBrand: false,
      isAiGenerated: false,
    };
  }
  return { targetType: platform };
}

// Starts publishing and returns the postSubmissionId used to track it.
// scheduledTime (optional) is a UTC ISO 8601 time. The OpenAPI file puts it at the top level, next to "post".
async function publishPost({ accountId, text, mediaUrls, platform, scheduledTime }) {
  const body = {
    post: {
      accountId,
      content: { text, mediaUrls, platform },
      target: buildTarget(platform),
    },
  };
  if (scheduledTime) body.scheduledTime = scheduledTime;
  const data = await callBlotato('POST', '/posts', body);
  return data.postSubmissionId;
}

// Returns { postSubmissionId, status, scheduledTime?, publicUrl?, errorMessage? }.
async function getPostStatus(postSubmissionId) {
  return callBlotato('GET', `/posts/${encodeURIComponent(postSubmissionId)}`);
}

module.exports = {
  isMockMode: () => mockMode,
  baseUrl,
  hasApiKey: () => apiKey.length > 0,
  mockScenarios: mockMode ? mock.SCENARIOS : [],
  setMockScenario,
  listAccounts,
  uploadMedia,
  uploadMediaFile,
  publishPost,
  getPostStatus,
};
