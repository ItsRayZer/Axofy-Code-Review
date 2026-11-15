// server-launcher.js — start/stop the AxoReview server for the desktop app.
// The server is plain Node (zero deps), so the Electron binary is relaunched
// as Node via ELECTRON_RUN_AS_NODE=1 — no separate node binary is needed in
// the packaged app. Testable with plain node (no Electron required).
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

function serverRoot() {
  // Packaged: extraResources puts the app at <resources>/axoreview.
  // Dev: desktop/ is a sibling of server.js.
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, 'axoreview');
    }
  } catch { /* not running under Electron (tests) */ }
  if (process.env.AXOREVIEW_ROOT) return process.env.AXOREVIEW_ROOT;
  return path.join(__dirname, '..');
}

function pickFreePort(preferred) {
  return new Promise((resolve) => {
    const tryPort = (port, fallback) => {
      const srv = net.createServer();
      srv.once('error', () => (fallback ? fallback() : resolve(0)));
      srv.once('listening', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.listen(port, '127.0.0.1');
    };
    if (preferred) {
      tryPort(preferred, () => tryPort(0));
    } else {
      tryPort(0);
    }
  });
}

function healthCheck(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve({ ok: res.statusCode === 200, data: JSON.parse(body) }); }
          catch { resolve({ ok: res.statusCode === 200, data: null }); }
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

async function waitForHealth(port, { tries = 40, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const h = await healthCheck(port);
    if (h.ok) return h.data;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// Start the server child. Returns { child, port, url } once /health answers.
// `electronPath` defaults to process.execPath (the Electron binary).
async function startServer({ extraEnv = {}, preferredPort = 3000, electronPath = process.execPath, cacheFile = null } = {}) {
  const root = serverRoot();
  const serverJs = path.join(root, 'server.js');
  if (!fs.existsSync(serverJs)) {
    throw new Error('server.js not found at ' + serverJs);
  }
  const port = await pickFreePort(preferredPort);
  const env = {
    ...process.env,
    ...extraEnv,
    PORT: String(port),
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (cacheFile) env.AXOREVIEW_CACHE_FILE = cacheFile;
  const child = spawn(electronPath, [serverJs], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const health = await waitForHealth(port);
  if (!health) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    throw new Error('AxoReview server did not answer /health on port ' + port + ' within ~20s');
  }
  return { child, port, url: `http://127.0.0.1:${port}/`, health };
}

function isRunning(child) {
  // NB: a process killed by a signal has exitCode === null but signalCode
  // set — it IS dead. Both must be null for the process to be alive.
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!isRunning(child)) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { return finish(); }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish();
    }, 3000).unref();
  });
}

module.exports = { serverRoot, pickFreePort, healthCheck, waitForHealth, startServer, stopServer, isRunning };
