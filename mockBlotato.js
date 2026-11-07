// mockBlotato.js
// A fake Blotato that runs inside this app. It answers the same addresses and returns
// the same shapes as the real API (taken from https://backend.blotato.com/openapi.json),
// so blotatoClient.js cannot tell the difference.

const crypto = require('crypto');
const express = require('express');

const SCENARIOS = [
  { id: 'success', label: 'Success' },
  { id: 'wrong-api-key', label: 'Wrong API key' },
  { id: 'media-fetch-failed', label: 'Media fetch failed' },
  { id: 'bad-media-file', label: 'Bad media file' },
  { id: 'aspect-ratio', label: 'Aspect ratio' },
  { id: 'rate-limit', label: 'Rate limit' },
  { id: 'stuck', label: 'Stuck in progress' },
  { id: 'no-tiktok-linkedin-account', label: 'Only Instagram connected' },
];

// Scenarios where the post is accepted, then fails later while Blotato processes it.
const LATE_FAILURES = {
  'media-fetch-failed': 'Failed to fetch media URL: 403 Forbidden',
  'bad-media-file': 'Failed to read media metadata. Is the file accessible and a valid media file?',
  'aspect-ratio': 'The aspect ratio is not supported',
};

const IN_PROGRESS_CHECKS = 2; // Answer "in-progress" this many times before the final result.
const FAKE_DELAY_MS = 400; // A small pause so "Sending" is visible on screen.

let currentScenario = 'success';
const fakePosts = new Map(); // postSubmissionId -> { scenario, platform, checks }

function setScenario(scenarioId) {
  currentScenario = SCENARIOS.some((scenario) => scenario.id === scenarioId) ? scenarioId : 'success';
}

// Same shape as the real API's error responses.
function sendError(res, status, message) {
  res.status(status).json({ code: status, reqId: `mock-${crypto.randomUUID()}`, message });
}

// Rejects bad request bodies, like the real API does, so a mistake in our code shows up in testing.
function findProblemInPost(body) {
  const post = body && body.post;
  if (!post) return '"post" is missing.';
  if (!post.accountId) return '"post.accountId" is missing.';
  if (!post.content || typeof post.content.text !== 'string') return '"post.content.text" is missing.';
  if (!Array.isArray(post.content.mediaUrls)) return '"post.content.mediaUrls" must be a list.';
  if (!post.content.platform) return '"post.content.platform" is missing.';
  if (!post.target || !post.target.targetType) return '"post.target.targetType" is missing.';

  if (post.target.targetType === 'tiktok') {
    const allowedPrivacy = ['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR'];
    if (!allowedPrivacy.includes(post.target.privacyLevel)) return '"post.target.privacyLevel" is not valid.';
    const requiredBooleans = ['disabledComments', 'disabledDuet', 'disabledStitch', 'isBrandedContent', 'isYourBrand', 'isAiGenerated'];
    const missing = requiredBooleans.find((field) => typeof post.target[field] !== 'boolean');
    if (missing) return `"post.target.${missing}" must be true or false.`;
  }
  return null;
}

function createMockRouter() {
  const router = express.Router();

  router.use(async (req, res, next) => {
    await new Promise((resolve) => setTimeout(resolve, FAKE_DELAY_MS));
    if (currentScenario === 'wrong-api-key') {
      return sendError(res, 401, 'Authorization failed - please check your credentials');
    }
    next();
  });

  router.get('/users/me/accounts', (req, res) => {
    const items = [
      { id: 'mock-instagram-1', platform: 'instagram', fullname: 'Mock Instagram', username: '@mock_instagram' },
      { id: 'mock-instagram-2', platform: 'instagram', fullname: 'Mock Instagram Two', username: '@mock_instagram_two' },
      { id: 'mock-tiktok-1', platform: 'tiktok', fullname: 'Mock TikTok', username: '@mock_tiktok' },
      { id: 'mock-linkedin-1', platform: 'linkedin', fullname: 'Mock LinkedIn', username: 'mock-linkedin' },
    ];
    const onlyInstagram = currentScenario === 'no-tiktok-linkedin-account';
    res.json({ items: onlyInstagram ? items.filter((item) => item.platform === 'instagram') : items });
  });

  router.post('/media', (req, res) => {
    if (!req.body || !req.body.url) return sendError(res, 422, '"url" is missing.');
    const id = `media_${crypto.randomUUID()}`;
    res.status(201).json({ url: `https://database.blotato.io/mock/${id}`, id });
  });

  router.post('/posts', (req, res) => {
    if (currentScenario === 'rate-limit') {
      return sendError(res, 429, 'The service is receiving too many requests from you');
    }
    const problem = findProblemInPost(req.body);
    if (problem) return sendError(res, 422, problem);

    const postSubmissionId = crypto.randomUUID();
    fakePosts.set(postSubmissionId, {
      scenario: currentScenario,
      platform: req.body.post.content.platform,
      checks: 0,
    });
    res.status(201).json({ postSubmissionId });
  });

  router.get('/posts/:postSubmissionId', (req, res) => {
    const { postSubmissionId } = req.params;
    const post = fakePosts.get(postSubmissionId);

    // The real API also answers "in-progress" when no record exists.
    if (!post) return res.json({ postSubmissionId, status: 'in-progress' });

    post.checks += 1;
    if (post.scenario === 'stuck' || post.checks <= IN_PROGRESS_CHECKS) {
      return res.json({ postSubmissionId, status: 'in-progress' });
    }
    if (LATE_FAILURES[post.scenario]) {
      return res.json({ postSubmissionId, status: 'failed', errorMessage: LATE_FAILURES[post.scenario] });
    }
    res.json({
      postSubmissionId,
      status: 'published',
      publicUrl: `https://example.com/mock-post/${post.platform}/${postSubmissionId}`,
    });
  });

  return router;
}

module.exports = { SCENARIOS, setScenario, createMockRouter };
