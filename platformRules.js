// platformRules.js
// Every platform rule lives in this one file, so there is only one place to update.
//
// All values below were read on 2026-11-07 from Blotato's "Media Requirements" page:
//   https://help.blotato.com/rest-api-reference/publish-post/media
// A comment says when a value has a different source, or when the docs give no rule.
//
// "formats" are the formats the docs say the platform accepts.
// "maybeConverted" are formats Blotato may convert, which the docs don't guarantee will work.
// "aspect: null" means the docs set no firm rule, so the check is shown as skipped, not passed.

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Allowed difference when comparing ratios: 0.01 means 1%.
// Source: our own choice, because real files are rarely exact (1200x628 is 1.911, not 1.91).
const ASPECT_RATIO_TOLERANCE = 0.01;

// Source: Blotato OpenAPI file, POST /v2/media ("limited to 1GB"). The docs add that Starter plans
// are limited to 400 MB, which this app can't check because it doesn't know your plan.
const MAX_DOWNLOAD_BYTES = 1 * GB;

const INSTAGRAM_ASPECT = {
  ranges: [{ label: '4:5 to 1.91:1', min: 4 / 5, max: 1.91 }], // Docs: feed images and feed videos. Includes 1:1.
  exact: [{ label: '9:16', value: 9 / 16 }], // Docs: Reel and Story preset. Also listed in the project brief.
};

const PLATFORM_RULES = {
  instagram: {
    label: 'Instagram',
    captionMaxLength: 2200, // Docs: "limited to 2200 characters"
    maxHashtags: 5, // Blotato error docs: "Instagram allows a maximum of 5 hashtags per post" (a Blotato guardrail)
    image: {
      formats: ['jpg', 'png'], // Docs: "JPEG, PNG"
      maybeConverted: [],
      maxBytes: 8 * MB, // Docs: "Maximum of 8 MB"
      aspect: INSTAGRAM_ASPECT,
    },
    video: {
      formats: ['mp4', 'mov'], // Docs: "MP4 and MOV"
      maybeConverted: [],
      maxBytes: 300 * MB, // Docs: "Maximum of 300 MB"
      aspect: INSTAGRAM_ASPECT,
    },
  },
  tiktok: {
    label: 'TikTok',
    captionMaxLength: 2200, // Docs: "The character limit is 2200 characters"
    image: {
      formats: ['jpg', 'webp'], // Docs: "JPEG and WebP"
      maybeConverted: ['png', 'gif'], // Docs: Blotato "requests JPEG conversion for non-JPEG images", not guaranteed
      maxBytes: 20 * MB, // Docs: "no more than 20 MB per image"
      aspect: null,
      aspectNote: "Blotato's docs give no TikTok aspect ratio rule for images.",
    },
    video: {
      formats: ['mp4', 'webm', 'mov'], // Docs: "MP4 (recommended), WebM, and MOV"
      maybeConverted: [],
      maxBytes: 1 * GB, // Docs: "Up to 1 GB, subject to the 400 MB Starter upload limit"
      aspect: null,
      aspectNote: "Blotato's docs give no TikTok aspect ratio rule for videos.",
    },
  },
  linkedin: {
    label: 'LinkedIn',
    captionMaxLength: 3000, // Docs: "up to 3000 characters per post"
    image: {
      formats: ['jpg', 'gif', 'png'], // Docs: "JPG, GIF, and PNG"
      maybeConverted: [],
      maxBytes: 5 * MB, // Docs: "Images must be <= 5 MB"
      aspect: null,
      aspectNote: 'For LinkedIn images the docs only recommend 1.91:1, so this is not a firm rule.',
    },
    video: {
      formats: ['mp4'], // Docs: "MP4"
      maybeConverted: ['mov', 'webm'], // Docs: non-MP4 is converted "only when they are 120 seconds or shorter"
      minBytes: 75 * 1024, // Docs: "Between 75 KB and 500 MB"
      maxBytes: 500 * MB, // Docs: "Between 75 KB and 500 MB"
      aspect: {
        ranges: [],
        exact: [
          { label: '16:9', value: 16 / 9 }, // Docs: "Landscape: 16:9"
          { label: '9:16', value: 9 / 16 }, // Docs: "Portrait: 9:16"
          { label: '1:1', value: 1 / 1 }, // Docs: "Square: 1:1"
        ],
      },
    },
  },
};

// The biggest file any platform allows. An uploaded file bigger than this can't be used
// anywhere, so the app rejects it early with a clear message. Today this is TikTok's 1 GB video.
const MAX_MEDIA_BYTES = Math.max(
  ...Object.values(PLATFORM_RULES).flatMap((rules) => [rules.image && rules.image.maxBytes, rules.video && rules.video.maxBytes]).filter(Boolean)
);

module.exports = { PLATFORM_RULES, ASPECT_RATIO_TOLERANCE, MAX_DOWNLOAD_BYTES, MAX_MEDIA_BYTES };
