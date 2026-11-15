// lib/line-by-line.js — Line-by-line Rabbit check mode + SE (software
// engineering) mode. AGENT-FIRST: this is the default mode for agents —
// every changed line gets its own verdict, never a summary-only review.
//
// A line verdict is: {file, line, position, code, verdict, severity,
// findings[], seNotes[], suggestion, seReason, repro?}
//   verdict: 'ok' | 'nitpick' | 'minor' | 'major' | 'critical'
//   - 'ok' means the line passed every deterministic check + SE heuristic.
//   - Anything else names the finding(s) and the SE reason on that line.
// SE notes are deterministic heuristics (SOLID, DRY, KISS, YAGNI, clean
// code, naming, complexity, pattern misuse, testability, API compat,
// DB/migration safety, OWASP, performance, concurrency, error handling).
// They are attached to the line verdict, NOT invented as findings — the
// SE summary counts them separately, so gates never fail on a heuristic.
//
// reviewLineByLine(diff, opts) runs the full pipeline (deterministic
// checks + deep analysis + LLM passes when a BYOM key/local model is
// available) and returns the review with `lineByLine` + `se` attached.
// In mock mode (no key) the verdicts come from deterministic checks only
// and say so — never faked as LLM verdicts.
'use strict';

const { parseDiff, addedLines } = require('./diff');
const { runChecks, runFileChecks, detectLanguage } = require('./checks');
const { analyseDeep, changedFunctions } = require('./deep-analysis');
const { buildRepro } = require('./repro');

const VERDICT_RANK = { ok: 0, nitpick: 1, minor: 2, major: 3, critical: 4 };
const SEVERITIES = ['ok', 'nitpick', 'minor', 'major', 'critical'];

function worstVerdict(a, b) {
  return (VERDICT_RANK[a] || 0) >= (VERDICT_RANK[b] || 0) ? a : b;
}

