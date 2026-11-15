// lib/cache.js — response caching: hash(diff + config + profile), TTL 7 days.
// Saves tokens on re-reviews of unchanged files/PRs (CodeRabbit charges per
// file; Axofy Code Review caches instead). JSON file store, atomic rename writes.
// Key insight: per-file Pass A results are cached by file-diff hash, so an
// incremental push only spends tokens on the files that actually changed.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { storeFile, atomicWriteJson } = require('./store');

const DEFAULT_FILE = storeFile('AXOREVIEW_CACHE_FILE', 'cache.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashKey(parts) {
  return crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\n---\n')).digest('hex');
}

function load(file = DEFAULT_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function save(store, file = DEFAULT_FILE) {
  // Best-effort: on a read-only filesystem (Vercel) the write is skipped,
  // never throws — a review must never 500 because the cache can't persist.
  atomicWriteJson(file, store);
}

function prune(store, now = Date.now()) {
  let changed = false;
  for (const k of Object.keys(store)) {
    if (!store[k] || now - (store[k].savedAt || 0) > TTL_MS) { delete store[k]; changed = true; }
  }
  return changed;
}

function get(key, file) {
  const store = load(file);
  const entry = store[key];
  if (!entry) return { hit: false };
  if (Date.now() - (entry.savedAt || 0) > TTL_MS) return { hit: false, expired: true };
  return { hit: true, value: entry.value, savedAt: entry.savedAt };
}

function set(key, value, file) {
  const store = load(file);
  if (prune(store)) { /* expired entries dropped */ }
  store[key] = { value, savedAt: Date.now() };
  save(store, file);
}

module.exports = { hashKey, get, set, load, save, prune, TTL_MS, DEFAULT_FILE };
