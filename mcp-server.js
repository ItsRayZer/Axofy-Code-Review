// mcp-server.js — Axofy Code Review MCP server (Model Context Protocol).
// ZERO dependencies, stdio, newline-delimited JSON-RPC 2.0.
// Any MCP client (Claude Desktop, Cursor, VS Code, Claude Code, Gemini CLI)
// can call AxoReview as a tool — no website, no login, no install beyond
// `node mcp-server.js`. BYOM: the caller passes its own model/key per call
// (byom: {provider, model, baseUrl, apiKey}); Axofy pays $0, the key is
// used for that call only and is never logged or stored. No key =
// deterministic checks + SE, honestly labelled mock mode.
// Usage:  node mcp-server.js          (reads JSON-RPC from stdin)
//   Env:  AXOREVIEW_LLM=mock (default in tests) | NVIDIA_API_KEY etc.
//   Config examples: agent-pack/mcp-*.json
// Protocol: initialize -> notifications/initialized -> tools/list ->
// tools/call. Logs go to stderr only — stdout is JSON-RPC only.
'use strict';

const { reviewDiff } = require('./lib/pipeline');
const { reviewLineByLine, diffFromFile, buildLineVerdicts, analyseSE } = require('./lib/line-by-line');
const { parseDiff, addedLines } = require('./lib/diff');
const { buildBulkAutofix } = require('./lib/autofix');
const { evaluateGates } = require('./lib/gates');
const { listProviders } = require('./lib/llm');
const { buildDiagram } = require('./lib/pipeline');
const { blastRadiusFor, architectureImpact } = require('./lib/deep-analysis');
const gh = require('./lib/github');

const VERSION = '0.3.0';

// Trim a full review to what an agent needs: summary, verdicts, findings,
// gates, SE — not the internal plan/code graph (those stay in the server).
function summarizeReview(review) {
  return {
    mode: review.mode || 'line-by-line',
    summary: review.summary,
    effort: review.effort,
    risk: review.risk,
    llmMode: review.llmMode,
    provider: review.provider,
    stats: review.stats,
    qualityGates: review.qualityGates,
    se: review.se,
    lineByLine: review.lineByLine,
    findings: review.findings,
    groupedFindings: review.groupedFindings,
    droppedByJudge: review.droppedByJudge,
    diagram: review.diagram,
    walkthrough: review.walkthrough,
    labels: review.labels,
    reviewers: review.reviewers,
  };
}

async function toolReviewDiff(a) {
  if (!a.diff || typeof a.diff !== 'string') throw new Error('diff is required (unified diff text)');
  const review = await reviewDiff(a.diff, { repo: a.repo || null, prBody: a.prBody || '', prTitle: a.prTitle || '', configYaml: a.configYaml || '', profile: a.profile, depth: a.depth, byom: a.byom || null, seEnabled: a.se !== undefined ? Boolean(a.se) : undefined });
  return summarizeReview(review);
}

async function toolLineByLine(a) {
  let diffText = a.diff;
  if (!diffText && (a.file || a.content)) diffText = diffFromFile(a.path || 'file.txt', a.file || a.content);
  if (!diffText || typeof diffText !== 'string') throw new Error('diff is required, or file + path for a single file');
  const review = await reviewLineByLine(diffText, { repo: a.repo || null, profile: a.profile, depth: a.depth, byom: a.byom || null, seEnabled: a.se !== undefined ? Boolean(a.se) : undefined, configYaml: a.configYaml || '' });
  return summarizeReview(review);
}

async function toolReviewFile(a) {
  if (!a.content && !a.file) throw new Error('content (file text) is required');
  return toolLineByLine({ ...a, file: a.content || a.file, path: a.path || 'file.txt' });
}

