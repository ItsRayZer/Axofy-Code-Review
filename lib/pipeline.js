// lib/pipeline.js — the review pipeline: deterministic checks + 3 LLM passes.
//   Pass A: per-file review (JSON findings)
//   Pass B: cross-file summary / walkthrough / risk / labels
//   Pass C: judge — drop ungrounded, speculative, or below-profile findings
// Profile gating (applied after the judge, like CodeRabbit):
//   quiet     -> only critical + major inline, rest grouped in summary
//   chill     -> critical + major + minor inline (default)
//   assertive -> everything inline, including nitpicks
// Pre-merge checks from config are evaluated by the LLM (pass/fail + note)
// and reported in the result; they never block the JSON response itself.
'use strict';

const { parseDiff, addedLines, diffStats } = require('./diff');
const { loadConfig, fileAllowed, instructionsFor } = require('./config');
const { runChecks, runFileChecks } = require('./checks');
const { fileContext, linkedIssues, findCallers, truncate } = require('./context');
const { chat, extractJson, resolveProvider, providerDescriptor, llmMode: detectLlmMode } = require('./llm');
const { relevantLearnings, applyFeedbackSuppression } = require('./learnings');
const { buildRepro } = require('./repro');
const { matchCustomRules, customRulesPrompt } = require('./custom-rules');
const { evaluateGates } = require('./gates');
const { relevantEntries } = require('./kb');
const { get: cacheGet, set: cacheSet, hashKey } = require('./cache');
const { METHODS_PROMPT, DEEP_PROMPT, normaliseDepth, evidenceFor } = require('./review-methods');
const { analyseDeep } = require('./deep-analysis');
const { buildLineVerdicts, analyseSE } = require('./line-by-line');
const { detectSlop } = require('./slop');
const { buildCodeGraph, blastRadius } = require('./codegraph');
const { investigate } = require('./investigate');

const SEVERITY_RANK = { critical: 4, major: 3, minor: 2, nitpick: 1 };
const PROFILE_MIN = { quiet: 3, chill: 2, assertive: 1 };

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0)
  );
}

function applyProfile(findings, profile) {
  const min = PROFILE_MIN[profile] || 2;
  const inline = [], grouped = [];
  for (const f of findings) {
    if ((SEVERITY_RANK[f.severity] || 0) >= min) inline.push(f);
    else grouped.push(f);
  }
  return { inline, grouped };
}

const PASS_A_SYSTEM = `You are a senior code reviewer. Review ONLY the added/changed lines in the diff, using the file context and repo instructions provided. Do not comment on formatting covered by linters. Do not hallucinate APIs or behaviour you cannot see — cite the file and line you checked. Output ONLY a JSON object, no prose: {"findings": [{"file": "...", "line": 12, "severity": "critical|major|minor|nitpick", "category": "bug|security|performance|style|logic", "title": "...", "explanation": "...", "suggestedFix": "code or short fix description", "confidence": 0.9}]}

${METHODS_PROMPT}`;

const PASS_B_SYSTEM = `You are a senior reviewer summarising a pull request. Given the diff, the per-file findings, and cross-file caller information, write a plain-language summary, a per-file walkthrough, an effort estimate 1-5 (1 trivial, 5 large/risky), a risk rating (low|moderate|high), and suggested labels and reviewers. Also list any cross-file breakage the per-file review missed. Output ONLY a JSON object: {"title": "...", "summary": "...", "walkthrough": [{"file": "...", "what": "..."}], "effort": 3, "risk": "moderate", "labels": ["..."], "reviewers": ["..."], "missedIssues": [{"file": "...", "line": 1, "severity": "major", "category": "bug", "title": "...", "explanation": "...", "suggestedFix": "...", "confidence": 0.8}]}`;

