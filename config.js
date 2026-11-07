// config.js
// Reads the settings. npm start loads them from .env with "node --env-file=.env"
// (built into Node.js 20.6 and newer), so they are ready before this file runs.

// Real mode only when the setting says "false", so a missing setting or a typo can never publish a real post.
function parseMockMode(value) {
  return String(value === undefined ? 'true' : value).trim().toLowerCase() !== 'false';
}

const { MAX_MEDIA_BYTES } = require('./platformRules');

const mockMode = parseMockMode(process.env.BLOTATO_MOCK);

module.exports = {
  parseMockMode,
  mockMode,
  PORT: Number(process.env.PORT) || 3000,
  // Automated tests use media from a test website on this computer, which the safety
  // rules normally block. This switch is ignored in real mode.
  allowPrivateMedia: mockMode && process.env.PREFLIGHT_ALLOW_PRIVATE_MEDIA === 'true',
  // Biggest uploaded file accepted. Normally the largest size any platform allows.
  // Tests may set a tiny limit to prove the "too big" message; this override is ignored in real mode.
  maxUploadBytes: (mockMode && Number(process.env.PREFLIGHT_MAX_UPLOAD_BYTES)) || MAX_MEDIA_BYTES,
};
