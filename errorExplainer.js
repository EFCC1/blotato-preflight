// errorExplainer.js
// Turns a Blotato error message into plain English plus an exact fix.

const FAILED_DASHBOARD_URL = 'https://my.blotato.com/failed';

const BAD_MEDIA_FIX =
  'Use a direct public file link, not a Google Drive share link. Upload the file somewhere that serves the raw file.';

// Each entry: "test" recognises the error, and the other two fields are shown to the user.
const KNOWN_ERRORS = [
  {
    test: (message) => /api key is missing/i.test(message),
    meaning: 'Real mode is on, but there is no API key in the .env file, so nothing was sent to Blotato.',
    fix: 'Open .env and paste your key from Blotato Settings > API after BLOTATO_API_KEY=, then restart the app. To keep testing without a key, set BLOTATO_MOCK=true.',
  },
  {
    // The real API was seen answering just "Unauthorized" to a wrong key, so match both wordings.
    test: (message, httpStatus) => httpStatus === 401 || /authorization failed|unauthorized|wrong blotato api key/i.test(message),
    meaning: 'Blotato did not accept your API key, so it refused the request.',
    fix: 'Copy the key again from Blotato Settings > API, with no spaces, including any "=" at the end.',
  },
  {
    test: (message) => /failed to fetch media url/i.test(message),
    meaning: 'Blotato tried to download your media file, but the link refused to give it the file.',
    fix: BAD_MEDIA_FIX,
  },
  {
    test: (message) => /failed to read media metadata/i.test(message),
    meaning: 'Blotato reached your link, but what it got back was not a readable image or video file.',
    fix: BAD_MEDIA_FIX,
  },
  {
    // From Blotato's error docs: the link did not give a usable media file.
    test: (message) => /could not upload media to storage|failed to upload stream|media conversion failed|invalid data found when processing input/i.test(message),
    meaning: 'Blotato could not save or process your media, usually because the link did not give it a real media file.',
    fix: BAD_MEDIA_FIX,
  },
  {
    test: (message) => /invalid file format|unsupported media format/i.test(message),
    meaning: "The file's format is not one the platform accepts. A file's name alone doesn't prove its real format.",
    fix: 'Export the video as a real MP4 (H.264 video with AAC audio), or the image as a JPEG.',
  },
  {
    test: (message) => /invalid video dimensions/i.test(message),
    meaning: "The video's width and height are outside what the platform accepts.",
    fix: 'Export the video again at a standard size, such as 1080x1920 for vertical video.',
  },
  {
    test: (message) => /account .*not found/i.test(message),
    meaning: 'Blotato does not recognise that account for your key and this platform.',
    fix: 'Check the account is still connected in Blotato, then run Preflight again to reload your accounts.',
  },
  {
    test: (message, httpStatus) => httpStatus === 503 || httpStatus === 504 || /service unavailable|gateway timeout/i.test(message),
    meaning: 'Blotato was temporarily unavailable, so this app could not tell whether the post was accepted.',
    fix: `Before trying again, check ${FAILED_DASHBOARD_URL} and your Blotato posts, so you do not publish the same post twice.`,
  },
  {
    test: (message) => /aspect ratio/i.test(message),
    meaning: "The shape of your image or video (its width compared to its height) is one the platform doesn't accept.",
    fix: 'Resize the media to a ratio the platform supports.',
  },
  {
    test: (message, httpStatus) => httpStatus === 429 || /too many requests/i.test(message),
    meaning: 'You sent more requests than Blotato allows in a short time, so it paused you.',
    fix: 'Wait one minute and send again, or space out posts.',
  },
];

function explainError(rawMessage, httpStatus) {
  const message = String(rawMessage || 'Unknown error (Blotato gave no message)');
  const known = KNOWN_ERRORS.find((entry) => entry.test(message, httpStatus));

  if (known) {
    return { rawMessage: message, known: true, meaning: known.meaning, fix: known.fix };
  }
  return {
    rawMessage: message,
    known: false,
    meaning: `This error is not in our list yet. Blotato said: "${message}"`,
    fix: `Open ${FAILED_DASHBOARD_URL} to see the failed post in Blotato.`,
  };
}

module.exports = { explainError };
