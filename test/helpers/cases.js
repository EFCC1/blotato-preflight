// The preflight test list, used by the automated tests and the browser test.
// [name, media link, platforms, should it be allowed to send?, text the results must contain]
// "was:" marks cases where the official Blotato docs changed the expected result from the first version.

function linkCases(F) {
  const all = ['instagram', 'tiktok', 'linkedin'];
  const ig = ['instagram'];
  return [
    ['01 square PNG, all platforms', `${F}/f/square.png`, all, true, '1080x1080'],
    ['02 4:5 JPG, Instagram', `${F}/f/fourfive.jpg`, ig, true, '4:5 to 1.91:1'],
    ['03 1200x628 JPG, Instagram', `${F}/f/wide.jpg`, ig, true, '4:5 to 1.91:1'],
    ['04 WebP, Instagram (was: pass. Docs: JPEG, PNG only)', `${F}/f/tall.webp`, ig, false, 'which Instagram does not accept'],
    ['05 1000x700, Instagram (was: fail. Docs allow the range)', `${F}/f/between.png`, ig, true, '1.43:1'],
    ['06 redirect to a good file', `${F}/redirect`, ig, true, '1080x1080'],
    ['07 sideways phone photo, measured as seen', `${F}/exif.jpg`, ig, true, '1440x1080'],
    ['08 9:16 MP4, Instagram', `${F}/f/tall.mp4`, ig, true, '1080x1920'],
    ['09 4:3 MP4, Instagram (was: fail. Docs allow the range)', `${F}/f/fourthree.mp4`, ig, true, '640x480'],
    ['10 sideways phone video, measured as seen', `${F}/f/rotated.mp4`, ig, true, '1080x1920'],
    ['11 fake video', `${F}/notreally.mp4`, ig, false, 'could not be read'],
    ['12 fake image', `${F}/notreally.png`, ig, false, 'could not be read'],
    ['13 403 Forbidden', `${F}/403`, ig, false, '403 Forbidden'],
    ['14 404 Not Found', `${F}/404`, ig, false, '404 Not Found'],
    ['15 timeout', `${F}/hang`, ig, false, 'a timeout'],
    ['16 web page instead of a file', `${F}/html`, ig, false, 'text/html'],
    ['17 unknown file type', `${F}/octet`, ig, false, 'application/octet-stream'],
    ['18 website that does not exist', 'https://no-such-host-blotato-test.invalid/x.png', ig, false, 'could not be found'],
    ['19 not a link', 'hello', ig, false, 'not a valid web link'],
    ['20 empty link', '', ig, false, 'Paste a link'],
    ['21 no platform ticked', `${F}/f/square.png`, [], false, 'at least one platform'],
    ['22 real Google Drive link', 'https://drive.google.com/file/d/18-UgDEaKG7YR7AewIDd_Qi4QCLCX5Kop/view?usp=drivesdk', ig, false, 'This is a Google Drive share link'],
    ['23 real public image', 'https://picsum.photos/1080/1080', ig, true, '1080x1080'],
    ['24 real public video (was: fail. 1.82:1 is inside the range)', 'https://www.w3schools.com/html/mov_bbb.mp4', ig, true, '320x176'],
  ];
}

// [name, caption length, platform, should it be allowed to send?]
const captionCases = [
  ['25 Instagram 2200 characters', 2200, 'instagram', true],
  ['26 Instagram 2201 characters', 2201, 'instagram', false],
  ['27 LinkedIn 3000 characters', 3000, 'linkedin', true],
  ['28 LinkedIn 3001 characters', 3001, 'linkedin', false],
];

// New cases added by the audit, for rules that were not checked before.
function extraCases(F) {
  const ig = ['instagram'];
  return [
    ['Instagram: too narrow', `${F}/f/narrow.png`, ig, false, 'Crop it to'],
    ['Instagram: too wide', `${F}/f/tooWide.jpg`, ig, false, 'Crop it to'],
    ['Instagram: image over 8 MB', `${F}/big.jpg`, ig, false, 'Instagram allows'],
    ['Instagram: GIF rejected', `${F}/f/anim.gif`, ig, false, 'which Instagram does not accept'],
    ['Instagram: MOV accepted', `${F}/f/clip.mov`, ig, true, 'MOV'],
    ['Instagram: WebM video rejected', `${F}/f/clip.webm`, ig, false, 'which Instagram does not accept'],
    ['TikTok: WebP accepted', `${F}/f/tall.webp`, ['tiktok'], true, 'WEBP'],
    ['TikTok: PNG marked not guaranteed', `${F}/f/square.png`, ['tiktok'], true, 'may convert'],
    ['TikTok: WebM accepted', `${F}/f/clip.webm`, ['tiktok'], true, 'WEBM'],
    ['TikTok: aspect ratio marked skipped', `${F}/f/tall.mp4`, ['tiktok'], true, 'no TikTok aspect ratio rule'],
    ['LinkedIn: 4:3 video rejected', `${F}/f/fourthree.mp4`, ['linkedin'], false, 'Crop it to'],
    ['LinkedIn: image over 5 MB', `${F}/big.jpg`, ['linkedin'], false, 'LinkedIn allows'],
    ['LinkedIn: image ratio marked skipped', `${F}/f/between.png`, ['linkedin'], true, 'only recommend'],
    ['LinkedIn: WebP rejected', `${F}/f/tall.webp`, ['linkedin'], false, 'which LinkedIn does not accept'],
    ['MP4 with its index at the end is still read', `${F}/f/endmoov.mp4`, ig, true, '1080x1920'],
    ['A playlist pretending to be a video is refused', `${F}/playlist.mp4`, ig, false, 'could not be read'],
    ['Over 1 GB refused before downloading', `${F}/huge`, ig, false, 'limit'],
    ['Download cut off partway', `${F}/cutoff.png`, ig, false, 'stopped partway'],
    ['Endless redirects abandoned', `${F}/loop`, ig, false, 'redirected more than'],
    ['Unsupported platform refused', `${F}/f/square.png`, ['facebook'], false, 'no rules for'],
    ['Instagram: 6 hashtags refused', `${F}/f/square.png`, ig, false, 'hashtags', '#a #b #c #d #e #f'],
  ];
}

module.exports = { linkCases, captionCases, extraCases };
