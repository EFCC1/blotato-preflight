// Starts a copy of the app in its own process for a test, and stops it afterwards.
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function startServer({ port, env = {}, script = 'server.js' }) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, PORT: String(port), ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 15000);
    const check = () => {
      if (output.includes('is running at')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => reject(new Error(`Server exited with ${code}:\n${output}`)));
  });

  return ready.then(() => ({
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }),
  }));
}

async function api(base, route, body, extraHeaders = {}) {
  const response = await fetch(`${base}${route}`, body === undefined
    ? { headers: extraHeaders }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, headers: response.headers, data };
}

module.exports = { startServer, api, root };