async function toolReviewPr(a) {
  if (!a.prUrl) throw new Error('prUrl is required, e.g. https://github.com/owner/repo/pull/123');
  const { owner, repo, number } = gh.parsePrUrl(a.prUrl);
  const token = process.env.GITHUB_TOKEN || null;
  const diffText = await gh.getPrDiff({ owner, repo, number }, token);
  const pr = await gh.getPr({ owner, repo, number }, token).catch(() => null);
  const review = await reviewDiff(diffText, { repo: `${owner}/${repo}`, prBody: pr?.body || '', prTitle: pr?.title || '', profile: a.profile, depth: a.depth, byom: a.byom || null, seEnabled: a.se !== undefined ? Boolean(a.se) : undefined });
  const out = summarizeReview(review);
  out.pr = { owner, repo, number, title: pr?.title || null, url: pr?.html_url || a.prUrl };
  return out;
}

async function toolExplain(a) {
  let diffText = a.diff;
  if (!diffText && a.prUrl) {
    const { owner, repo, number } = gh.parsePrUrl(a.prUrl);
    diffText = await gh.getPrDiff({ owner, repo, number }, process.env.GITHUB_TOKEN || null);
  }
  if (!diffText) throw new Error('diff or prUrl is required');
  const files = parseDiff(diffText);
  const deleted = [], added = [];
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    if (l.type === 'del' && l.content.trim()) deleted.push({ file: f.path, line: l.oldLine, content: l.content.trim() });
    if (l.type === 'add' && l.content.trim()) added.push({ file: f.path, line: l.newLine, content: l.content.trim() });
  }
  const addedSet = new Map(added.map((x) => [x.content, x]));
  const moved = deleted.filter((d) => addedSet.has(d.content)).map((d) => ({ from: `${d.file}:${d.line}`, to: `${addedSet.get(d.content).file}:${addedSet.get(d.content).line}`, code: d.content.slice(0, 120) }));
  const changeStack = {};
  for (const f of files) { const mod = f.path.split('/').slice(0, -1).join('/') || '(root)'; (changeStack[mod] = changeStack[mod] || []).push(f.path); }
  const blast = blastRadiusFor(files, null);
  return {
    diagram: buildDiagram(files, []),
    changeStack,
    semanticDiff: { movedLines: moved, movedCount: moved.length },
    blastRadius: blast,
    architectureImpact: architectureImpact(files),
    note: 'Change stack, semantic diff, blast radius and architecture impact are deterministic (no LLM needed).',
  };
}

async function toolAutofix(a) {
  if (!a.diff) throw new Error('diff is required');
  let findings = a.findings;
  if (!findings) {
    const review = await reviewDiff(a.diff, { repo: a.repo || null, profile: a.profile, byom: a.byom || null });
    findings = [...review.findings, ...review.groupedFindings];
  }
  const result = buildBulkAutofix(a.diff, findings, { maxFiles: Math.min(200, Number(a.maxFiles) || 200) });
  return { ...result, note: 'Apply with: git apply axoreview-fix.patch — review the patch before applying; manual items need a human.' };
}

async function toolGates(a) {
  if (!Array.isArray(a.findings)) throw new Error('findings is required (array)');
  const { loadConfig } = require('./lib/config');
  const cfg = loadConfig(a.configYaml || '');
  return evaluateGates(a.findings, cfg.qualityGates, { testGap: a.testGap === true || a.findings.some((f) => f.source === 'deep:test-gap') });
}

async function toolProviders() {
  return { axofyCostUsd: 0, note: 'Bring your own model: your key, your bill (free tiers / local = $0). Axofy never pays for a model and never stores your key.', providers: listProviders() };
}