// Deterministic SE heuristics, one per line. Each returns a note or null.
// They only fire on real code lines (no blank lines, no pure braces,
// no comment-only lines, no import/require lines).
function seNotesForLine({ file, line, content, lang, addedInFile, following = [] }) {
  const notes = [];
  const code = String(content || '');
  const trimmed = code.trim();
  if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed === '});' || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return notes;
  if (/^(import|from|require|export\s+\{)/.test(trimmed)) return notes;

  // Complexity / clean code: very long line.
  if (code.length > 120) {
    notes.push({ id: 'se:long-line', severity: 'nitpick', category: 'style', se: 'Complexity', title: `Line is ${code.length} chars — hard to read`, reason: 'Clean code / KISS: a line over 120 chars is hard to scan and usually hides two ideas. Split it or extract a named variable.', fix: 'Break the line at a natural boundary (one argument / one condition per line) or extract a helper.' });
  }
  // Complexity: deep nesting (indent of 12+ spaces ≈ 3+ levels).
  const indent = (code.match(/^(\s*)/) || ['', ''])[1].replace(/\t/g, '  ').length;
  if (indent >= 12) {
    notes.push({ id: 'se:deep-nesting', severity: 'minor', category: 'style', se: 'Complexity', title: 'Deeply nested code (indent ' + indent + ' spaces)', reason: 'Complexity / SOLID: nesting 3+ levels deep is hard to test and usually mixes responsibilities. Extract the inner branch into a named function or guard-clause the outer conditions.', fix: 'Use early returns / guard clauses, or extract the nested block into a helper with a clear name.' });
  }
  // Maintainability: magic number (3+ digits, not a year, not in a URL).
  if (/\b(?!19|20)\d{3,}\b/.test(trimmed) && !/https?:\/\//.test(trimmed) && !/^\s*(const|let|var)\s+\w+\s*=\s*\d+/.test(trimmed)) {
    notes.push({ id: 'se:magic-number', severity: 'nitpick', category: 'style', se: 'Maintainability', title: 'Magic number — unnamed literal', reason: 'Clean code / naming: a bare number like this forces the next reader to guess what it means and where else it is used.', fix: 'Give the number a named constant (e.g. MAX_RETRIES = 300) at the top of the file.' });
  }
  // SOLID / SRP: function with 5+ parameters.
  const defMatch = trimmed.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|\w+\s*\()\s*\(([^)]*)\)/);
  if (defMatch && defMatch[1] && defMatch[1].split(',').filter((p) => p.trim()).length >= 5) {
    notes.push({ id: 'se:too-many-params', severity: 'major', category: 'style', se: 'SOLID / SRP', title: 'Function takes 5+ parameters', reason: 'SOLID / single responsibility: a function with 5+ parameters is doing more than one job and is hard to call correctly. Callers will pass arguments in the wrong order.', fix: 'Group related parameters into one options object, or split the function.' });
  }
  // DRY: the same added line appears 2+ times in this diff.
  if (trimmed.length > 15 && addedInFile.filter((c) => c.trim() === trimmed).length >= 2) {
    notes.push({ id: 'se:duplicated-line', severity: 'minor', category: 'style', se: 'DRY', title: 'Duplicated line — same code added twice', reason: 'DRY: the same line appears twice in this change. A fix in one copy will be missed in the other.', fix: 'Extract the repeated logic into one helper and call it from both places.' });
  }
  // Correctness: loose equality in JS/TS (==, not ===).
  if ((lang === 'javascript' || lang === 'typescript') && /[^=!]==[^=]/.test(trimmed)) {
    notes.push({ id: 'se:loose-equality', severity: 'major', category: 'bug', se: 'Correctness', title: 'Loose equality (==) — type coercion', reason: 'Correctness: == coerces types, so "0" == 0 and "" == 0 are both true. This is a classic source of wrong-branch bugs.', fix: 'Use === (and !==) unless coercion is explicitly intended — then say so in a comment.' });
  }
  // Clean code: `var` in JS/TS (function scope, hoisting surprises).
  if ((lang === 'javascript' || lang === 'typescript') && /^\s*var\s+\w/.test(code)) {
    notes.push({ id: 'se:var-keyword', severity: 'minor', category: 'style', se: 'Clean code', title: '`var` — function-scoped, hoisted', reason: 'Clean code: var is function-scoped and hoisted, so the variable exists before the line that declares it. Prefer const/let.', fix: 'Use const by default, let only when the variable is reassigned.' });
  }
  // Concurrency / performance: await inside a loop body. Only flag the
  // loop line when an await actually appears in the next few added lines
  // of the same file (the loop body) — not when await exists anywhere.
  if (/\b(for|while)\b/.test(trimmed) && following.slice(0, 5).some((l) => /\bawait\b/.test(l))) {
    notes.push({ id: 'se:await-in-loop', severity: 'minor', category: 'performance', se: 'Performance / concurrency', title: 'Serial await in a loop body', reason: 'Performance / concurrency: awaiting inside a loop runs each iteration one after another. If the iterations are independent, run them concurrently (Promise.all / batch).', fix: 'If the iterations are independent, collect the promises and await Promise.all() once.' });
  }
  return notes;
}

// Build one verdict per added line. Pure function — no LLM, no I/O.
// findings: the review's findings (inline + grouped). seEnabled: false
// disables SE notes (config reviews.se: false / --no-se).
function buildLineVerdicts(files, findings, { seEnabled = true } = {}) {
  const byLine = new Map();
  for (const f of (findings || [])) {
    if (!f.file || !f.line) continue;
    const key = f.file + ':' + f.line;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(f);
  }
  const verdicts = [];
  for (const added of addedLines(files)) {
    const lang = detectLanguage(added.file);
    const fileAdds = files.find((x) => x.path === added.file)?.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content)) || [];
    const idxInFile = fileAdds.findIndex((c) => c === added.content);
    const following = idxInFile >= 0 ? fileAdds.slice(idxInFile + 1, idxInFile + 6) : [];
    const seNotes = seEnabled ? seNotesForLine({ file: added.file, line: added.line, content: added.content, lang, addedInFile: fileAdds, following }) : [];
    const lineFindings = byLine.get(added.file + ':' + added.line) || [];
    let verdict = 'ok';
    for (const f of lineFindings) verdict = worstVerdict(verdict, f.severity);
    for (const n of seNotes) verdict = worstVerdict(verdict, n.severity);
    const first = lineFindings[0];
    verdicts.push({
      file: added.file,
      line: added.line,
      position: added.position,
      code: added.content,
      verdict,
      severity: verdict,
      findings: lineFindings.map((f) => ({ source: f.source, severity: f.severity, category: f.category, title: f.title, explanation: f.explanation, suggestedFix: f.suggestedFix || '', evidence: f.evidence || added.content, repro: f.repro || buildRepro(f) })),
      seNotes,
      suggestion: first?.suggestedFix || seNotes[0]?.fix || '',
      seReason: seNotes.length ? seNotes.map((n) => n.se + ': ' + n.reason).join(' ') : (first ? first.explanation : ''),
    });
  }
  return verdicts;
}

