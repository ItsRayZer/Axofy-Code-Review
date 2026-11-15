// settings-store.js — Axofy Code Review desktop settings.
// Stored as JSON in the Electron userData dir (never in code, never in git).
// LLM keys are NEVER logged. File is written with mode 0600 where possible.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  llmProvider: 'nvidia', // nvidia | groq | openrouter | gemini
  githubRepo: 'ItsRayZer/axoreview',
  githubToken: '',
};

const KEY_FIELDS = ['NVIDIA_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];

function storePath(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

function loadSettings(userDataDir) {
  const settings = { ...DEFAULTS };
  for (const k of KEY_FIELDS) settings[k] = '';
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(userDataDir), 'utf8'));
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof raw[key] === 'string') settings[key] = raw[key];
    }
    for (const k of KEY_FIELDS) {
      if (typeof raw[k] === 'string') settings[k] = raw[k];
    }
    if (!['nvidia', 'groq', 'openrouter', 'gemini'].includes(settings.llmProvider)) {
      settings.llmProvider = 'nvidia';
    }
  } catch {
    // No settings file yet — defaults. Never throws.
  }
  return settings;
}

function saveSettings(userDataDir, patch) {
  const current = loadSettings(userDataDir);
  const next = { ...current };
  if (typeof patch.llmProvider === 'string') next.llmProvider = patch.llmProvider;
  if (typeof patch.githubRepo === 'string') next.githubRepo = patch.githubRepo.trim();
  if (typeof patch.githubToken === 'string') next.githubToken = patch.githubToken.trim();
  if (patch.keys && typeof patch.keys === 'object') {
    for (const k of KEY_FIELDS) {
      // Empty string = keep the existing value (the UI sends '' for "unchanged").
      if (typeof patch.keys[k] === 'string' && patch.keys[k].length > 0) {
        next[k] = patch.keys[k].trim();
      }
    }
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = storePath(userDataDir);
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows has no POSIX modes */ }
  return next;
}

function clearKeys(userDataDir) {
  const current = loadSettings(userDataDir);
  for (const k of KEY_FIELDS) current[k] = '';
  current.githubToken = '';
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(storePath(userDataDir), JSON.stringify(current, null, 2), { mode: 0o600 });
  return current;
}

// Public (safe) view for the UI: key presence only, never the values.
function publicSettings(settings) {
  const hasKeys = {};
  for (const k of KEY_FIELDS) hasKeys[k] = Boolean(settings[k]);
  return {
    llmProvider: settings.llmProvider,
    githubRepo: settings.githubRepo,
    hasGithubToken: Boolean(settings.githubToken),
    hasKeys,
  };
}

// Env vars to hand to the server child process. Keys come from settings
// first, then fall back to the process environment (e.g. .env / CI).
function serverEnv(settings) {
  const env = { LLM_PROVIDER: settings.llmProvider || 'nvidia' };
  for (const k of KEY_FIELDS) {
    if (settings[k]) env[k] = settings[k];
    else if (process.env[k]) env[k] = process.env[k];
  }
  if (settings.githubToken) env.GITHUB_TOKEN = settings.githubToken;
  else if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  return env;
}

module.exports = { DEFAULTS, KEY_FIELDS, loadSettings, saveSettings, clearKeys, publicSettings, serverEnv };