const PASS_C_SYSTEM = `You are a strict review judge. For each finding, decide if it is grounded in the diff/context, correct, and worth interrupting the author. DROP a finding if it is speculative, already handled elsewhere in the diff, a duplicate, or a nitpick below the configured profile. KEEP it only with evidence. Output ONLY a JSON object: {"kept": [0, 2], "dropped": [{"index": 1, "reason": "..."}]} where the numbers are indexes into the findings array you were given.`;

async function passA(file, diffText, contextText, extraInstructions, learnings, kbEntries = [], maxChars = 24000, extraContext = '', byom) {
  const user = [
    `File: ${file.path}`,
    `Diff for this file:\n${truncate(diffText, maxChars)}`,
    contextText ? `Surrounding file context:\n${truncate(contextText, Math.floor(maxChars / 2))}` : '',
    extraInstructions.length ? `Repo instructions for this path:\n- ${extraInstructions.join('\n- ')}` : '',
    learnings.length ? `Team learnings (follow these, they override generic rules):\n- ${learnings.map((l) => l.rule).join('\n- ')}` : '',
    kbEntries.length ? `Knowledge base (tickets, guidelines, notes):\n- ${kbEntries.map((e) => `[${e.source}] ${e.title || ''}: ${e.text.slice(0, 800)}`).join('\n- ')}` : '',
    extraContext ? `Additional context (guidelines, linked issue, CI, investigation evidence):\n${truncate(extraContext, 6000)}` : '',
  ].filter(Boolean).join('\n\n');
  const { content, mode } = await chat(
    [{ role: 'system', content: PASS_A_SYSTEM }, { role: 'user', content: user }],
    { temperature: 0.1, maxTokens: 4096, byom }
  );
  if (mode === 'mock' || !content) return { findings: [], mode };
  const parsed = extractJson(content);
  const findings = (parsed?.findings || []).map((f) => ({
    source: 'llm',
    file: f.file || file.path,
    line: Number(f.line) || null,
    severity: ['critical', 'major', 'minor', 'nitpick'].includes(f.severity) ? f.severity : 'minor',
    category: f.category || 'logic',
    title: String(f.title || 'Review finding'),
    explanation: String(f.explanation || ''),
    suggestedFix: String(f.suggestedFix || ''),
    confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
  }));
  return { findings, mode };
}

async function passB(files, allFindings, callers, prBody, mode, depth, byom) {
  const user = [
    `Changed files: ${files.map((f) => f.path).join(', ')}`,
    `Findings so far:\n${JSON.stringify(allFindings.slice(0, 40))}`,
    `Cross-file callers:\n${JSON.stringify(callers)}`,
    prBody ? `PR description:\n${truncate(prBody, 4000)}` : '',
    depth === 'deep' ? DEEP_PROMPT : '',
  ].filter(Boolean).join('\n\n');
  const { content } = await chat(
    [{ role: 'system', content: PASS_B_SYSTEM }, { role: 'user', content: user }],
    { temperature: 0.1, maxTokens: 2048, byom }
  );
  if (mode === 'mock' || !content) return null;
  return extractJson(content);
}

async function passC(findings, diffText, profile, mode, byom) {
  if (mode === 'mock' || findings.length === 0) return { kept: findings, dropped: [] };
  const { content } = await chat(
    [{ role: 'system', content: PASS_C_SYSTEM },
     { role: 'user', content: `Profile: ${profile}\n\nFindings:\n${JSON.stringify(findings)}\n\nDiff (truncated):\n${truncate(diffText, 12000)}` }],
    { temperature: 0, maxTokens: 2048, byom }
  );
  const parsed = extractJson(content);
  if (!parsed || !Array.isArray(parsed.kept)) return { kept: findings, dropped: [] };
  const keptIdx = new Set(parsed.kept.filter((i) => Number.isInteger(i)));
  return {
    kept: findings.filter((_, i) => keptIdx.has(i)),
    dropped: (parsed.dropped || []).map((d) => ({ index: d.index, reason: d.reason || 'judge dropped' })),
  };
}

