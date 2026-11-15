// lib/store.js — writable JSON stores that survive read-only filesystems.
// Local / desktop / self-host: data/ next to the app (writable).
// Vercel serverless: /var/task is read-only, so fall back to os.tmpdir()
// (per-invocation, best-effort — cache/learnings simply don't persist there).
// Every write here NEVER throws: a store write must never 500 a review.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Manual recursive mkdir (no libuv recursive flag): Node's recursive
// mkdirSync can spin forever on pseudo-filesystems like /proc, so create
// each level non-recursively and stop on the first error.
function ensureDir(dir) {
  const abs = path.resolve(dir);
  const parts = abs.split(path.sep).filter(Boolean);
  let cur = abs.startsWith(path.sep) ? path.sep : '';
  for (const part of parts) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) {
      try { fs.mkdirSync(cur); } catch { return false; }
    }
  }
  return true;
}

let cachedDir = null;

function writableDataDir() {
  if (cachedDir) return cachedDir;
  const local = path.join(__dirname, '..', 'data');
  if (ensureDir(local)) {
    try { fs.accessSync(local, fs.constants.W_OK); cachedDir = local; return cachedDir; } catch { /* fall through */ }
  }
  const tmp = path.join(os.tmpdir(), 'axoreview-data');
  ensureDir(tmp);
  cachedDir = tmp;
  return cachedDir;
}

// Store file path: explicit env override wins (tests), else <writable dir>/<name>.
function storeFile(envVar, name) {
  if (envVar && process.env[envVar]) return process.env[envVar];
  return path.join(writableDataDir(), name);
}

// Atomic JSON write (temp file + rename, never truncate the live file).
// Returns true on success, false on failure — never throws.
function atomicWriteJson(file, data) {
  try {
    if (!ensureDir(path.dirname(file))) return false;
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[store] write failed (best-effort, continuing):', file, e.message);
    return false;
  }
}

module.exports = { writableDataDir, storeFile, atomicWriteJson };
