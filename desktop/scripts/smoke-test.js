// scripts/smoke-test.js — Axofy Code Review desktop smoke test (plain node,
// no Electron window needed). Verifies the pieces the desktop app depends on:
// settings store, version compare, and the real server child process
// (start → /health → / → POST /api/review-diff with the planted-bug fixture).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { loadSettings, saveSettings, clearKeys, publicSettings, serverEnv } = require('../settings-store');
const { compareVersions } = require('../update-check');
const { pickFreePort, startServer, stopServer, isRunning } = require('../server-launcher');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log('  PASS ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('Axofy Code Review desktop smoke test');

  // Settings store round-trip in a temp dir (never the real userData).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axoreview-desktop-test-'));
  const saved = saveSettings(tmpDir, { llmProvider: 'groq', keys: { GROQ_API_KEY: 'gsk_test_value' } });
  check('settings save keeps provider', saved.llmProvider === 'groq');
  const loaded = loadSettings(tmpDir);
  check('settings load round-trips key', loaded.GROQ_API_KEY === 'gsk_test_value');
  const pub = publicSettings(loaded);
  check('public settings never expose key values', JSON.stringify(pub).indexOf('gsk_test_value') === -1 && pub.hasKeys.GROQ_API_KEY === true);
  const env = serverEnv(loaded);
  check('serverEnv hands key to server child', env.GROQ_API_KEY === 'gsk_test_value' && env.LLM_PROVIDER === 'groq');
  clearKeys(tmpDir);
  check('clearKeys removes keys', loadSettings(tmpDir).GROQ_API_KEY === '');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Version compare.
  check('compareVersions: v1.0.1 > 1.0.0', compareVersions('v1.0.1', '1.0.0') === 1);
  check('compareVersions: 1.0.0 == v1.0.0', compareVersions('1.0.0', 'v1.0.0') === 0);
  check('compareVersions: 1.0.0 < 1.1.0', compareVersions('1.0.0', '1.1.0') === -1);

  // Free port + real server child (mock LLM, no keys needed).
  const port = await pickFreePort(0);
  check('pickFreePort returns a usable port', Number.isInteger(port) && port > 0);
  const server = await startServer({
    extraEnv: { AXOREVIEW_LLM: 'mock' },
    preferredPort: 0,
    electronPath: process.execPath, // plain node here, not Electron
    cacheFile: path.join(os.tmpdir(), 'axoreview-desktop-smoke-cache.json'),
  });
  check('server child answers /health', server.health && server.health.ok === true, JSON.stringify(server.health));
  const home = await httpJson(server.port, 'GET', '/', null);
  check('server serves the landing UI', home.status === 200 && home.body.includes('Axofy Code Review'));
  const diff = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'sample-pr.diff'), 'utf8');
  const review = await httpJson(server.port, 'POST', '/api/review-diff', { diff });
  let parsed = null;
  try { parsed = JSON.parse(review.body); } catch { /* fail below */ }
  const all = parsed ? [...(parsed.findings || []), ...(parsed.groupedFindings || [])] : [];
  check('review-diff via server child finds planted SQL injection', all.some((f) => f.source === 'check:sql-injection'));
  check('review-diff via server child finds planted eval', all.some((f) => f.source === 'check:insecure-eval'));
  await stopServer(server.child);
  check('server child stops cleanly', !isRunning(server.child), 'signal=' + server.child.signalCode);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Smoke test crashed:', e); process.exit(1); });
