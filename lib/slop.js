// lib/slop.js — slop detection (low-quality AI-generated PRs).
// Deterministic heuristics only, so the score is explainable. Each signal
// contributes points; score >= 60 means "likely slop", 30-59 "suspicious".
// Signals: huge diff with no tests, very low comment/code ratio, generic
// AI boilerplate comments, mass-produced repetitive hunks, no description.
'use strict';

function detectSlop({ diffText, files, prBody = '', prTitle = '' }) {
  const signals = [];
  let score = 0;
  const add = (points, signal) => { score += points; signals.push(signal); };

  const stats = { added: 0, removed: 0 };
  for (const f of files || []) for (const h of f.hunks) for (const l of h.lines) {
    if (l.type === 'add') stats.added += 1;
    if (l.type === 'del') stats.removed += 1;
  }
  const addedText = (files || []).flatMap((f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content))).join('\n');

  if (stats.added > 1000) add(25, `Very large diff: ${stats.added} added lines in one PR`);
  else if (stats.added > 500) add(15, `Large diff: ${stats.added} added lines in one PR`);
  const testFiles = (files || []).filter((f) => /test|spec/i.test(f.path)).length;
  if (stats.added > 100 && testFiles === 0) add(20, 'No test files changed in a large PR');
  if (!prBody || prBody.trim().length < 20) add(15, 'PR description is empty or near-empty');
  if (!prTitle || prTitle.trim().length < 10) add(5, 'PR title is very short');
  const commentLines = addedText.split('\n').filter((l) => l.trim().startsWith('//') || l.trim().startsWith('#') || l.trim().startsWith('*')).length;
  const codeLines = Math.max(1, stats.added - commentLines);
  if (commentLines / codeLines > 0.5 && stats.added > 50) add(10, 'Unusually high comment-to-code ratio (often AI boilerplate)');
  const boilerplate = (addedText.match(/This (function|method|class) (does|handles|is responsible for)/gi) || []).length;
  if (boilerplate >= 3) add(10, `${boilerplate} generic AI-style doc comments ("This function does...")`);
  // Repetitive hunks: same added block repeated 3+ times.
  const blocks = {};
  for (const f of files || []) for (const h of f.hunks) {
    const block = h.lines.filter((l) => l.type === 'add').map((l) => l.content.trim()).filter(Boolean).join('|');
    if (block.length > 40) blocks[block] = (blocks[block] || 0) + 1;
  }
  const repeated = Object.values(blocks).filter((n) => n >= 3).length;
  if (repeated) add(10, `${repeated} near-identical code block(s) repeated 3+ times`);
  const todoCount = (addedText.match(/\bTODO\b/g) || []).length;
  if (todoCount >= 3) add(5, `${todoCount} TODOs left in new code`);

  const verdict = score >= 60 ? 'likely-slop' : score >= 30 ? 'suspicious' : 'ok';
  return { score: Math.min(100, score), verdict, signals, stats: { added: stats.added, removed: stats.removed, testFiles } };
}

module.exports = { detectSlop };
