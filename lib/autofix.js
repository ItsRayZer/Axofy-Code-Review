// lib/autofix.js — 1-click fix / Autofix.
// Produces a unified-diff patch (applies on top of the PR head) that fixes
// the findings it CAN fix safely, and lists the rest as manual.
// Safe auto-fixes (deterministic, single-line, behaviour-preserving or
// obviously correct):
//   - off-by-one `<= .length` loop bound  -> `<`
//   - console.log / debugger              -> remove the line
//   - LLM finding whose suggestedFix is a single code line -> replace line
// Everything else (secrets, SQL injection, eval, multi-line fixes) is
// manual-only: guessing a fix for those would be worse than no fix.
// The patch is built from the PR diff itself, so context lines match the
// head state and `git apply` works.
'use strict';

const { parseDiff } = require('./diff');

function autoReplacementFor(f) {
  const id = (f.source || '').replace('check:', '');
  if (id === 'off-by-one-length' && f.evidence) {
    return { replacement: f.evidence.replace('<=', '<'), kind: 'replace', reason: 'loop bound <= .length -> < .length' };
  }
  if (id === 'console-log' || id === 'debugger') {
    return { replacement: null, kind: 'remove', reason: 'remove debug statement' };
  }
  if (f.source === 'llm' && f.suggestedFix) {
    const fix = String(f.suggestedFix).trim();
    // Single code line only: no markdown, no prose, no newlines.
    if (fix && !fix.includes('\n') && !fix.includes('```') && fix.length < 200 && !/^(use|you should|consider|try|add|remove|ensure|make sure)\b/i.test(fix)) {
      return { replacement: fix, kind: 'replace', reason: 'LLM-suggested one-line fix' };
    }
  }
  return null;
}

function buildAutofixPatch(diffText, findings) {
  const files = parseDiff(diffText);
  const applied = [];
  const manual = [];
  // Map file -> Map(newLine -> {replacement, kind, finding})
  const byFile = new Map();
  // Deterministic check findings go first: their replacements are known-safe.
  // If an LLM finding targets the same file:line, the check fix wins and the
  // duplicate is skipped (the line is already being fixed).
  const ordered = [...(findings || [])].sort((a, b) => (a.source?.startsWith('check:') ? 0 : 1) - (b.source?.startsWith('check:') ? 0 : 1));
  for (const f of ordered) {
    const auto = autoReplacementFor(f);
    if (!auto) { manual.push({ file: f.file, line: f.line, title: f.title, reason: 'Needs a human decision — no safe automatic fix exists for this finding.' }); continue; }
    if (!byFile.has(f.file)) byFile.set(f.file, new Map());
    if (byFile.get(f.file).has(f.line)) continue; // same line already fixed by an earlier (check) finding
    byFile.get(f.file).set(f.line, { ...auto, finding: f });
  }

  const patchParts = [];
  for (const file of files) {
    const fixes = byFile.get(file.path);
    if (!fixes || fixes.size === 0) continue;
    patchParts.push(`--- a/${file.path}\n+++ b/${file.path}`);
    for (const h of file.hunks) {
      const outLines = []; // {prefix, content} in head-state order
      let changed = false;
      for (const l of h.lines) {
        if (l.type === 'del') { outLines.push({ prefix: ' ', content: l.content }); continue; } // del lines are not in head
        if (l.type === 'add') {
          const fix = fixes.get(l.newLine);
          if (fix) {
            changed = true;
            outLines.push({ prefix: '-', content: l.content });
            if (fix.kind === 'replace') outLines.push({ prefix: '+', content: fix.replacement });
            applied.push({ file: file.path, line: l.newLine, title: fix.finding.title, kind: fix.kind, reason: fix.reason });
          } else {
            outLines.push({ prefix: ' ', content: l.content });
          }
          continue;
        }
        if (l.type === 'ctx') outLines.push({ prefix: ' ', content: l.content });
      }
      if (!changed) continue;
      const oldCount = outLines.filter((x) => x.prefix === ' ' || x.prefix === '-').length;
      const newCount = outLines.filter((x) => x.prefix === ' ' || x.prefix === '+').length;
      patchParts.push(`@@ -${h.newStart},${oldCount} +${h.newStart},${newCount} @@`);
      for (const o of outLines) patchParts.push(o.prefix + o.content);
    }
  }
  return { patch: patchParts.join('\n') + (patchParts.length ? '\n' : ''), applied, manual };
}

module.exports = { buildAutofixPatch, autoReplacementFor, buildBulkAutofix };

// Bulk autofix (CodeAnt-style): apply ALL safe fixes in one patch, capped
// at 200 files. Files beyond the cap are listed as manual with the cap
// reason — never silently skipped.
function buildBulkAutofix(diffText, findings, { maxFiles = 200 } = {}) {
  const files = [...new Set((findings || []).map((f) => f.file).filter(Boolean))].sort();
  const totalFiles = files.length;
  const capped = totalFiles > maxFiles;
  const allowed = new Set(files.slice(0, maxFiles));
  const inScope = (findings || []).filter((f) => allowed.has(f.file));
  const result = buildAutofixPatch(diffText, inScope);
  const manual = [...result.manual];
  for (const f of (findings || []).filter((x) => !allowed.has(x.file))) {
    manual.push({ file: f.file, line: f.line, title: f.title, reason: 'Bulk autofix capped at ' + maxFiles + ' files — this file was beyond the cap, fix it manually.' });
  }
  return { ...result, manual, totalFiles, filesFixed: allowed.size, capped, maxFiles, note: capped ? 'Bulk autofix capped at ' + maxFiles + ' files; ' + (totalFiles - maxFiles) + ' file(s) need manual fixes.' : 'All safe fixes applied in one patch.' };
}
