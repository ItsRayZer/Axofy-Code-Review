// lib/context.js — gather review context around a diff.
// MVP scope (regex + grep-style search, no tree-sitter yet):
//   - file context: +/-30 lines around each changed hunk (from full file
//     text when the caller supplies it, e.g. fetched from GitHub)
//   - imports of changed files
//   - caller search: other changed files that reference a changed function
//     name (cheap cross-file signal)
//   - linked issues: "Fixes #n" / "Closes #n" in PR body
//   - repo guidelines: AGENTS.md / CLAUDE.md contents when supplied
// Long files are truncated by a token budget (chars ~= tokens * 4).
'use strict';

const MAX_CONTEXT_CHARS = 24000;

function truncate(text, max = MAX_CONTEXT_CHARS) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n…[truncated to fit context budget]…' : text;
}

function extractImports(fileText) {
  const imports = new Set();
  for (const line of String(fileText || '').split('\n')) {
    let m = line.match(/^\s*(?:import\s+.*?from\s+['"]([^'"]+)['"]|const\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)|from\s+([\w.]+)\s+import)/);
    if (m) imports.add(m[1] || m[2] || m[3]);
  }
  return [...imports];
}

function extractDefinedNames(addedText) {
  const names = new Set();
  for (const line of String(addedText || '').split('\n')) {
    let m = line.match(/(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|class\s+([A-Za-z_$][\w$]*)|def\s+([A-Za-z_$][\w$]*)\s*\()/);
    if (m) names.add(m[1] || m[2] || m[3] || m[4]);
  }
  return [...names];
}

// Context window: lines around each changed hunk from the full file text.
function fileContext(fileText, hunks, radius = 30) {
  if (!fileText) return '';
  const lines = String(fileText).split('\n');
  const ranges = [];
  for (const h of hunks || []) {
    const start = Math.max(0, (h.newStart || 1) - 1 - radius);
    const end = Math.min(lines.length, (h.newStart || 1) - 1 + (h.newLines || 0) + radius);
    ranges.push([start, end]);
  }
  if (ranges.length === 0) return truncate(lines.slice(0, 120).join('\n'));
  // Merge overlapping ranges.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return truncate(merged.map(([s, e]) => lines.slice(s, e).map((l, i) => String(s + i + 1).padStart(4) + ' | ' + l).join('\n')).join('\n…\n'));
}

function linkedIssues(prBody) {
  const out = [];
  const re = /\b(?:fix(?:es|ed)?|close(?:s|d)?|resolve(?:s|d)?)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(String(prBody || '')))) out.push(Number(m[1]));
  return [...new Set(out)];
}

// Find other changed files that call a function defined in this file.
function findCallers(files, targetFile) {
  const addedText = targetFile.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content)).join('\n');
  const names = extractDefinedNames(addedText).filter((n) => n && n.length > 2);
  const callers = [];
  for (const f of files) {
    if (f.path === targetFile.path) continue;
    const text = f.hunks.flatMap((h) => h.lines.map((l) => l.content)).join('\n');
    const used = names.filter((n) => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text));
    if (used.length) callers.push({ file: f.path, names: used });
  }
  return callers;
}

module.exports = { truncate, extractImports, extractDefinedNames, fileContext, linkedIssues, findCallers, MAX_CONTEXT_CHARS };
