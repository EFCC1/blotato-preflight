// npm start's way of loading .env: PORT from the file, the key kept exactly, and the busy-port message.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { root } = require('./helpers/serverProcess');

function run(envFile) {
  const child = spawn(process.execPath, [`--env-file=${envFile}`, path.join(root, 'server.js')], { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const waitFor = (text) => new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (output.includes(text)) { clearInterval(timer); resolve(output); } }, 50);
    setTimeout(() => { clearInterval(timer); reject(new Error(`Did not see "${text}":\n${output}`)); }, 10000);
  });
  return { child, waitFor, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }) };
}

test('PORT is read from .env, the key keeps its "=", and a busy port explains how to change it', async () => {
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-env-')), '.env');
  fs.writeFileSync(envFile, 'BLOTATO_MOCK=true\nBLOTATO_API_KEY=abc123==\nPORT=3121\n');

  const first = run(envFile);
  try {
    await first.waitFor('is running at http://localhost:3121');
    const health = await (await fetch('http://127.0.0.1:3121/api/health')).json();
    assert.strictEqual(health.ok, true);

    const second = run(envFile);
    const output = await second.waitFor('set PORT=');
    assert.match(output, /Port 3121 is already in use/);
    assert.match(output, /open \.env, set PORT=3001/);
  } finally {
    await first.stop();
  }

  // The key is read exactly as written in the file.
  const keyCheck = spawn(process.execPath, [`--env-file=${envFile}`, '-e', 'process.stdout.write(process.env.BLOTATO_API_KEY)']);
  let key = '';
  keyCheck.stdout.on('data', (chunk) => { key += chunk; });
  await new Promise((resolve) => keyCheck.on('exit', resolve));
  assert.strictEqual(key, 'abc123==');
});
