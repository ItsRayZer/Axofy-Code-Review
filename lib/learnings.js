// lib/learnings.js — MVP learnings store (JSON file, phase 2 is Postgres/pgvector).
// A learning is a short rule extracted when a user dismisses or disputes a
// finding, e.g. "Never flag console.log in scripts/ — we use it for CLI output".
// Stored per repo, matched by simple keyword overlap at review time.
// Atomic write: write temp file, then rename (never truncate the live file).
'use strict';

const fs = require('fs');
const path = require('path');
const { storeFile, atomicWriteJson } = require('./store');

const DEFAULT_FILE = storeFile(null, 'learnings.json');
const FEEDBACK_FILE = storeFile('AXOREVIEW_FEEDBACK_FILE', 'feedback.json');

function load(file = DEFAULT_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.learnings) ? data : { learnings: [] };
  } catch {
    return { learnings: [] };
  }
}

function save(data, file = DEFAULT_FILE) {
  atomicWriteJson(file, data);
}

function addLearning({ repo, rule, scope = 'repo', source = 'feedback' }, file) {
  if (!rule || !rule.trim()) return null;
  const data = load(file);
  const entry = {
    id: 'lr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    repo: repo || 'global',
    rule: rule.trim(),
    scope,
    source,
    createdAt: new Date().toISOString(),
  };
  data.learnings.push(entry);
  save(data, file);
  return entry;
}

// Retrieve learnings relevant to a review: same repo (or global scope) and
// sharing at least one meaningful keyword with the changed files / findings.
function relevantLearnings({ repo, files = [], findings = [] }, file) {
  const data = load(file);
  const haystack = [...files, ...findings.map((f) => f.title + ' ' + f.explanation)].join(' ').toLowerCase();
  const words = new Set(haystack.split(/[^a-z0-9_]+/).filter((w) => w.length > 3));
  return data.learnings.filter((l) => {
    if (l.repo !== 'global' && repo && l.repo !== repo) return false;
    const ruleWords = l.rule.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 3);
    return ruleWords.some((w) => words.has(w)) || l.scope === 'global';
  });
}

function listLearnings(repo, file) {
  const data = load(file);
  return repo ? data.learnings.filter((l) => l.repo === repo || l.scope === 'global') : data.learnings;
}

// Real-time learnings from accepted/rejected suggestions (CodeAnt-style).
// POST /api/learnings/feedback {findingId|title, file, line, accepted, repo}
// accepted=true  = the finding was correct — reinforced, never suppressed.
// accepted=false = the finding was wrong / a false positive — similar
// findings are suppressed in future reviews (same source+title, or same
// title+file). Stored in data/feedback.json, atomic write like learnings.
function loadFeedback(file = FEEDBACK_FILE) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.feedback) ? d.feedback : []; }
  catch { return []; }
}

function recordFeedback({ findingId, title, file, line, source, accepted, repo }, storeFile = FEEDBACK_FILE) {
  if (typeof accepted !== 'boolean') return null;
  const entry = { id: 'fb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), findingId: findingId || null, title: String(title || '').slice(0, 200), file: file || '', line: line || null, source: source || '', accepted, repo: repo || 'global', createdAt: new Date().toISOString() };
  const list = loadFeedback(storeFile);
  list.push(entry);
  atomicWriteJson(storeFile, { feedback: list });
  return entry;
}

function isSuppressed(finding, storeFile = FEEDBACK_FILE) {
  const rejected = loadFeedback(storeFile).filter((e) => e.accepted === false);
  return rejected.some((e) => {
    if (e.source && finding.source && e.source === finding.source) return true;
    if (e.title && finding.title && e.title.toLowerCase() === String(finding.title).toLowerCase() && (!e.file || e.file === finding.file)) return true;
    return false;
  });
}

function applyFeedbackSuppression(findings, storeFile = FEEDBACK_FILE) {
  const kept = [];
  const suppressed = [];
  for (const f of findings || []) {
    if (isSuppressed(f, storeFile)) suppressed.push({ file: f.file, line: f.line, title: f.title, reason: 'suppressed by earlier rejected-suggestion feedback' });
    else kept.push(f);
  }
  return { kept, suppressed };
}

module.exports = { load, save, addLearning, relevantLearnings, listLearnings, DEFAULT_FILE, recordFeedback, loadFeedback, isSuppressed, applyFeedbackSuppression, FEEDBACK_FILE };