const TOOLS = [
  { name: 'review_diff', description: 'Review a unified diff like CodeRabbit: summary, walkthrough, findings with file:line + fix, gates, SE score. Line-by-line verdicts included by default.', inputSchema: { type: 'object', properties: { diff: { type: 'string', description: 'Unified diff text' }, repo: { type: 'string' }, profile: { type: 'string', enum: ['quiet', 'chill', 'assertive'] }, depth: { type: 'string', enum: ['quick', 'standard', 'deep'] }, se: { type: 'boolean', description: 'SE mode on (default true)' }, byom: { type: 'object', description: 'Your own model: {provider, model, baseUrl, apiKey}. No key = deterministic mode.' } }, required: ['diff'] } },
  { name: 'line_by_line', description: 'Line-by-line Rabbit check mode: every changed line gets its own verdict (ok/nitpick/minor/major/critical) with SE reasons. Default mode for agents.', inputSchema: { type: 'object', properties: { diff: { type: 'string' }, file: { type: 'string', description: 'Single file content (alternative to diff)' }, path: { type: 'string' }, profile: { type: 'string' }, depth: { type: 'string' }, se: { type: 'boolean' }, byom: { type: 'object' } }, required: [] } },
  { name: 'review_file', description: 'Review one file (content + path) line by line, SE mode on.', inputSchema: { type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' }, profile: { type: 'string' }, depth: { type: 'string' }, se: { type: 'boolean' }, byom: { type: 'object' } }, required: ['content'] } },
  { name: 'review_pr', description: 'Review a public GitHub PR by URL (fetches the diff via the GitHub API; private repos need GITHUB_TOKEN env).', inputSchema: { type: 'object', properties: { prUrl: { type: 'string' }, profile: { type: 'string' }, depth: { type: 'string' }, se: { type: 'boolean' }, byom: { type: 'object' } }, required: ['prUrl'] } },
  { name: 'explain', description: 'Explain a change: Change Stack, semantic diff (moved lines), blast radius, architecture impact — deterministic, no LLM needed.', inputSchema: { type: 'object', properties: { diff: { type: 'string' }, prUrl: { type: 'string' } }, required: [] } },
  { name: 'autofix', description: 'Bulk autofix: one patch with all safe fixes (cap 200 files); the rest listed as manual with reasons.', inputSchema: { type: 'object', properties: { diff: { type: 'string' }, findings: { type: 'array' }, maxFiles: { type: 'number' } }, required: ['diff'] } },
  { name: 'gates', description: 'Quality gates: pass/fail on critical findings, secrets, major cap, test coverage.', inputSchema: { type: 'object', properties: { findings: { type: 'array' }, configYaml: { type: 'string' }, testGap: { type: 'boolean' } }, required: ['findings'] } },
  { name: 'providers', description: 'List BYOM providers: your own free/local models. Axofy pays $0 for every provider.', inputSchema: { type: 'object', properties: {} } },
];

const HANDLERS = { review_diff: toolReviewDiff, line_by_line: toolLineByLine, review_file: toolReviewFile, review_pr: toolReviewPr, explain: toolExplain, autofix: toolAutofix, gates: toolGates, providers: toolProviders };

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || !msg.method) return; // notifications without method are ignored
  const id = msg.id;
  const respond = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message: String(message).slice(0, 500) } }); };
  try {
    switch (msg.method) {
      case 'initialize':
        return respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'axoreview', version: VERSION } });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // no response to notifications
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        if (!HANDLERS[name]) return fail(-32602, 'unknown tool: ' + name);
        const out = await HANDLERS[name](args);
        return respond({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false });
      }
      default:
        return fail(-32601, 'method not found: ' + msg.method);
    }
  } catch (e) {
    // Never leak a BYOM apiKey in an error: messages here come from our code,
    // but strip anything that looks like a key just in case.
    const safe = String(e.message || e).replace(/(sk-[A-Za-z0-9-_]{8,}|Bearer\s+\S+)/g, '[key redacted]');
    return fail(-32603, safe);
  }
}

if (require.main === module) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg).catch((e) => process.stderr.write('[mcp] ' + e.message + '\n'));
    }
  });
  process.stderr.write('Axofy Code Review MCP server v' + VERSION + ' — stdio, BYOM ($0 to Axofy), no website needed.\n');
}

module.exports = { handle, TOOLS, HANDLERS, summarizeReview };