async function runPreMergeChecks(checks, diffText, mode, byom) {
  if (!checks || checks.length === 0 || mode === 'mock') return [];
  const results = [];
  for (const c of checks) {
    try {
      const { content } = await chat(
        [{ role: 'system', content: 'You evaluate one pre-merge check on a diff. Output ONLY JSON: {"pass": true|false, "note": "one sentence"}' },
         { role: 'user', content: `Check: ${c.name}\nRequirement: ${c.prompt}\n\nDiff (truncated):\n${truncate(diffText, 8000)}` }],
        { temperature: 0, maxTokens: 512, byom }
      );
      const parsed = extractJson(content);
      results.push({ name: c.name, severity: c.severity, pass: parsed?.pass !== false, note: parsed?.note || '' });
    } catch (e) {
      results.push({ name: c.name, severity: c.severity, pass: null, note: 'check could not run: ' + e.message.slice(0, 120) });
    }
  }
  return results;
}

// Mermaid SEQUENCE diagram of the change (CodeRabbit-style walkthrough).
// Participants are the changed files; notes carry the top findings.
function buildDiagram(files, findings, title) {
  const safe = (s) => String(s || '').replace(/["\n\r:;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  const lines = ['sequenceDiagram', `    participant Author as PR author`];
  files.slice(0, 8).forEach((f, i) => lines.push(`    participant F${i} as ${safe(f.path)}`));
  files.slice(0, 8).forEach((f, i) => {
    lines.push(`    Author->>F${i}: change ${f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').length} added lines`);
  });
  findings.slice(0, 6).forEach((x) => {
    const idx = Math.min(7, files.findIndex((f) => f.path === x.file));
    if (idx >= 0) lines.push(`    Note over F${idx}: ${x.severity} - ${safe(x.title)}`);
  });
  return lines.join('\n');
}

// Planner: turn the diff into a per-PR task graph (CodeRabbit-style).
// LLM mode: the model plans the investigation. Mock mode: deterministic
// tasks derived from the changed files (honest fallback, labelled as such).
async function planReview(files, diffText, skipLlm = false, byom) {
  const heuristic = () => ({
    source: 'heuristic',
    tasks: files.slice(0, 10).map((f) => ({
      task: `Review ${f.path}: check correctness, security and cross-file impact of the changed functions`,
      symbols: [],
    })).concat([
      { task: 'Trace every changed function to its callers (blast radius)', symbols: [] },
      { task: 'Check new endpoints/queries for auth and injection', symbols: [] },
    ]),
  });
  if (skipLlm || detectLlmMode(byom) === 'mock') return heuristic();
  try {
    const { content } = await chat(
      [{ role: 'system', content: 'You plan a code review. Given the changed files, output ONLY JSON: {"tasks": [{"task": "one concrete check, e.g. verify endpoint auth", "symbols": ["functionName"]}]}. 3-8 tasks. Include: cross-file tracing of changed functions, auth/injection checks for new inputs, backward-compat of changed exports.' },
       { role: 'user', content: 'Changed files: ' + files.map((f) => f.path).join(', ') + '\n\nDiff (truncated):\n' + truncate(diffText, 8000) }],
      { temperature: 0.1, maxTokens: 1024, byom }
    );
    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return heuristic();
    return { source: 'llm', tasks: parsed.tasks.slice(0, 10) };
  } catch {
    return heuristic();
  }
}

// Cheap-model compression first: long file context is compressed to the
// touched functions before the expensive review pass (CodeRabbit-style).
// Mock mode: plain truncation (no LLM available to compress with).
async function compressContext(text, maxChars, byom) {
  if (!text || text.length <= maxChars) return text;
  if (detectLlmMode(byom) === 'mock') return truncate(text, maxChars);
  try {
    const { content } = await chat(
      [{ role: 'system', content: 'Compress this file excerpt to only the functions/regions relevant to the change, keeping exact code. Output only code, no prose.' },
       { role: 'user', content: text.slice(0, 20000) }],
      { temperature: 0, maxTokens: 2048, byom }
    );
    return content ? truncate(content, maxChars) : truncate(text, maxChars);
  } catch {
    return truncate(text, maxChars);
  }
}

// Main entry: review a unified diff string.
// opts: { repo, prBody, prTitle, fileContents: {path: text}, configYaml, profile, learningsFile }
async function reviewDiff(diffText, opts = {}) {
  const started = Date.now();
  const config = loadConfig(opts.configYaml || '');
  const profile = opts.profile && PROFILE_MIN[opts.profile] ? opts.profile : config.profile;
  const depth = normaliseDepth(opts.depth || config.depth);
  const skipLlm = Boolean(opts.skipLlm) || depth === 'quick'; // quick = deterministic only, fastest
  const allFiles = parseDiff(diffText);
  const files = allFiles.filter((f) => fileAllowed(f.path, config.pathFilters));
  const stats = diffStats(files);
  const issues = linkedIssues(opts.prBody || '');

  // Whole-review cache: identical diff + config + profile returns in ms, $0.
  const useCache = config.cacheEnabled && opts.useCache !== false && !opts.fileContents && !opts.previousDiff;
  const byom = opts.byom || null;
  const provDesc = providerDescriptor(byom);
  const cacheKey = useCache ? hashKey(['review-v2', diffText, opts.configYaml || '', profile, depth, provDesc.name, provDesc.model, provDesc.baseUrl, process.env.AXOREVIEW_LLM || '', String(opts.seEnabled ?? '')]) : null;
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit.hit) {
      const cached = { ...hit.value, cacheHit: true, durationMs: Date.now() - started };
      // Reviews cached before line-by-line mode lack verdicts — rebuild them
      // from the cached findings instead of serving a summary-only result.
      if (!cached.lineByLine) {
        const seEnabled = opts.seEnabled !== undefined ? Boolean(opts.seEnabled) : config.seEnabled;
        const allF = [...(cached.findings || []), ...(cached.groupedFindings || [])];
        cached.lineByLine = buildLineVerdicts(files, allF, { seEnabled });
        cached.se = analyseSE(files, allF, cached.lineByLine);
        if (!seEnabled) cached.se.enabled = false;
        cached.mode = 'line-by-line';
      }
      return cached;
    }
  }

  // Deterministic checks first — always run, even in mock mode.
  let findings = [...runChecks(files, config), ...runFileChecks(files, config)];

  // Deterministic deep analysis (standard + deep; quick skips it).
  // Runs even in mock mode: taint, breaking changes, migrations, deps,
  // perf, a11y/i18n, blast radius — plus architecture impact, docs drift
  // and test gaps in deep mode.
  const deep = analyseDeep(files, { depth, fileContents: opts.fileContents || null });
  findings.push(...deep.findings);

  // Plain-English custom rules (CodeAnt-style): deterministic match first,
  // and the rules are also injected into the LLM prompt (see Pass A context).
  const customRuleResult = matchCustomRules(files, findings, config.customRules);
  findings.push(...customRuleResult.findings);

  // Context per file (only when full file text is available).
  const learnings = config.learningsEnabled
    ? relevantLearnings({ repo: opts.repo, files: files.map((f) => f.path), findings }, opts.learningsFile)
    : [];
  const kbEntries = relevantEntries({ repo: opts.repo, files: files.map((f) => f.path) }, opts.kbFile);

  // Planner task graph + fresh per-review code graph + agentic investigation.
  // Context points gathered for every review (CodeRabbit-style 10-15):
  // diff, guidelines, linked issue, CI logs, past PRs, learnings, KB,
  // code graph / blast radius, investigation evidence.
  const plan = await planReview(files, diffText, skipLlm, byom);
  let codeGraph = null;
  if (opts.fileContents && Object.keys(opts.fileContents).length) {
    try {
      const graph = buildCodeGraph(opts.fileContents);
      codeGraph = { edges: graph.edges.slice(0, 50), blastRadius: blastRadius(graph, files.map((f) => f.path)) };
    } catch { codeGraph = null; }
  }
  let investigation = null;
  if (opts.repoDir) {
    try { investigation = await investigate(opts.repoDir, plan.tasks); } catch { investigation = null; }
  }
  const sharedContext = [
    opts.guidelines ? `Repo guidelines (AGENTS.md / CLAUDE.md):\n${truncate(opts.guidelines, 4000)}` : '',
    opts.linkedIssueText ? `Linked issue(s):\n${truncate(opts.linkedIssueText, 3000)}` : '',
    opts.ciSummary ? `CI status:\n${truncate(opts.ciSummary, 2000)}` : '',
    opts.pastPrs && opts.pastPrs.length ? `Past PRs touching the same files:\n${opts.pastPrs.map((p) => `#${p.number} ${p.title}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  let llmMode = 'mock';
  const callers = [];
  for (const f of files) callers.push(...findCallers(files, f));

  // Pass A runs in parallel (max 4 files at once) and each file's result is
  // cached by file-diff hash — an incremental push only pays for changed files.
  const CONCURRENCY = 4;
  const queue = [...files];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      const fileDiff = f.hunks.map((h) => h.header + '\n' + h.lines.map((l) => l.raw).join('\n')).join('\n');
      const rawContext = opts.fileContents?.[f.path] ? fileContext(opts.fileContents[f.path], f.hunks) : '';
      const contextText = rawContext && !opts.skipLlm ? await compressContext(rawContext, config.maxContextChars, byom) : truncate(rawContext, config.maxContextChars);
      const fileEvidence = investigation ? investigation.results.flatMap((r) => r.evidence).filter((e) => e.file === f.path).slice(0, 5).map((e) => `${e.file}:${e.line}: ${e.text}`).join('\n') : '';
      const graphNote = codeGraph?.blastRadius?.[f.path]?.callers?.length
        ? `Blast radius — callers of this file: ${codeGraph.blastRadius[f.path].callers.map((c) => `${c.file} (via ${c.via})`).join(', ')}` : '';
      const extraContext = [sharedContext, graphNote, customRulesPrompt(config.customRules), fileEvidence ? `Investigation evidence (repo grep):\n${fileEvidence}` : ''].filter(Boolean).join('\n\n');
      const fileCacheKey = config.cacheEnabled ? hashKey(['passA-v1', f.path, fileDiff, profile, provDesc.name, provDesc.model, process.env.AXOREVIEW_LLM || '', learnings.map((l) => l.rule).join('|')]) : null;
      try {
        let llmFindings;
        if (skipLlm) llmFindings = []; // triage / scoring / quick: deterministic only, $0
        else if (fileCacheKey) {
          const hit = cacheGet(fileCacheKey);
          if (hit.hit) llmFindings = hit.value;
        }
        if (!llmFindings) {
          const res = await passA(f, fileDiff, contextText, instructionsFor(f.path, config.pathInstructions), learnings, kbEntries, config.maxContextChars, extraContext, byom);
          llmFindings = res.findings;
          if (res.mode !== 'mock') llmMode = res.mode;
          if (fileCacheKey && res.mode !== 'mock') cacheSet(fileCacheKey, llmFindings);
        }
        const added = addedLines([f]);
        for (const lf of llmFindings) {
          const match = added.find((a) => a.line === lf.line);
          if (match) lf.position = match.position;
          else {
            const near = added.find((a) => a.line >= (lf.line || 0));
            if (near) { lf.position = near.position; lf.line = near.line; }
          }
          if (!lf.evidence) lf.evidence = evidenceFor(lf, files);
        }
        findings.push(...llmFindings.filter((lf) => lf.position));
      } catch (e) {
        findings.push({
          source: 'system', file: f.path, line: f.hunks[0]?.newStart || 1, position: f.hunks[0]?.headerPosition || 1,
          severity: 'minor', category: 'logic', title: 'LLM review failed for this file: ' + e.message.slice(0, 120),
          explanation: 'The deterministic checks above still ran. Retry the review or check the LLM configuration.',
          suggestedFix: '', confidence: 1,
        });
      }
    }
  });
  await Promise.all(workers);

  findings = dedupe(findings);

  // Pass B: summary / walkthrough / risk.
  let summary = null;
  try {
    const passBContext = [
      opts.prBody || '',
      codeGraph ? 'Code graph edges: ' + JSON.stringify(codeGraph.edges.slice(0, 20)) : '',
      opts.pastPrs && opts.pastPrs.length ? 'Past PRs: ' + opts.pastPrs.map((p) => '#' + p.number + ' ' + p.title).join('; ') : '',
    ].filter(Boolean).join('\n\n');
    summary = await passB(files, findings, callers, passBContext, llmMode, depth, byom);
  } catch { summary = null; }
  if (!summary) {
    const crit = findings.filter((f) => f.severity === 'critical').length;
    const maj = findings.filter((f) => f.severity === 'major').length;
    summary = {
      title: opts.prTitle || 'Code review',
      summary: `Reviewed ${stats.files} file(s) (+${stats.added}/-${stats.removed} lines). Found ${findings.length} finding(s): ${crit} critical, ${maj} major.${llmMode === 'mock' ? ' LLM review was in mock mode — findings come from deterministic checks only.' : ''}`,
      walkthrough: files.map((f) => ({ file: f.path, what: `${f.hunks.length} hunk(s), ${f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').length} added lines` })),
      effort: Math.min(5, Math.max(1, Math.ceil(stats.added / 100) + (crit ? 1 : 0))),
      risk: crit ? 'high' : maj ? 'moderate' : 'low',
      labels: crit ? ['needs-review', 'security'] : [],
      reviewers: [],
      missedIssues: [],
    };
    if (depth === 'deep' && deep.architectureImpact) {
      summary.architectureImpact = deep.architectureImpact.bullets.join(' ');
      summary.deepNotes = deep.architectureImpact.bullets;
    }
  }
  // Pass B missed cross-file issues become findings.
  for (const mi of summary.missedIssues || []) {
    const added = addedLines(files.filter((f) => f.path === mi.file));
    const match = added.find((a) => a.line === mi.line) || added[0];
    if (match) findings.push({ source: 'llm:cross-file', file: mi.file, line: match.line, position: match.position, severity: mi.severity || 'major', category: mi.category || 'logic', title: mi.title, explanation: mi.explanation, suggestedFix: mi.suggestedFix || '', confidence: mi.confidence || 0.7 });
  }
  findings = dedupe(findings);

  // Pass C: judge — LLM findings only. Deterministic check findings are
  // rules the team configured; the judge must not overrule them.
  const deterministic = findings.filter((f) => f.source && (f.source.startsWith('check:') || f.source === 'system'));
  const llmFindings = findings.filter((f) => !(f.source && (f.source.startsWith('check:') || f.source === 'system')));
  const judged = await passC(llmFindings, diffText, profile, llmMode, byom).catch(() => ({ kept: llmFindings, dropped: [] }));
  findings = sortFindings([...deterministic, ...judged.kept]);

  // Real-time learnings: findings the user already rejected are suppressed.
  const feedback = applyFeedbackSuppression(findings);
  findings = feedback.kept;

  // Steps of Reproduction on every finding (CodeAnt-style).
  for (const f of findings) if (!f.repro) f.repro = buildRepro(f);

  const { inline, grouped } = applyProfile(findings, profile);
  const preMerge = await runPreMergeChecks(config.preMergeChecks, diffText, llmMode, byom);

  // Every finding carries its evidence (the exact added line).
  for (const f of [...inline, ...grouped]) {
    if (!f.evidence) f.evidence = evidenceFor(f, files);
  }

  // Incremental review: findings whose evidence already appeared in the
  // previously reviewed diff are marked alreadyReviewed and grouped, not
  // re-posted inline. Pass `previousDiff` (the last reviewed diff) to use it.
  let incremental = null;
  let finalInline = inline;
  let finalGrouped = grouped;
  if (opts.previousDiff) {
    const prevSet = new Set();
    for (const pf of parseDiff(opts.previousDiff)) {
      for (const h of pf.hunks) for (const l of h.lines) {
        if (l.type === 'add') prevSet.add(pf.path + '::' + l.content.trim());
      }
    }
    let skipped = 0;
    finalInline = [];
    for (const f of inline) {
      const key = f.file + '::' + String(f.evidence || '').trim();
      if (prevSet.has(key)) { f.alreadyReviewed = true; finalGrouped.push(f); skipped += 1; }
      else finalInline.push(f);
    }
    incremental = { enabled: true, skippedAlreadyReviewed: skipped };
  }

  const result = {
    repo: opts.repo || null,
    prTitle: opts.prTitle || null,
    linkedIssues: issues,
    stats,
    profile,
    depth,
    mode: 'line-by-line', // agent-first default: every changed line has a verdict in lineByLine
    lineByLine: null, // filled below, after final inline/grouped are known
    se: null, // SE summary (score/grade/smells/complexity), filled below
    deepAnalysis: { depth: deep.depth, taintFlows: deep.taintFlows, findings: deep.findings, blastRadius: deep.blastRadius, architectureImpact: deep.architectureImpact },
    llmMode, // 'direct' | 'vault' | 'mock' — always disclosed
    provider: { ...provDesc, axofyCostUsd: 0, userCost: 'your own model/key — Axofy pays $0' },
    qualityGates: null, // filled below, after final inline/grouped are known
    customRules: { applied: config.customRules || [], matched: customRuleResult.findings.length, unmatched: customRuleResult.unmatched },
    suppressedByFeedback: feedback.suppressed,
    cacheHit: false,
    incremental,
    summary: { title: summary.title, text: summary.summary, architectureImpact: summary.architectureImpact || null, deepNotes: summary.deepNotes || [] },
    walkthrough: summary.walkthrough || [],
    diagram: buildDiagram(files, findings, summary.title),
    effort: summary.effort || 3,
    risk: summary.risk || 'moderate',
    labels: summary.labels || [],
    reviewers: summary.reviewers || [],
    slop: detectSlop({ diffText, files, prBody: opts.prBody || '', prTitle: opts.prTitle || '' }),
    findings: finalInline,
    groupedFindings: finalGrouped,
    droppedByJudge: judged.dropped || [],
    preMergeChecks: preMerge,
    learningsApplied: learnings.map((l) => l.rule),
    kbApplied: kbEntries.map((e) => `[${e.source}] ${e.title || e.text.slice(0, 80)}`),
    plan,
    codeGraph,
    durationMs: Date.now() - started,
  };
  result.qualityGates = evaluateGates([...result.findings, ...result.groupedFindings], config.qualityGates, { testGap: [...result.findings, ...result.groupedFindings].some((f) => f.source === 'deep:test-gap') });
  // Line-by-line Rabbit check mode (agent-first default) + SE mode: every
  // changed line gets a verdict, and the SE summary scores the change.
  // opts.seEnabled (CLI --se / --no-se, API se) overrides config reviews.se.
  const seEnabled = opts.seEnabled !== undefined ? Boolean(opts.seEnabled) : config.seEnabled;
  const allFindings = [...result.findings, ...result.groupedFindings];
  result.lineByLine = buildLineVerdicts(files, allFindings, { seEnabled });
  result.se = analyseSE(files, allFindings, result.lineByLine);
  if (!seEnabled) result.se.enabled = false;
  if (cacheKey) cacheSet(cacheKey, result);
  return result;
}

module.exports = { reviewDiff, dedupe, sortFindings, applyProfile, buildDiagram, SEVERITY_RANK };