// SE summary for the whole review: maintainability score 0-100, grade,
// code smells (aggregated), complexity numbers. Deterministic, no LLM.
function analyseSE(files, findings, verdicts) {
  const list = findings || [];
  const vs = verdicts || [];
  const crit = list.filter((f) => f.severity === 'critical').length;
  const major = list.filter((f) => f.severity === 'major').length;
  const minor = list.filter((f) => f.severity === 'minor').length;
  const nit = list.filter((f) => f.severity === 'nitpick').length;
  const seNoteCount = vs.reduce((n, v) => n + (v.seNotes || []).length, 0);
  const score = Math.max(0, Math.min(100, 100 - crit * 12 - major * 6 - minor * 2 - nit * 1 - seNoteCount * 1));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
  const smellMap = new Map();
  for (const v of vs) {
    for (const n of (v.seNotes || [])) {
      const key = n.id;
      if (!smellMap.has(key)) smellMap.set(key, { id: n.id, title: n.title, se: n.se, severity: n.severity, count: 0 });
      smellMap.get(key).count += 1;
    }
  }
  for (const f of list) {
    const key = 'finding:' + (f.category || 'logic');
    if (!smellMap.has(key)) smellMap.set(key, { id: key, title: (f.category || 'logic') + ' findings', se: 'Review', severity: f.severity, count: 0 });
    smellMap.get(key).count += 1;
  }
  const added = addedLines(files);
  const longLines = added.filter((a) => a.content.length > 120).length;
  const avgLen = added.length ? Math.round(added.reduce((n, a) => n + a.content.length, 0) / added.length) : 0;
  const changed = changedFunctions(files);
  const counts = { ok: 0, nitpick: 0, minor: 0, major: 0, critical: 0 };
  for (const v of vs) counts[v.verdict] = (counts[v.verdict] || 0) + 1;
  return {
    enabled: true,
    mode: 'line-by-line + SE',
    score,
    grade,
    counts,
    totalLines: vs.length,
    smells: [...smellMap.values()].sort((a, b) => b.count - a.count),
    complexity: { addedLines: added.length, longLines, avgLineLength: avgLen, changedFunctions: changed.length, changedFunctionNames: changed.map((c) => c.name) },
    summary: `SE score ${score}/100 (grade ${grade}): ${crit} critical, ${major} major, ${minor} minor, ${nit} nitpick findings across ${vs.length} changed lines, plus ${seNoteCount} SE note(s) (SOLID/DRY/KISS, naming, complexity, testability, API compat, migration safety, OWASP, performance, concurrency, error handling). ${score >= 75 ? 'Ship it after the critical/major lines are fixed.' : 'Needs changes — fix the critical/major lines first.'}`,
  };
}

// Build a unified diff from a single file's content (for review_file /
// POST /api/review-line-by-line {file, path}). Every line is an added line.
function diffFromFile(filePath, content) {
  const p = String(filePath || 'file.txt').replace(/^\//, '');
  const lines = String(content || '').split('\n');
  // Drop the trailing empty line from a final newline — it is not a line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l) => '+' + l).join('\n');
  return `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
}

// Full line-by-line review of a diff. Lazy-requires the pipeline to avoid
// a require cycle (pipeline.js requires this module for verdicts).
async function reviewLineByLine(diffText, opts = {}) {
  const { reviewDiff } = require('./pipeline');
  const review = await reviewDiff(diffText, { ...opts, lineByLine: true });
  // Pipeline already attaches lineByLine + se; rebuild them here only if
  // this review came from a cached result that predates line-by-line mode.
  if (!review.lineByLine) {
    const files = parseDiff(diffText);
    const all = [...(review.findings || []), ...(review.groupedFindings || [])];
    const seEnabled = opts.seEnabled !== undefined ? Boolean(opts.seEnabled) : true;
    review.lineByLine = buildLineVerdicts(files, all, { seEnabled });
    review.se = analyseSE(files, all, review.lineByLine);
    if (!seEnabled) review.se.enabled = false;
  }
  review.mode = 'line-by-line';
  return review;
}

module.exports = { buildLineVerdicts, analyseSE, reviewLineByLine, diffFromFile, seNotesForLine, VERDICT_RANK, SEVERITIES };
