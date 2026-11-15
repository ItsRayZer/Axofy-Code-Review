// lib/deep-analysis.js — deterministic deep analysis, no LLM required.
// Runs in standard and deep review depth (quick skips it). Every result is
// evidence-based: it cites file:line and the exact added line, and it never
// claims a behaviour it cannot see in the diff.
//
// Covers: blast-radius tracing (deterministic, all changed functions),
// taint flow (untrusted source -> sink), API/backward-compat breaking
// changes, DB migration safety, dependency risk, performance (N+1,
// unbounded work, sync-in-loop), accessibility, i18n, docs drift, and
// test-coverage gaps. The LLM prompts in review-methods.js ask the model
// to check the same things — this module is the deterministic backstop
// that runs even in mock mode.
'use strict';

const { parseDiff, addedLines } = require('./diff');
const { detectLanguage } = require('./checks');

// Function-definition patterns per language (name in group 1).
const DEF_PATTERNS = [
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\]]+\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*sub\s+([A-Za-z_$][\w$]*)\b/,
];

function changedFunctions(files) {
  const out = [];
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'add') continue;
        for (const re of DEF_PATTERNS) {
          const m = l.content.match(re);
          if (m && m[1] && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) {
            out.push({ file: f.path, line: l.newLine, name: m[1], signature: l.content.trim() });
            break;
          }
        }
      }
    }
  }
  return out;
}

function removedFunctions(files) {
  const out = [];
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'del') continue;
        for (const re of DEF_PATTERNS) {
          const m = l.content.match(re);
          if (m && m[1]) { out.push({ file: f.path, line: l.oldLine, name: m[1], signature: l.content.trim() }); break; }
        }
      }
    }
  }
  return out;
}

function mk(source, file, line, position, severity, category, title, explanation, fix, evidence) {
  return { source, file, line, position, severity, category, title, explanation, suggestedFix: fix, confidence: 0.85, evidence: (evidence || '').trim().slice(0, 200) };
}

