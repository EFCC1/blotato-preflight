// preflight.js
// Runs the checks on a post BEFORE it is sent. Each check returns one row for the page:
// { name, status: 'pass' | 'fail' | 'skipped', reason }
// A row only says "pass" if that check really ran and succeeded.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageSize } = require('image-size');
const { PLATFORM_RULES, ASPECT_RATIO_TOLERANCE, MAX_DOWNLOAD_BYTES } = require('./platformRules');
const { BlockedUrlError, openMedia, validateMediaUrl } = require('./mediaFetcher');
const blotato = require('./blotatoClient');
const { explainError } = require('./errorExplainer');

const CONNECT_TIMEOUT_MS = 15000; // How long the link gets to start answering.
const DOWNLOAD_TIMEOUT_MS = 60000; // How long we keep downloading the file after that.
const FFPROBE_TIMEOUT_MS = 30000;
const IMAGE_HEAD_BYTES = 25 * 1024 * 1024; // Keep up to this much of an image in memory to read its size.

// ffprobe only opens the local temporary file, and only in these real video formats. A file
// pretending to be a video can't make it fetch other files or web addresses.
const FFPROBE_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm';

const pass = (name, reason) => ({ name, status: 'pass', reason });
const fail = (name, reason) => ({ name, status: 'fail', reason });
const skipped = (name, reason) => ({ name, status: 'skipped', reason });

const toMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;
const formatName = (format) => format.toUpperCase();
const formatList = (formats) => formats.map(formatName).join(', ');

// "JPG or PNG", "16:9, 9:16 or 1:1".
function listWithOr(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

// "3:4" for 1200x1600: the simplest whole-number ratio within 1%, or "about 0.71:1" if there isn't a short one.
function describeRatio(width, height) {
  const actual = width / height;
  for (let bottom = 1; bottom <= 20; bottom += 1) {
    const top = Math.round(actual * bottom);
    if (top > 0 && Math.abs(top / bottom - actual) / actual <= 0.01) return `${top}:${bottom}`;
  }
  return `about ${actual.toFixed(2)}:1`;
}

function describeFetchError(error) {
  if (error instanceof BlockedUrlError) return error.message;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return `The link did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds (a timeout). Blotato would probably give up too. Try a faster or more reliable host.`;
  }
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'That website address could not be found. Check the link for typos.';
  if (error.code === 'ECONNREFUSED') return 'The website refused the connection, so it may be down. Check the link opens in your browser, or host the file somewhere else.';
  if (String(error.code || '').includes('CERT') || error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return 'The website has a broken security certificate, so the link could not be opened safely. Host the file on a site with a working https:// address.';
  }
  return `Could not open the link (${error.code || 'connection problem'}). Check it opens in a private browser window without logging in, then run Preflight again.`;
}

function describeBadStatus(status) {
  if (status === 403) return 'The link answered 403 Forbidden, which means the file is private or blocks outside access. Blotato would be refused too. Use a public link.';
  if (status === 404) return 'The link answered 404 Not Found, which means no file exists there. It may be deleted, expired, or mistyped. Check the link, or upload the file again and use the new link.';
  return `The link answered with status ${status}, but it needs to answer 200 (OK) for Blotato to download the file. Check it opens in a private browser window without logging in.`;
}

// Downloads the file within the size and time limits, without ever keeping more than needed.
// Images: the start is kept in memory to read the size. Videos: saved to a temporary file for ffprobe.
async function downloadBody(response, { isImage, tempFile, armDownloadTimer }) {
  const result = { bytes: 0, complete: false, timedOut: false, tooLarge: false, error: null, head: null };
  const headChunks = [];
  let headBytes = 0;
  const output = isImage ? null : await fs.promises.open(tempFile, 'w');

  armDownloadTimer();
  try {
    for await (const chunk of response) {
      result.bytes += chunk.length;
      if (result.bytes > MAX_DOWNLOAD_BYTES) {
        result.tooLarge = true;
        break;
      }
      if (output) {
        await output.write(chunk);
      } else if (headBytes < IMAGE_HEAD_BYTES) {
        headChunks.push(chunk);
        headBytes += chunk.length;
      }
    }
    result.complete = !result.tooLarge;
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') result.timedOut = true;
    else result.error = error;
  } finally {
    response.destroy();
    if (output) await output.close();
  }
  if (isImage) result.head = Buffer.concat(headChunks, headBytes);
  return result;
}

