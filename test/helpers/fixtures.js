// A small test website on this computer. It serves good and deliberately bad media
// so every preflight result can be tested. Needs FFmpeg to create the test files.
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const dir = path.join(os.tmpdir(), 'blotato-preflight-fixtures-v2');
const types = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function ff(...args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'ignore' });
}

function makeFiles() {
  fs.mkdirSync(dir, { recursive: true });
  const out = (name) => path.join(dir, name);
  if (fs.existsSync(out('done'))) return;
  const images = {
    'square.png': '1080x1080',
    'fourfive.jpg': '1080x1350',
    'wide.jpg': '1200x628',
    'tall.webp': '1080x1920',
    'tall.jpg': '1080x1920',
    'between.png': '1000x700',
    'narrow.png': '1000x1400',
    'tooWide.jpg': '2000x1000',
    'photo.jpg': '1080x1440',
    'anim.gif': '400x400',
  };
  for (const [name, size] of Object.entries(images)) ff('-f', 'lavfi', '-i', `color=c=teal:s=${size}`, '-frames:v', '1', out(name));
  const video = (size, name, ...extra) => ff('-f', 'lavfi', '-i', `testsrc2=s=${size}:d=1`, '-pix_fmt', 'yuv420p', ...extra, out(name));
  video('1080x1920', 'tall.mp4', '-movflags', '+faststart');
  video('640x480', 'fourthree.mp4', '-movflags', '+faststart');
  video('1920x1080', 'land.mp4', '-movflags', '+faststart');
  video('1080x1920', 'endmoov.mp4'); // Index at the end of the file, as many phones save it
  video('1080x1920', 'clip.mov');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=1', '-c:v', 'libvpx-vp9', '-b:v', '200k', out('clip.webm'));
  ff('-display_rotation', '90', '-i', out('land.mp4'), '-c', 'copy', '-movflags', '+faststart', out('rotated.mp4'));
  fs.writeFileSync(out('done'), 'ok');
}

// A JPEG stored 1080x1440 with a note saying "rotate me", so viewers see 1440x1080.
function exifRotated() {
  const jpeg = fs.readFileSync(path.join(dir, 'photo.jpg'));
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const length = payload.length + 2;
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, length >> 8, length & 255]), payload, jpeg.subarray(2)]);
}

function start(port = 0) {
  makeFiles();
  const server = http.createServer((req, res) => {
    const route = req.url;
    const send = (status, type, body) => {
      res.writeHead(status, type ? { 'content-type': type } : {});
      res.end(body);
    };
    if (route === '/403') return send(403, null, 'no');
    if (route === '/404') return send(404, null, 'no');
    if (route === '/hang') return undefined;
    if (route === '/html') return send(200, 'text/html; charset=utf-8', '<html>hi</html>');
    if (route === '/octet') return send(200, 'application/octet-stream', 'xx');
    if (route === '/notreally.png') return send(200, 'image/png', 'this is not an image');
    if (route === '/notreally.mp4') return send(200, 'video/mp4', 'this is not a video');
    if (route === '/playlist.mp4') return send(200, 'video/mp4', '#EXTM3U\n#EXTINF:1,\nfile:///c:/Windows/win.ini\n');
    if (route === '/redirect') {
      res.writeHead(302, { location: '/f/square.png' });
      return res.end();
    }
    if (route === '/loop') {
      res.writeHead(302, { location: '/loop' });
      return res.end();
    }
    if (route === '/exif.jpg') return send(200, 'image/jpeg', exifRotated());
    if (route === '/big.jpg') return send(200, 'image/jpeg', Buffer.concat([fs.readFileSync(path.join(dir, 'tall.jpg')), Buffer.alloc(9 * 1024 * 1024)]));
    if (route === '/huge') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(2 * 1024 ** 3) });
      return res.write('x');
    }
    if (route === '/cutoff.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '100000' });
      res.write(fs.readFileSync(path.join(dir, 'square.png')).subarray(0, 64));
      return setTimeout(() => res.destroy(), 100);
    }
    const file = path.join(dir, path.basename(route));
    if (route.startsWith('/f/') && fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': types[path.extname(file)] });
      return fs.createReadStream(file).pipe(res);
    }
    return send(404, null, 'no');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

module.exports = { start };
if (require.main === module) start(4100).then(({ port }) => console.log(`Test media website running on port ${port}`));