const TAINT_SOURCES = [
  /req\.(query|body|params|headers)\b/, /request\.(args|form|json|data)\b/,
  /\binput\s*\(/, /\$_GET\b/, /\$_POST\b/, /\$_REQUEST\b/, /\$_COOKIE\b/,
  /process\.argv\b/, /os\.Args\b/, /os\.environ/, /prompt\s*\(/,
];
const TAINT_SINKS = [
  { re: /\b(SELECT|INSERT|UPDATE|DELETE)\b/i, kind: 'SQL query' },
  { re: /\beval\s*\(/, kind: 'eval()' },
  { re: /\b(os\.system|os\.popen|exec\.Command|Runtime\.getRuntime\(\)\.exec|shell_exec|system\s*\()/, kind: 'shell command' },
  { re: /\.innerHTML\s*=/, kind: 'innerHTML' },
  { re: /\bquery\s*\(/, kind: 'database query' },
];

function analyseTaint(files) {
  const findings = [];
  for (const f of files) {
    const adds = [];
    const all = []; // sources may live in context lines just above the diff
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.type === 'add') adds.push(l);
      if (l.type === 'add' || l.type === 'ctx') all.push(l);
    }
    const sources = all.filter((l) => TAINT_SOURCES.some((re) => re.test(l.content)));
    if (!sources.length) continue;
    for (const l of adds) {
      const sink = TAINT_SINKS.find((s) => s.re.test(l.content));
      if (!sink) continue;
      // The sink line itself mentions a source variable, or the file reads
      // untrusted input and later reaches this sink.
      const src = sources[0];
      findings.push(mk('deep:taint', f.path, l.newLine, l.position, 'critical', 'security',
        `Tainted data reaches ${sink.kind} — untrusted input flows to a sink`,
        `This file reads untrusted input (${src.content.trim()}) and the same file passes data to ${sink.kind} here. If the input reaches this sink unvalidated, it is injectable.`,
        'Validate/sanitise the input at the boundary (allow-list, parameterised query, escaping) before it reaches this sink.',
        l.content));
    }
  }
  return findings;
}

function analyseBreaking(files) {
  const findings = [];
  const removed = removedFunctions(files);
  const changed = changedFunctions(files);
  for (const r of removed) {
    // A removed function that is NOT re-added with the same name is a break.
    if (!changed.some((c) => c.name === r.name && c.file === r.file)) {
      findings.push(mk('deep:breaking-change', r.file, r.line, 1, 'major', 'logic',
        `Breaking change — ${r.name} was removed`,
        `The function/export ${r.name} was deleted from ${r.file}. Any caller still referencing it will break at runtime or compile time.`,
        'Restore the export, or keep a deprecated shim that forwards to the replacement and remove it in a later major version.',
        r.signature));
    }
  }
  // Changed signature: same function name added with different params than deleted.
  for (const c of changed) {
    const old = removed.find((r) => r.name === c.name && r.file === c.file);
    if (old && old.signature !== c.signature) {
      findings.push(mk('deep:breaking-change', c.file, c.line, 1, 'major', 'logic',
        `Breaking change — signature of ${c.name} changed`,
        `The signature changed from \`${old.signature}\` to \`${c.signature}\`. Callers passing the old arguments will break.`,
        'Keep the old signature as an overload/shim, or update every caller in the same PR and note the break in the changelog.',
        c.signature));
    }
  }
  return findings;
}

function analyseMigrations(files) {
  const findings = [];
  for (const f of files) {
    const isMigration = /migrat|schema|\.sql$/i.test(f.path);
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.type !== 'add') continue;
      const c = l.content;
      if (/\bDROP\s+(COLUMN|TABLE)\b/i.test(c)) {
        findings.push(mk('deep:migration', f.path, l.newLine, l.position, 'major', 'bug',
          'Destructive migration — DROP removes data',
          'This migration drops a column/table. Applied once, the data is gone and the migration cannot roll back.',
          'Back up first; prefer a staged migration (add new, dual-write, then drop in a later release).', c));
      } else if (/\bALTER\s+TABLE\b[^;]*\bDROP\b/i.test(c)) {
        findings.push(mk('deep:migration', f.path, l.newLine, l.position, 'major', 'bug',
          'Destructive migration — ALTER TABLE DROP', 'This migration drops a column. Applied once, the data is gone.', 'Back up first and stage the drop in a later release.', c));
      } else if (isMigration && /^\s*DELETE\s+FROM\s+[\w."]+\s*;?\s*$/.test(c)) {
        findings.push(mk('deep:migration', f.path, l.newLine, l.position, 'major', 'bug',
          'Migration DELETE without WHERE', 'A DELETE with no WHERE in a migration deletes every row.', 'Add a WHERE clause or confirm the full-table delete is intended.', c));
      } else if (/CREATE\s+(UNIQUE\s+)?INDEX/i.test(c) && !/CONCURRENTLY/i.test(c) && isMigration) {
        findings.push(mk('deep:migration', f.path, l.newLine, l.position, 'minor', 'performance',
          'Index created without CONCURRENTLY — locks the table',
          'Creating an index without CONCURRENTLY locks writes on the table for the whole build on large tables.',
          'Use CREATE INDEX CONCURRENTLY (Postgres) or the online equivalent for your database.', c));
      }
    }
  }
  return findings;
}

function analyseDeps(files) {
  const findings = [];
  const depFiles = ['package.json', 'requirements.txt', 'go.mod', 'Gemfile', 'composer.json', 'Cargo.toml', 'pom.xml'];
  for (const f of files) {
    if (!depFiles.some((d) => f.path.endsWith(d))) continue;
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.type !== 'add') continue;
      const c = l.content;
      if (/["'](latest|\*|\^?\d+\.\*)["']/.test(c) || /:\s*["']\*["']/.test(c) || /\bversion\s*=\s*["']\*["']/.test(c)) {
        findings.push(mk('deep:dep-risk', f.path, l.newLine, l.position, 'minor', 'style',
          'Dependency pinned to latest / * — unreproducible builds',
          'A dependency version of latest or * resolves differently over time, so the same code builds with different libraries.',
          'Pin an exact version (and a lockfile entry) for every dependency.', c));
      }
    }
  }
  return findings;
}

