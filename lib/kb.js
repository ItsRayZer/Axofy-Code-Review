// lib/kb.js — knowledge base store (JSON file; phase 2 is Postgres/pgvector).
// Sources: repo guideline files (AGENTS.md / CLAUDE.md), pasted Jira/Linear
// ticket text, and team notes. Entries are plain text; the pipeline injects
// matching entries (keyword overlap with changed files) into Pass A.
// Nothing here is an embedding — matching is keyword overlap, stated honestly.
'use strict';

const fs = require('fs');
const path = require('path');
const { storeFile, atomicWriteJson } = require('./store');

const DEFAULT_FILE = storeFile(null, 'kb.json');

function load(file = DEFAULT_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.entries) ? data : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function save(data, file = DEFAULT_FILE) {
  atomicWriteJson(file, data);
}

function addEntry({ repo, source, title, text }, file) {
  if (!text || !text.trim()) return null;
  const data = load(file);
  const entry = {
    id: 'kb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    repo: repo || 'global',
    source: source || 'note', // guideline | jira | linear | note | mcp
    title: (title || '').slice(0, 200),
    text: text.slice(0, 20000),
    createdAt: new Date().toISOString(),
  };
  data.entries.push(entry);
  save(data, file);
  return entry;
}

function relevantEntries({ repo, files = [] }, file) {
  const data = load(file);
  const haystack = files.join(' ').toLowerCase();
  const words = new Set(haystack.split(/[^a-z0-9_]+/).filter((w) => w.length > 3));
  return data.entries.filter((e) => {
    if (e.repo !== 'global' && repo && e.repo !== repo) return false;
    if (e.source === 'guideline') return true; // guidelines always apply
    const textWords = e.text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 3);
    return textWords.some((w) => words.has(w));
  });
}

function listEntries(repo, file) {
  const data = load(file);
  return repo ? data.entries.filter((e) => e.repo === repo || e.repo === 'global') : data.entries;
}

module.exports = { load, save, addEntry, relevantEntries, listEntries, DEFAULT_FILE };
