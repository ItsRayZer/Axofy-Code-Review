// lib/sandbox.js — ephemeral sandbox worker (CodeRabbit-style, local scale).
// Clones the repo shallow + sparse (honouring path_filters) into a throwaway
// directory under data/work/, reads files from the clone, then deletes it.
// NEVER runs untrusted repo code: no install, no build, no test scripts —
// only read-only git + grep over the clone. Public repos clone without a
// token; private repos use GITHUB_TOKEN as an https credential (never logged).
// Timeout: clone must finish in 60s or it is killed. Cleanup always runs.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writableDataDir } = require('./store');

const WORK_ROOT = path.join(writableDataDir(), 'work');
const CLONE_TIMEOUT_MS = 60000;

function run(cmd, args, { timeout = CLONE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Sanitise: git errors can echo the clone URL, which may contain the token.
      const clean = (s) => String(s || '').replace(/x-access-token:[^@]+@/, 'x-access-token:***@');
      if (err) reject(new Error(cmd + ' failed: ' + clean(stderr || err.message).slice(0, 300)));
      else resolve(stdout);
    });
  });
}

function cloneUrl(owner, repo, token) {
  // Token goes in the URL only for this process (never logged, never stored).
  if (token) return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  return `https://github.com/${owner}/${repo}.git`;
}

// Clone at a ref into a fresh temp dir. pathFilters (globs) drive sparse
// checkout; without filters the whole tree is checked out (depth 1).
async function cloneRepo({ owner, repo, ref = 'HEAD', pathFilters = [] }, token) {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(WORK_ROOT, `${owner}-${repo}-`));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  try {
    const url = cloneUrl(owner, repo, token);
    await run('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--no-checkout', url, dir]);
    // Sparse-checkout patterns: convert globs to git sparse-checkout paths.
    // "**/*.js" -> all js files; "src/**" -> src/; plain dirs stay as-is.
    const patterns = [];
    for (const f of pathFilters) {
      if (f.startsWith('!')) continue; // exclusions handled by the reviewer, not the clone
      if (f.includes('*')) patterns.push(f.replace(/^\*\*\//, ''));
      else patterns.push(f);
    }
    if (patterns.length) {
      // --no-cone: cone mode only accepts directories, but path_filters
      // are file globs (e.g. **/*.js), so non-cone gitignore-style matching.
      await run('git', ['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...patterns]);
    } else {
      await run('git', ['-C', dir, 'sparse-checkout', 'disable']);
    }
    // A PR head SHA is not in a depth-1 clone of the default branch —
    // fetch that exact commit first, then check it out.
    if (/^[0-9a-f]{40}$/.test(ref)) {
      await run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', ref]);
    }
    await run('git', ['-C', dir, 'checkout', ref]);
    return { dir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function readFileFromClone(dir, relPath) {
  try {
    const full = path.join(dir, relPath);
    if (!full.startsWith(dir)) return null; // path traversal guard
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

function listCloneFiles(dir, maxFiles = 500) {
  const out = [];
  const walk = (d, rel) => {
    if (out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const p = path.join(d, entry.name);
      const r = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(p, r);
      else out.push(r);
      if (out.length >= maxFiles) return;
    }
  };
  try { walk(dir, ''); } catch { /* unreadable dir */ }
  return out;
}

module.exports = { cloneRepo, readFileFromClone, listCloneFiles, WORK_ROOT, CLONE_TIMEOUT_MS };
