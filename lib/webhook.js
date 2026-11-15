// lib/webhook.js — GitHub webhook verification + @axoreview commands.
// Verifies HMAC-SHA256 (X-Hub-Signature-256) with GITHUB_WEBHOOK_SECRET.
// Dedupes deliveries by X-GitHub-Delivery id (in-memory, capped).
// Commands (in issue comments, "@axoreview <cmd>"):
//   review | full review | summary | resolve | pause | resume | help
// Pause state is per-repo, stored in data/paused.json (atomic write).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { storeFile, atomicWriteJson } = require('./store');

const PAUSED_FILE = storeFile(null, 'paused.json');
const seenDeliveries = new Set();
const MAX_SEEN = 1000;

function verifySignature(secret, rawBody, signatureHeader) {
  if (!secret) return { ok: false, reason: 'no webhook secret configured (GITHUB_WEBHOOK_SECRET)' };
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return { ok: false, reason: 'missing X-Hub-Signature-256' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };
  return { ok: crypto.timingSafeEqual(a, b), reason: 'signature mismatch' };
}

function isDuplicate(deliveryId) {
  if (!deliveryId) return false;
  if (seenDeliveries.has(deliveryId)) return true;
  seenDeliveries.add(deliveryId);
  if (seenDeliveries.size > MAX_SEEN) {
    const first = seenDeliveries.values().next().value;
    seenDeliveries.delete(first);
  }
  return false;
}

function loadPaused(file = PAUSED_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function savePaused(data, file = PAUSED_FILE) {
  atomicWriteJson(file, data);
}

function isPaused(repoFullName, file) {
  return Boolean(loadPaused(file)[repoFullName]);
}

function setPaused(repoFullName, paused, file) {
  const data = loadPaused(file);
  if (paused) data[repoFullName] = { pausedAt: new Date().toISOString() };
  else delete data[repoFullName];
  savePaused(data, file);
  return paused;
}

// Parse "@axoreview <command>" from a comment body. Returns null if not addressed to us.
// Same command set as @coderabbitai: review, full review, pause, resume,
// summary, resolve, configuration, help, generate docstrings,
// generate sequence diagram, approve.
function parseCommand(body) {
  const m = String(body || '').match(/@axoreview\s+([a-z][a-z ]*)/i);
  if (!m) return null;
  const cmd = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  if (cmd.startsWith('full review')) return 'full-review';
  if (cmd.startsWith('generate sequence diagram')) return 'generate-sequence-diagram';
  if (cmd.startsWith('generate docstrings')) return 'generate-docstrings';
  if (cmd.startsWith('configuration')) return 'configuration';
  if (cmd.startsWith('review')) return 'review';
  if (cmd.startsWith('summary')) return 'summary';
  if (cmd.startsWith('resolve')) return 'resolve';
  if (cmd.startsWith('approve')) return 'approve';
  if (cmd.startsWith('pause')) return 'pause';
  if (cmd.startsWith('resume')) return 'resume';
  if (cmd.startsWith('help')) return 'help';
  return 'unknown:' + cmd;
}

const HELP_TEXT = [
  'Axofy Code Review commands (same as @coderabbitai):',
  '- `@axoreview review` — review the latest commits on this PR',
  '- `@axoreview full review` — review the whole PR diff from scratch',
  '- `@axoreview pause` / `@axoreview resume` — pause/resume auto-reviews for this repo',
  '- `@axoreview summary` — post a fresh summary + walkthrough',
  '- `@axoreview resolve` — mark open review threads resolved (GitHub App required)',
  '- `@axoreview configuration` — show the effective .axoreview.yaml for this repo',
  '- `@axoreview generate docstrings` — generate docstrings for the changed code',
  '- `@axoreview generate sequence diagram` — post a Mermaid sequence diagram of the change',
  '- `@axoreview approve` — approve the PR (GitHub App required)',
  '- `@axoreview help` — this list',
].join('\n');

module.exports = { verifySignature, isDuplicate, isPaused, setPaused, parseCommand, HELP_TEXT, loadPaused };