// Returns { width, height, format } or null if it isn't a readable image.
function readImageInfo(buffer) {
  try {
    const { width, height, orientation, type } = imageSize(buffer);
    if (!width || !height) return null;
    // Phone photos can be stored sideways with a "rotate me" note (orientation 5 to 8).
    return orientation >= 5 ? { width: height, height: width, format: type } : { width, height, format: type };
  } catch {
    return null;
  }
}

// Runs ffprobe on a local file. Returns { width, height, format }, or null if ffprobe isn't installed.
// execFile starts the program directly with no command shell, so nothing can be injected into the command.
function readVideoInfo(filePath) {
  const args = [
    '-v', 'error',
    '-protocol_whitelist', 'file',
    '-format_whitelist', FFPROBE_FORMATS,
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=format_name:format_tags=major_brand',
    '-of', 'json',
    filePath,
  ];

  return new Promise((resolve, reject) => {
    execFile('ffprobe', args, { timeout: FFPROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error && error.code === 'ENOENT') return resolve(null);
      if (error) return reject(new Error('ffprobe could not read it as a video'));

      const data = JSON.parse(stdout);
      const stream = (data.streams || [])[0];
      if (!stream || !stream.width || !stream.height) return reject(new Error('no video picture was found in the file'));

      // Phone videos are often stored sideways with a rotation note, so swap to match what viewers see.
      const sideData = (stream.side_data_list || []).find((item) => item.rotation !== undefined);
      const rotation = Number(sideData ? sideData.rotation : (stream.tags && stream.tags.rotate) || 0);
      const isSideways = Math.abs(rotation) % 180 === 90;
      const size = isSideways ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
      resolve({ ...size, format: videoFormatFrom(data.format || {}) });
    });
  });
}

// ffprobe reports MP4 and MOV under one name, so the file's "brand" tells them apart.
function videoFormatFrom({ format_name: name = '', tags = {} }) {
  if (name.includes('webm') || name.includes('matroska')) return 'webm';
  if (name.includes('mp4') || name.includes('mov')) return String(tags.major_brand || '').trim() === 'qt' ? 'mov' : 'mp4';
  return name;
}

const VIDEO_FORMATS_BY_TYPE = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