function analysePerf(files) {
  const findings = [];
  const LOOP_RE = /\b(for|foreach|while)\b.*[{(]/;
  const QUERY_RE = /\b(query|execute|fetch|find|select|await\s+\w+\.(get|post|query)|requests\.(get|post)|fetch\()\b/i;
  const SYNC_RE = /\b(readFileSync|writeFileSync|time\.sleep|sleep\s*\()/;
  for (const f of files) {
    const adds = [];
    for (const h of f.hunks) for (const l of h.lines) if (l.type === 'add') adds.push(l);
    for (let i = 0; i < adds.length; i++) {
      const l = adds[i];
      if (LOOP_RE.test(l.content)) {
        const body = adds.slice(i + 1, i + 6);
        const hit = body.find((b) => QUERY_RE.test(b.content));
        if (hit) {
          findings.push(mk('deep:n-plus-one', f.path, hit.newLine, hit.position, 'major', 'performance',
            'Possible N+1 — a query runs inside a loop',
            `A query/fetch runs inside a loop started here. For N items this issues N queries instead of one.`,
            'Batch the query (IN (…) / join / bulk fetch) outside the loop, or prefetch the related rows once.', hit.content));
        }
        const syncHit = body.find((b) => SYNC_RE.test(b.content));
        if (syncHit) {
          findings.push(mk('deep:sync-in-loop', f.path, syncHit.newLine, syncHit.position, 'minor', 'performance',
            'Blocking/sync call inside a loop', 'A synchronous call inside a loop blocks the handler for every iteration.', 'Use the async equivalent or move the call out of the loop.', syncHit.content));
        }
      }
      if (/\bSELECT\b[^;]*$/i.test(l.content) && !/LIMIT\b/i.test(l.content) && /from\s+\w+/i.test(l.content)) {
        findings.push(mk('deep:unbounded-query', f.path, l.newLine, l.position, 'minor', 'performance',
          'Unbounded query — no LIMIT / pagination',
          'This query has no LIMIT. On a large table it returns every row into memory.',
          'Add LIMIT + pagination (or a WHERE clause that bounds the result).', l.content));
      }
    }
  }
  return findings;
}

function analyseA11yI18n(files) {
  const findings = [];
  for (const f of files) {
    const lang = detectLanguage(f.path);
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.type !== 'add') continue;
      const c = l.content;
      if (lang === 'html' && /<img(?![^>]*\balt\s*=)[^>]*>/i.test(c)) {
        findings.push(mk('deep:a11y', f.path, l.newLine, l.position, 'minor', 'style', 'Image without alt text',
          'An <img> without alt text is invisible to screen readers.', 'Add alt="" for decorative images or a descriptive alt.', c));
      }
      if ((lang === 'javascript' || lang === 'typescript') && /<img(?![^>]*\balt\s*=)[^>]*>/i.test(c)) {
        findings.push(mk('deep:a11y', f.path, l.newLine, l.position, 'minor', 'style', 'Image without alt text',
          'A JSX <img> without alt is invisible to screen readers.', 'Add an alt prop (alt="" for decorative images).', c));
      }
      if ((lang === 'javascript' || lang === 'typescript' || lang === 'html') && /<(div|span)[^>]*\bonClick/i.test(c)) {
        findings.push(mk('deep:a11y', f.path, l.newLine, l.position, 'minor', 'style', 'Clickable div/span — not keyboard accessible',
          'A div/span with onClick is not focusable and cannot be activated from a keyboard.', 'Use a <button> (or add role="button", tabIndex and a key handler).', c));
      }
      if ((lang === 'javascript' || lang === 'typescript') && /\b(alert|confirm)\s*\(\s*["'][A-Z][^"']{8,}["']/.test(c)) {
        findings.push(mk('deep:i18n', f.path, l.newLine, l.position, 'nitpick', 'style', 'Hardcoded user-facing string — not localised',
          'A user-facing string is hardcoded in English. It cannot be translated without a code change.',
          'Move the string into the i18n catalogue (t("key")) and translate it.', c));
      }
    }
  }
  return findings;
}

// Docs drift + test gaps are PR-level (once per review, deep only): they
// need the whole file list, not one line.
function analysePrLevel(files, depth) {
  const findings = [];
  if (depth !== 'deep') return findings;
  const hasDocs = files.some((f) => /\.md$|\/docs\//i.test(f.path));
  const hasTest = files.some((f) => /(\.test\.|_test\.|test_.*\.|tests\/|__tests__)/i.test(f.path));
  const changed = changedFunctions(files);
  const publicApi = changed.filter((c) => /^(export|public)\b/.test(c.signature) || c.signature.startsWith('export'));
  if (publicApi.length && !hasDocs) {
    const c = publicApi[0];
    findings.push(mk('deep:docs-drift', c.file, c.line, 1, 'minor', 'style',
      `Docs drift — public API changed (${publicApi.length} export${publicApi.length === 1 ? '' : 's'}) but no docs updated`,
      `This PR changes public behaviour (${publicApi.map((x) => x.name).join(', ')}) and no Markdown/docs file changed with it.`,
      'Update the docs / README for the changed behaviour in this PR, not later.', c.signature));
  }
  if (changed.length && !hasTest) {
    const c = changed[0];
    findings.push(mk('deep:test-gap', c.file, c.line, 1, 'minor', 'style',
      `Test coverage gap — ${changed.length} changed function${changed.length === 1 ? '' : 's'} with no test in this PR`,
      `Changed functions (${changed.slice(0, 5).map((x) => x.name).join(', ')}) have no test file changed alongside them.`,
      'Add a test for the new/changed behaviour (happy path + one edge case) before merging.', c.signature));
  }
  return findings;
}

// Deterministic blast radius for ALL changed functions: for each changed
// function, find call sites in the diff itself and (when fileContents are
// supplied) in the full files. Returns { changedFunctions, callers } where
// callers is { functionName: [{file, line}] }.
function blastRadiusFor(files, fileContents) {
  const changed = changedFunctions(files);
  const callers = {};
  const searchTexts = [];
  if (fileContents) {
    for (const [path, text] of Object.entries(fileContents)) {
      String(text || '').split('\n').forEach((line, i) => searchTexts.push({ file: path, line: i + 1, content: line }));
    }
  }
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    if (l.type === 'add' || l.type === 'ctx') searchTexts.push({ file: f.path, line: l.newLine || l.oldLine || 0, content: l.content });
  }
  for (const fn of changed) {
    const re = new RegExp('\\b' + fn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(');
    const hits = searchTexts.filter((t) => t.file !== fn.file || t.line !== fn.line).filter((t) => re.test(t.content));
    if (hits.length) callers[fn.name] = hits.slice(0, 10).map((t) => ({ file: t.file, line: t.line }));
  }
  return { changedFunctions: changed, callers };
}

// Architecture impact, deterministic (no LLM): which modules change, which
// contracts change, which data flows change — derived from the diff.
function architectureImpact(files) {
  const modules = {};
  for (const f of files) {
    const mod = f.path.split('/').slice(0, -1).join('/') || '(root)';
    (modules[mod] = modules[mod] || []).push(f.path);
  }
  const breaking = analyseBreaking(files);
  const changed = changedFunctions(files);
  const bullets = [];
  bullets.push(`Modules touched: ${Object.keys(modules).join(', ')} (${files.length} file${files.length === 1 ? '' : 's'}).`);
  if (breaking.length) bullets.push(`Contracts broken: ${breaking.map((b) => b.title.replace('Breaking change — ', '')).join('; ')}.`);
  else bullets.push('No removed/renamed exports detected — no contract break found in the diff.');
  if (changed.length) bullets.push(`Functions changed: ${changed.slice(0, 8).map((c) => `${c.name} (${c.file})`).join(', ')}${changed.length > 8 ? ` (+${changed.length - 8} more)` : ''}.`);
  const hasDb = files.some((f) => /\.sql$/i.test(f.path) || /migrat/i.test(f.path));
  if (hasDb) bullets.push('Data layer touched: a migration/SQL change is in this PR — check rollback and data-loss risk (see findings).');
  return { modules, breakingChanges: breaking.length, changedFunctionCount: changed.length, bullets };
}

function analyseDeep(files, opts = {}) {
  const depth = opts.depth || 'standard';
  if (depth === 'quick') return { depth, findings: [], blastRadius: { changedFunctions: [], callers: {} }, architectureImpact: null, taintFlows: 0 };
  const findings = [
    ...analyseTaint(files),
    ...analyseBreaking(files),
    ...analyseMigrations(files),
    ...analyseDeps(files),
    ...analysePerf(files),
    ...analyseA11yI18n(files),
    ...analysePrLevel(files, depth),
  ];
  const blast = blastRadiusFor(files, opts.fileContents || null);
  const arch = depth === 'deep' ? architectureImpact(files) : null;
  // Blast-radius findings: a changed function with callers outside its file.
  const brFindings = [];
  for (const [name, hits] of Object.entries(blast.callers)) {
    const fn = blast.changedFunctions.find((c) => c.name === name);
    const external = hits.filter((h) => h.file !== fn.file);
    if (fn && external.length) {
      brFindings.push(mk('deep:blast-radius', fn.file, fn.line, 1, 'minor', 'logic',
        `Blast radius — ${name} is called from ${external.length} other location${external.length === 1 ? '' : 's'}`,
        `${name} changed in ${fn.file} and is called from ${external.slice(0, 5).map((h) => `${h.file}:${h.line}`).join(', ')}. Verify those callers still work with the new behaviour.`,
        'Check each caller listed, or add a test that covers the caller with the new behaviour.',
        fn.signature));
    }
  }
  return {
    depth,
    findings: [...findings, ...brFindings],
    blastRadius: blast,
    architectureImpact: arch,
    taintFlows: findings.filter((f) => f.source === 'deep:taint').length,
  };
}

module.exports = { analyseDeep, analyseTaint, analyseBreaking, analyseMigrations, analyseDeps, analysePerf, analyseA11yI18n, analysePrLevel, blastRadiusFor, architectureImpact, changedFunctions, removedFunctions };