// The file's format guessed from its name ending. Used only when the file name is all we can read.
const EXT_FORMATS = { jpg: 'jpg', jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', mp4: 'mp4', mov: 'mov', webm: 'webm' };
function formatFromFilename(filename) {
  return EXT_FORMATS[String(filename || '').split('.').pop().toLowerCase()];
}
function looksLikeVideo(filename) {
  return ['mp4', 'mov', 'webm'].includes(formatFromFilename(filename));
}

// Reads the first bytes of a local file, enough to read an image's size.
async function readHead(filePath, maxBytes) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

function checkFormat(platform, kind, format, source) {
  const rules = PLATFORM_RULES[platform];
  const name = `File format: ${rules.label}`;
  const { formats, maybeConverted } = rules[kind];
  const shown = format ? formatName(format) : 'This format';

  if (formats.includes(format)) return pass(name, `${shown} (${source}) is a format ${rules.label} accepts for ${kind}s.`);
  if (maybeConverted.includes(format)) {
    return skipped(name, `${shown} is not a standard ${rules.label} ${kind} format. Blotato may convert it, but that is not guaranteed. To be safe, use ${formatList(formats)}.`);
  }
  return fail(name, `Your ${kind} is ${shown} (${source}), which ${rules.label} does not accept for ${kind}s. ${rules.label} accepts ${listWithOr(formats.map(formatName))}. Convert it to ${formatName(formats[0])}.`);
}

function checkFileSize(platform, kind, bytes, isExact) {
  const rules = PLATFORM_RULES[platform];
  const name = `File size: ${rules.label}`;
  const { maxBytes, minBytes } = rules[kind];

  if (bytes > maxBytes) {
    return fail(name, `Your ${kind} is ${toMb(bytes)}. ${rules.label} allows up to ${toMb(maxBytes)} for ${kind}s. Compress it or lower its resolution so it is at least ${toMb(bytes - maxBytes)} smaller.`);
  }
  if (!isExact) return skipped(name, `The full download did not finish, so the final size is unknown. The ${rules.label} limit is ${toMb(maxBytes)}.`);
  if (minBytes && bytes < minBytes) {
    return fail(name, `Your ${kind} is ${toMb(bytes)}. ${rules.label} needs at least ${toMb(minBytes)} for ${kind}s. Export it again at a higher quality so it is at least ${toMb(minBytes)}.`);
  }
  return pass(name, `${toMb(bytes)} is within the ${rules.label} limit of ${toMb(maxBytes)}.`);
}

function checkAspectRatio(platform, kind, { width, height }) {
  const rules = PLATFORM_RULES[platform];
  const name = `Aspect ratio: ${rules.label}`;
  const { aspect, aspectNote } = rules[kind];
  const actual = width / height;

  if (!aspect) return skipped(name, `${width}x${height} was read, but not judged. ${aspectNote}`);

  const near = (value) => Math.abs(actual - value) / value <= ASPECT_RATIO_TOLERANCE;
  const exact = aspect.exact.find((ratio) => near(ratio.value));
  const range = aspect.ranges.find((item) => (actual >= item.min || near(item.min)) && (actual <= item.max || near(item.max)));
  const allowed = [...aspect.ranges, ...aspect.exact].map((item) => item.label);

  if (exact) return pass(name, `${width}x${height} is ${exact.label}, which ${rules.label} supports.`);
  if (range) return pass(name, `${width}x${height} is about ${actual.toFixed(2)}:1, inside the ${range.label} range ${rules.label} supports.`);

  // Suggest the nearest allowed ratio, and the crop that keeps as much of the picture as possible.
  const targets = [
    ...aspect.ranges.flatMap((item) => {
      const [minLabel, maxLabel] = item.label.split(' to ');
      return [{ label: minLabel, value: item.min }, { label: maxLabel, value: item.max }];
    }),
    ...aspect.exact,
  ];
  const distance = (item) => Math.abs(Math.log(actual / item.value));
  const target = targets.reduce((best, item) => (distance(item) < distance(best) ? item : best));
  const crop = actual > target.value
    ? { width: Math.round(height * target.value), height }
    : { width, height: Math.round(width / target.value) };
  return fail(name, `Your ${kind} is ${describeRatio(width, height)} (${width}x${height}). ${rules.label} accepts ${listWithOr(allowed)}. Crop it to ${target.label} (${crop.width}x${crop.height}).`);
}

function checkCaption(platform, caption) {
  const rules = PLATFORM_RULES[platform];
  const name = `Caption: ${rules.label}`;
  const length = [...caption].length; // Counts an emoji as one character.

  if (length > rules.captionMaxLength) {
    const extra = length - rules.captionMaxLength;
    return fail(name, `Your caption has ${length} characters. ${rules.label} allows ${rules.captionMaxLength}. Remove ${extra} ${extra === 1 ? 'character' : 'characters'}.`);
  }
  if (rules.maxHashtags) {
    const hashtags = (caption.match(/(^|\s)#[^\s#]+/g) || []).length;
    if (hashtags > rules.maxHashtags) {
      return fail(name, `Your caption has ${hashtags} hashtags. ${rules.label} allows ${rules.maxHashtags}. Remove ${hashtags - rules.maxHashtags}.`);
    }
  }
  if (length === 0) return pass(name, `The caption is empty, which the Blotato API allows. The post will have no caption.`);
  return pass(name, `${length} of ${rules.captionMaxLength} characters used.`);
}

function checkAccount(platform, accounts, accountsError) {
  const rules = PLATFORM_RULES[platform];
  const name = `Connected account: ${rules.label}`;

  if (accountsError) {
    const { meaning, fix } = explainError(accountsError.message, accountsError.httpStatus);
    return fail(name, `${meaning} ${fix}`);
  }
  const matches = accounts.filter((account) => account.platform === platform);
  if (matches.length === 0) return fail(name, `No ${rules.label} account is connected to Blotato. Connect one in your Blotato settings, or untick ${rules.label}.`);
  if (matches.length === 1) return pass(name, `Will post as ${matches[0].username}.`);
  return pass(name, `${matches.length} accounts found. Choose which one to post as below.`);
}

// Checks everything about the link and file. Returns rows plus what was learned for the platform checks.
async function checkMedia(link, platforms) {
  const checks = [];
  const skipRest = (reason) => {
    checks.push(skipped('Media type', reason));
    checks.push(skipped('File can be downloaded', reason));
    checks.push(skipped('File format and size', reason));
    checks.push(skipped('Aspect ratio', reason));
  };
  const REACHABLE = 'Media link is reachable';

  // Google Drive check. It always runs, because it only needs the text of the link.
  const driveCheck = link.toLowerCase().includes('drive.google.com')
    ? fail('Not a Google Drive link', 'This is a Google Drive share link, which returns a web page instead of the file. Use a direct public file link.')
    : pass('Not a Google Drive link', 'This is not a Google Drive link.');

  if (!link) {
    checks.push(fail(REACHABLE, 'Paste a link to your image or video.'), driveCheck);
    skipRest('Could not check this without a link.');
    return checks;
  }

  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  const armDownloadTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  };
  let tempDir = null;

  try {
    let response;
    try {
      validateMediaUrl(link);
      response = await openMedia(link, controller.signal);
    } catch (error) {
      checks.push(fail(REACHABLE, describeFetchError(error)), driveCheck);
      skipRest('Could not check this because the link did not open.');
      return checks;
    }

    if (response.statusCode !== 200) {
      response.destroy();
      checks.push(fail(REACHABLE, describeBadStatus(response.statusCode)), driveCheck);
      skipRest('Could not check this because the link did not open.');
      return checks;
    }
    checks.push(pass(REACHABLE, 'The link answered 200 (OK).'), driveCheck);

    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const isImage = contentType.startsWith('image/');
    const isVideo = contentType.startsWith('video/');
    if (!isImage && !isVideo) {
      response.destroy();
      checks.push(fail('Media type', contentType === 'text/html'
        ? 'The link returns a web page (text/html), not the file itself. Use the direct link to the image or video.'
        : `The link returns "${contentType || 'an unknown type'}", which is not an image or a video. Use a direct link that opens only the image or video file itself.`));
      const reason = 'Could not check this until the link returns an image or video.';
      checks.push(skipped('File can be downloaded', reason), skipped('File format and size', reason), skipped('Aspect ratio', reason));
      return checks;
    }

    // Stop early if the website already says the file is too big.
    const declaredBytes = Number(response.headers['content-length']) || 0;
    const kind = isImage ? 'image' : 'video';
    if (declaredBytes > MAX_DOWNLOAD_BYTES) {
      response.destroy();
      checks.push(pass('Media type', `The link says it is a ${kind} (${contentType}). The file was not opened because it is too large.`));
      checks.push(fail('File can be downloaded', `The file is ${toMb(declaredBytes)}. Blotato's limit is ${toMb(MAX_DOWNLOAD_BYTES)}. Compress it so it is at least ${toMb(declaredBytes - MAX_DOWNLOAD_BYTES)} smaller.`));
      checks.push(skipped('File format and size', 'Not checked because the file is too large.'), skipped('Aspect ratio', 'Not checked because the file is too large.'));
      return checks;
    }

    if (isVideo) tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'blotato-preflight-'));
    const tempFile = tempDir && path.join(tempDir, 'media.bin');
    const download = await downloadBody(response, { isImage, tempFile, armDownloadTimer });

    if (download.tooLarge) {
      checks.push(pass('Media type', `The link says it is a ${kind} (${contentType}). The file was not fully read because it is too large.`));
      checks.push(fail('File can be downloaded', `The file is bigger than Blotato's limit of ${toMb(MAX_DOWNLOAD_BYTES)}. Compress it or shorten it to under ${toMb(MAX_DOWNLOAD_BYTES)}.`));
      checks.push(skipped('File format and size', 'Not checked because the file is too large.'), skipped('Aspect ratio', 'Not checked because the file is too large.'));
      return checks;
    }

    // Look inside the file, because a link can claim to be something it isn't.
    let info = null;
    let ffprobeMissing = false;
    let unreadable = !isImage && download.bytes === 0;
    if (isImage) {
      info = readImageInfo(download.head);
      unreadable = !info;
    } else if (!unreadable) {
      try {
        info = await readVideoInfo(tempFile);
        ffprobeMissing = info === null;
      } catch {
        unreadable = true;
      }
    }

    const sizeIsExact = download.complete;
    const bytesForLimits = sizeIsExact ? download.bytes : Math.max(declaredBytes, download.bytes);
    const stillDownloading = !sizeIsExact && (download.timedOut || download.error);

    if (unreadable && !stillDownloading) {
      checks.push(fail('Media type', `The link says it is a ${kind} (${contentType}), but the file could not be read as one. It may be damaged, or not really a ${kind}. Export it again as a standard ${isImage ? 'JPG or PNG' : 'MP4'} file and use the new link.`));
      checks.push(sizeIsExact
        ? pass('File can be downloaded', `Downloaded the whole file (${toMb(download.bytes)}).`)
        : fail('File can be downloaded', 'The download stopped partway through. Upload the file again, or host it somewhere more reliable, then run Preflight again.'));
      checks.push(skipped('File format and size', 'Not checked because the file is not readable.'), skipped('Aspect ratio', 'Not checked because the file is not readable.'));
      return checks;
    }

    if (ffprobeMissing) {
      checks.push(skipped('Media type', `The link says it is a video (${contentType}), but FFmpeg is not installed on this computer, so that could not be confirmed by looking inside the file.`));
    } else if (info) {
      checks.push(pass('Media type', `Confirmed by looking inside the file: it is a real ${kind} (${formatName(info.format)}).`));
    } else {
      checks.push(skipped('Media type', `The link says it is a ${kind} (${contentType}), but not enough of the file arrived to confirm that.`));
    }

    if (sizeIsExact) {
      checks.push(pass('File can be downloaded', `Downloaded the whole file (${toMb(download.bytes)}).`));
    } else if (download.timedOut) {
      checks.push(skipped('File can be downloaded', `Only ${toMb(download.bytes)} arrived in ${DOWNLOAD_TIMEOUT_MS / 1000} seconds, so the full download was not proven. A slow link can also make Blotato fail.`));
    } else {
      checks.push(fail('File can be downloaded', 'The download stopped partway through, so the link is unreliable. Upload the file again, or host it somewhere more reliable, then run Preflight again.'));
    }

    const format = info ? info.format : VIDEO_FORMATS_BY_TYPE[contentType];
    const source = info ? 'checked inside the file' : 'as stated by the link, not confirmed';
    platforms.forEach((platform) => {
      checks.push(info || ffprobeMissing
        ? checkFormat(platform, kind, format, source)
        : skipped(`File format: ${PLATFORM_RULES[platform].label}`, 'Not enough of the file arrived to tell its format.'));
      checks.push(checkFileSize(platform, kind, bytesForLimits, sizeIsExact));
      if (info) {
        checks.push(checkAspectRatio(platform, kind, info));
      } else if (ffprobeMissing) {
        checks.push(skipped(`Aspect ratio: ${PLATFORM_RULES[platform].label}`, 'This is a video and FFmpeg is not installed on this computer, so its size could not be read. Check the ratio yourself before sending.'));
      } else {
        checks.push(skipped(`Aspect ratio: ${PLATFORM_RULES[platform].label}`, 'Not enough of the file arrived to read its width and height.'));
      }
    });
    return checks;
  } finally {
    clearTimeout(timer);
    if (tempDir) await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Checks an UPLOADED file already on this computer. Same file checks as a link, but the
// link-only checks (reachable, Google Drive) are shown as "not needed", and the size is exact.
async function checkUpload(upload, platforms) {
  const checks = [];
  const NOT_NEEDED = 'Not needed. You uploaded the file directly, so there is no link to open.';
  checks.push(skipped('Media link is reachable', NOT_NEEDED));
  checks.push(skipped('Not a Google Drive link', NOT_NEEDED));

  const skipPlatforms = (reason) => platforms.forEach((platform) => {
    const label = PLATFORM_RULES[platform].label;
    checks.push(skipped(`File format: ${label}`, reason), skipped(`File size: ${label}`, reason), skipped(`Aspect ratio: ${label}`, reason));
  });

  if (!upload || upload.missing) {
    const reason = 'The uploaded file could not be found. Choose the file again, then run Preflight.';
    checks.push(fail('Media type', 'Choose a file to upload, then run Preflight.'));
    skipPlatforms(reason);
    return checks;
  }

  let bytes;
  try {
    ({ size: bytes } = await fs.promises.stat(upload.path));
  } catch {
    const reason = 'The uploaded file could not be read. Upload it again, then run Preflight.';
    checks.push(fail('Media type', reason));
    skipPlatforms(reason);
    return checks;
  }

  // Look inside the file to learn what it really is, never trusting the name alone.
  let kind = null;
  let info = null;
  let ffprobeMissing = false;
  info = readImageInfo(await readHead(upload.path, IMAGE_HEAD_BYTES));
  if (info) {
    kind = 'image';
  } else {
    try {
      const videoInfo = await readVideoInfo(upload.path);
      if (videoInfo === null) {
        ffprobeMissing = true;
        kind = looksLikeVideo(upload.filename) ? 'video' : null;
      } else {
        kind = 'video';
        info = videoInfo;
      }
    } catch {
      kind = null; // Not a readable video either.
    }
  }

  if (!kind) {
    checks.push(fail('Media type', 'The file could not be read as an image or a video. Upload a standard image (JPG, PNG, GIF, WebP) or video (MP4, MOV, WebM).'));
    skipPlatforms('Not checked because the file is not a readable image or video.');
    return checks;
  }

  if (ffprobeMissing) {
    checks.push(skipped('Media type', 'This looks like a video, but FFmpeg is not installed on this computer, so that could not be confirmed by looking inside the file.'));
  } else {
    checks.push(pass('Media type', `Confirmed by looking inside the file: it is a real ${kind} (${formatName(info.format)}).`));
  }

  const format = info ? info.format : formatFromFilename(upload.filename);
  const source = info ? 'checked inside the file' : 'from the file name, not confirmed';
  platforms.forEach((platform) => {
    const label = PLATFORM_RULES[platform].label;
    checks.push(format ? checkFormat(platform, kind, format, source) : skipped(`File format: ${label}`, 'The file format could not be read.'));
    checks.push(checkFileSize(platform, kind, bytes, true));
    if (info) {
      checks.push(checkAspectRatio(platform, kind, info));
    } else {
      checks.push(skipped(`Aspect ratio: ${label}`, 'This is a video and FFmpeg is not installed on this computer, so its size could not be read. Check the ratio yourself before sending.'));
    }
  });
  return checks;
}

async function runPreflight({ caption, mediaUrl, platforms, upload }) {
  const link = typeof mediaUrl === 'string' ? mediaUrl.trim() : '';
  const requested = Array.isArray(platforms) ? platforms : [];
  const unsupported = requested.filter((platform) => !Object.hasOwn(PLATFORM_RULES, platform));
  const chosen = [...new Set(requested.filter((platform) => Object.hasOwn(PLATFORM_RULES, platform)))];
  const checks = [];

  // Required fields, and only platforms this app knows the rules for.
  if (chosen.length === 0) checks.push(fail('Platform chosen', 'Tick at least one platform so we know which rules to check.'));
  if (unsupported.length > 0) {
    checks.push(fail('Platform supported', `This app has no rules for: ${unsupported.join(', ')}. Use Instagram, TikTok or LinkedIn.`));
  }
  const captionIsText = caption === undefined || typeof caption === 'string';
  if (!captionIsText) checks.push(fail('Caption is text', 'The caption must be plain text. Type it into the Caption box.'));

  // Either an uploaded file (checked on disk) or a pasted link (downloaded and checked).
  checks.push(...(upload ? await checkUpload(upload, chosen) : await checkMedia(link, chosen)));

  // Connected accounts. If Blotato refuses the key, this is where it shows up.
  let accounts = [];
  let accountsError = null;
  if (chosen.length > 0) {
    try {
      accounts = await blotato.listAccounts();
    } catch (error) {
      accountsError = error;
    }
    chosen.forEach((platform) => checks.push(checkAccount(platform, accounts, accountsError)));
  }

  if (captionIsText) chosen.forEach((platform) => checks.push(checkCaption(platform, caption || '')));

  // Only the accounts for the chosen platforms go back to the page, with just what it displays.
  const accountsByPlatform = {};
  chosen.forEach((platform) => {
    accountsByPlatform[platform] = accounts
      .filter((account) => account.platform === platform)
      .map(({ id, username, fullname }) => ({ id, username, fullname }));
  });

  // A skipped check doesn't block sending. Without this, nobody without FFmpeg could ever send a video.
  return { checks, allPassed: checks.every((check) => check.status !== 'fail'), accounts: accountsByPlatform };
}

module.exports = { runPreflight };
