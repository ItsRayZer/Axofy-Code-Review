// server.js — Axofy Code Review server. Plain Node http, ZERO dependencies.
// (Chosen over Express deliberately: no install step, tiny surface, and the
// same file can be wrapped as a single Vercel serverless function in api/.)
// Run:  node server.js            (PORT env, default 3000)
// Env:  NVIDIA_API_KEY (or vault helper), GITHUB_TOKEN, GITHUB_APP_ID,
//       GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { reviewDiff } = require('./lib/pipeline');
const { reviewLineByLine, diffFromFile } = require('./lib/line-by-line');
const { parseDiff, addedLines, diffStats } = require('./lib/diff');
const gh = require('./lib/github');
const { verifySignature, isDuplicate, isPaused, setPaused, parseCommand, HELP_TEXT } = require('./lib/webhook');
const { addLearning, listLearnings, recordFeedback } = require('./lib/learnings');
const { deepScan } = require('./lib/secure');
const { addEntry: addKbEntry, listEntries: listKbEntries } = require('./lib/kb');
const { chat, llmMode, listProviders, testProvider, providerDescriptor } = require('./lib/llm');
const { detectSlop } = require('./lib/slop');
const { findCallers } = require('./lib/context');
const { buildAutofixPatch, buildBulkAutofix } = require('./lib/autofix');
const { ReviewQueue } = require('./lib/queue');
const { cloneRepo, readFileFromClone } = require('./lib/sandbox');
const { loadConfig } = require('./lib/config');
const { linkedIssues } = require('./lib/context');
const { hostStatus, normalizeEvent, notConfigured } = require('./lib/hosts');
const { evaluateGates } = require('./lib/gates');
const { buildDiagram } = require('./lib/pipeline');
const { JobStore } = require('./lib/jobs');
const { writableDataDir } = require('./lib/store');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
// Writable data dir: data/ locally, os.tmpdir() on read-only Vercel serverless.
const DATA_DIR = writableDataDir();
const MAX_BODY = 2 * 1024 * 1024; // 2 MB

// Review job queue (CodeRabbit-style): dedupe by repo/PR/head SHA, 30s
// debounce, cancel superseded jobs. Explicit @axoreview commands bypass
// the queue and run immediately.
const reviewQueue = new ReviewQueue({ debounceMs: 30000 });

// Async review jobs (POST /api/review-jobs -> 202, poll GET /api/review-jobs/:id).
// In-memory only: fully reliable on a long-running server (local / desktop /
// self-host). On Vercel serverless the function may freeze after the 202
// response, so jobs there are best-effort — see README "Vercel limits".
const reviewJobs = new JobStore();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large (max 2 MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function saveLastReview(review) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, 'last-review.json.tmp.' + process.pid);
    fs.writeFileSync(tmp, JSON.stringify({ ...review, savedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, path.join(DATA_DIR, 'last-review.json'));
  } catch { /* last-review is best-effort */ }
}

function loadLastReview() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'last-review.json'), 'utf8')); } catch { return null; }
}

// Context points for a PR review (CodeRabbit-style 10-15): config, linked
// issues, CI logs, past PRs touching the same files. Best effort — any
// failure just means less context, never a failed review.
async function gatherPrContext({ owner, repo, headSha, prBody, changedPaths }, token) {
  let configYaml = '';
  try {
    configYaml = await gh.getFileContent({ owner, repo, path: '.axoreview.yaml', ref: headSha }, token) || '';
  } catch { /* no config file in repo */ }

  let linkedIssueText = '';
  try {
    const nums = linkedIssues(prBody || '');
    const parts = [];
    for (const n of nums.slice(0, 3)) {
      const issue = await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/issues/${n}`, token);
      parts.push(`#${n} ${issue.title || ''}\n${(issue.body || '').slice(0, 1500)}`);
    }
    linkedIssueText = parts.join('\n---\n');
  } catch { /* linked issues are best-effort */ }

  let ciSummary = '';
  try {
    const runs = await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=20`, token);
    const list = (runs.check_runs || []).map((r) => `${r.name}: ${r.status}/${r.conclusion || 'pending'}`);
    const failing = (runs.check_runs || []).filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
    ciSummary = failing.length
      ? `CI failing: ${failing.map((r) => r.name).join(', ')}. All runs: ${list.join('; ')}`
      : `CI: ${list.length ? list.join('; ') : 'no check runs yet'}`;
  } catch { /* CI is best-effort */ }

  let pastPrs = [];
  try {
    const closed = await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&per_page=5`, token);
    for (const p of closed || []) {
      try {
        const pfiles = await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${p.number}/files?per_page=30`, token);
        if ((pfiles || []).some((f) => changedPaths.includes(f.filename))) {
          pastPrs.push({ number: p.number, title: p.title });
        }
      } catch { /* skip this PR */ }
      if (pastPrs.length >= 3) break;
    }
  } catch { /* past PRs are best-effort */ }

  return { configYaml, linkedIssueText, ciSummary, pastPrs };
}

async function postPrComment({ owner, repo, number }, body, token) {
  return gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, token, { method: 'POST', body: { body } });
}

async function runPrReview({ owner, repo, number }, { profile, depth, post = false, byom = null } = {}) {
  const token = process.env.GITHUB_TOKEN || null;
  const pr = await gh.getPr({ owner, repo, number }, token);
  const diffText = await gh.getPrDiff({ owner, repo, number }, token);
  const files = parseDiff(diffText);
  const ctx = await gatherPrContext({ owner, repo, headSha: pr.head.sha, prBody: pr.body || '', changedPaths: files.map((f) => f.path) }, token);
  const config = loadConfig(ctx.configYaml);

  // Ephemeral sandbox worker: clone shallow + sparse (honouring
  // path_filters), read files from the clone, never run repo code.
  // Falls back to the GitHub Contents API if the clone fails.
  let repoDir = null;
  let cleanup = null;
  const fileContents = {};
  let guidelines = '';
  try {
    const cloned = await cloneRepo({ owner, repo, ref: pr.head.sha, pathFilters: config.pathFilters }, token);
    repoDir = cloned.dir;
    cleanup = cloned.cleanup;
    for (const f of files.slice(0, 20)) {
      const text = readFileFromClone(repoDir, f.path);
      if (text) fileContents[f.path] = text;
    }
    guidelines = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']
      .map((p) => readFileFromClone(repoDir, p))
      .filter(Boolean)
      .join('\n\n');
  } catch (e) {
    console.error('[sandbox] clone failed, falling back to API contents:', e.message.slice(0, 120));
  }
  if (Object.keys(fileContents).length === 0) {
    for (const f of files.slice(0, 20)) {
      try {
        const text = await gh.getFileContent({ owner, repo, path: f.path, ref: pr.head.sha }, token);
        if (text) fileContents[f.path] = text;
      } catch { /* missing/deleted file — skip */ }
    }
  }
  if (!guidelines) {
    for (const p of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const text = await gh.getFileContent({ owner, repo, path: p, ref: pr.head.sha }, token);
        if (text) guidelines += (guidelines ? '\n\n' : '') + text;
      } catch { /* no guideline file */ }
    }
  }

  let review;
  try {
    review = await reviewDiff(diffText, {
      repo: `${owner}/${repo}`,
      prBody: pr.body || '',
      prTitle: pr.title || '',
      fileContents,
      configYaml: ctx.configYaml,
      profile,
      depth,
      guidelines,
      linkedIssueText: ctx.linkedIssueText,
      ciSummary: ctx.ciSummary,
      pastPrs: ctx.pastPrs,
      repoDir,
      byom,
    });
  } finally {
    if (cleanup) cleanup();
  }
  review.pr = { owner, repo, number, title: pr.title, headSha: pr.head.sha, url: pr.html_url };
  saveLastReview(review);

  let posted = null;
  if (post) {
    if (!gh.appConfigured()) {
      posted = { skipped: true, reason: 'posting skipped — no GitHub App configured (set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY)' };
    } else {
      try {
        const installToken = await gh.getInstallationToken({ owner, repo });
        await gh.createCheckRun({ owner, repo, headSha: pr.head.sha }, { status: 'in_progress' }, installToken);
        const postedReview = await gh.postReview({ owner, repo, number, review, headSha: pr.head.sha }, installToken);
        await gh.updatePrBodySummary({ owner, repo, number }, review, installToken);
        const crit = review.findings.filter((f) => f.severity === 'critical').length;
        const gateFailed = review.qualityGates && review.qualityGates.pass === false;
        await gh.createCheckRun({ owner, repo, headSha: pr.head.sha }, {
          status: 'completed',
          conclusion: (crit || gateFailed) ? 'failure' : 'success',
          output: { title: `Axofy Code Review: ${review.findings.length} finding(s)`, summary: review.summary.text.slice(0, 2000) },
        }, installToken);
        posted = { skipped: false, reviewId: postedReview.id, url: postedReview.html_url || null };
      } catch (e) {
        posted = { skipped: true, reason: 'posting failed: ' + e.message.slice(0, 200) };
      }
    }
  }
  review.posted = posted;
  return review;
}

async function handleWebhook(req, res) {
  const raw = await readBody(req);
  const sig = req.headers['x-hub-signature-256'];
  const check = verifySignature(process.env.GITHUB_WEBHOOK_SECRET, raw, sig);
  if (!check.ok) return sendJson(res, 401, { error: 'webhook signature invalid: ' + check.reason });
  const delivery = req.headers['x-github-delivery'];
  if (isDuplicate(delivery)) return sendJson(res, 200, { ok: true, deduped: true });
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const eventName = req.headers['x-github-event'];
  const repoFull = event.repository?.full_name || '';

  // Chat commands in issue comments.
  if (eventName === 'issue_comment' && event.comment && event.issue?.pull_request) {
    const cmd = parseCommand(event.comment.body || '');
    if (!cmd) return sendJson(res, 200, { ok: true, ignored: 'not addressed to @axoreview' });
    const number = event.issue.number;
    const [owner, repo] = repoFull.split('/');
    if (cmd === 'pause') { setPaused(repoFull, true); return sendJson(res, 200, { ok: true, command: 'pause', repo: repoFull }); }
    if (cmd === 'resume') { setPaused(repoFull, false); return sendJson(res, 200, { ok: true, command: 'resume', repo: repoFull }); }
    if (cmd === 'help') {
      // Best effort: reply as an issue comment when the App is configured.
      if (gh.appConfigured()) {
        try {
          const t = await gh.getInstallationToken({ owner, repo });
          await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, t, { method: 'POST', body: { body: HELP_TEXT } });
        } catch { /* help reply is best-effort */ }
      }
      return sendJson(res, 200, { ok: true, command: 'help', help: HELP_TEXT });
    }
    if (cmd === 'resolve' || cmd === 'configuration' || cmd === 'generate-docstrings' || cmd === 'generate-sequence-diagram' || cmd === 'approve') {
      if (!gh.appConfigured()) {
        return sendJson(res, 200, { ok: true, command: cmd, note: 'This command needs the GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) to post back to the PR.' });
      }
      try {
        const installToken = await gh.getInstallationToken({ owner, repo });
        if (cmd === 'approve') {
          await gh.approvePr({ owner, repo, number }, installToken);
          return sendJson(res, 200, { ok: true, command: 'approve' });
        }
        if (cmd === 'resolve') {
          const threads = await gh.listReviewThreads({ owner, repo, number }, installToken);
          const open = threads.filter((t) => !t.isResolved);
          for (const t of open) { try { await gh.resolveThread(t.id, installToken); } catch { /* one bad thread must not block the rest */ } }
          await postPrComment({ owner, repo, number }, `Axofy Code Review resolved ${open.length} open review thread(s).`, installToken);
          return sendJson(res, 200, { ok: true, command: 'resolve', resolved: open.length });
        }
        if (cmd === 'configuration') {
          const prMeta = await gh.getPr({ owner, repo, number }, installToken);
          const cfgYaml = await gh.getFileContent({ owner, repo, path: '.axoreview.yaml', ref: prMeta.head.sha }, installToken).catch(() => '');
          const cfg = loadConfig(cfgYaml || '');
          const text = ['**Axofy Code Review configuration for this repo**', '',
            `- Profile: ${cfg.profile}`, `- Language: ${cfg.language} · Tone: ${cfg.tone}`,
            `- Path filters: ${cfg.pathFilters.join(', ') || 'none (review everything)'}`,
            `- Pre-merge checks: ${cfg.preMergeChecks.map((c) => c.name).join(', ') || 'none'}`,
            `- Summary: ${cfg.summaryEnabled ? 'on' : 'off'} · Walkthrough: ${cfg.walkthroughEnabled ? 'on' : 'off'} · Chat auto-reply: ${cfg.chatAutoReply ? 'on' : 'off'}`,
            `- Token budget: ${cfg.maxContextChars} chars · Cache: ${cfg.cacheEnabled ? 'on (7-day TTL)' : 'off'}`,
            '', cfgYaml ? 'Source: `.axoreview.yaml` on the default branch.' : 'No `.axoreview.yaml` found — using defaults.'].join('\n');
          await postPrComment({ owner, repo, number }, text, installToken);
          return sendJson(res, 200, { ok: true, command: 'configuration' });
        }
        // generate-docstrings / generate-sequence-diagram
        const diffText = await gh.getPrDiff({ owner, repo, number }, installToken);
        if (cmd === 'generate-sequence-diagram') {
          const review = await reviewDiff(diffText, { repo: repoFull, skipLlm: true });
          await postPrComment({ owner, repo, number }, '### Axofy Code Review sequence diagram\n\n```mermaid\n' + review.diagram + '\n```', installToken);
          return sendJson(res, 200, { ok: true, command: 'generate-sequence-diagram' });
        }
        if (llmMode() === 'mock') {
          await postPrComment({ owner, repo, number }, 'Axofy Code Review docstring generation needs an LLM key (set a free NVIDIA/Groq/OpenRouter/Gemini key). Nothing was faked.', installToken);
          return sendJson(res, 200, { ok: true, command: 'generate-docstrings', status: 'needs-llm' });
        }
        const { content } = await chat(
          [{ role: 'system', content: 'Write concise docstrings/comments for the added/changed code. Explain why, not what. Output only the documented code.' },
           { role: 'user', content: 'Diff:\n' + diffText.slice(0, 12000) }],
          { temperature: 0.1, maxTokens: 4096 }
        );
        await postPrComment({ owner, repo, number }, '### Axofy Code Review docstrings\n\n```\n' + content + '\n```', installToken);
        return sendJson(res, 200, { ok: true, command: 'generate-docstrings' });
      } catch (e) {
        return sendJson(res, 200, { ok: true, command: cmd, error: 'command failed: ' + e.message.slice(0, 200) });
      }
    }
    // review / full-review / summary: run async, answer 200 now.
    if (['review', 'full-review', 'summary'].includes(cmd)) {
      if (isPaused(repoFull)) return sendJson(res, 200, { ok: true, command: cmd, skipped: 'repo paused — @axoreview resume to re-enable' });
      runPrReview({ owner, repo, number }, { post: true }).catch((e) => console.error('[webhook] review failed:', e.message));
      return sendJson(res, 200, { ok: true, command: cmd, status: 'review started' });
    }
    return sendJson(res, 200, { ok: true, command: cmd, note: 'unknown command — try @axoreview help' });
  }

  // PR events: auto-review on open / new commits / reopen.
  if (eventName === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(event.action)) {
    const pr = event.pull_request;
    if (pr.draft) return sendJson(res, 200, { ok: true, ignored: 'draft PR' });
    if (isPaused(repoFull)) return sendJson(res, 200, { ok: true, skipped: 'repo paused' });
    const [owner, repo] = repoFull.split('/');
    const queued = reviewQueue.enqueue(
      { repo: repoFull, prNumber: pr.number, headSha: pr.head.sha },
      () => runPrReview({ owner, repo, number: pr.number }, { post: true })
    );
    return sendJson(res, 200, { ok: true, status: queued.status, queue: queued.key, superseded: queued.superseded || 0, pr: pr.number });
  }

  return sendJson(res, 200, { ok: true, ignored: 'event ' + eventName });
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'axoreview', version: '0.3.0', free: true, billing: 'none', axofyCostUsd: 0, llm: llmMode(), githubApp: gh.appConfigured(), providers: listProviders().length });
    }
    if (req.method === 'GET' && url.pathname === '/sample.diff') {
      try {
        const diff = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-pr.diff'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(diff);
      } catch {
        return sendJson(res, 404, { error: 'sample diff not found' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/last-review') {
      const last = loadLastReview();
      return last ? sendJson(res, 200, last) : sendJson(res, 404, { error: 'no review yet' });
    }
    if (req.method === 'GET' && url.pathname === '/api/learnings') {
      return sendJson(res, 200, { learnings: listLearnings(url.searchParams.get('repo') || null) });
    }
    if (req.method === 'POST' && url.pathname === '/api/learnings') {
      const body = await readJsonBody(req);
      const entry = addLearning({ repo: body.repo, rule: body.rule, scope: body.scope });
      if (!entry) return sendJson(res, 400, { error: 'rule is required' });
      return sendJson(res, 201, { ok: true, learning: entry });
    }
    if (req.method === 'GET' && url.pathname === '/api/hosts') {
      return sendJson(res, 200, { hosts: hostStatus(), note: 'GitHub is live. GitLab / Bitbucket / Azure DevOps are adapter-ready: webhook parsing + setup docs exist, diff fetch and posting need that host token + webhook configured — they return not-configured, never faked as working.' });
    }
    if (req.method === 'POST' && ['/webhook/gitlab', '/webhook/bitbucket', '/webhook/azure'].includes(url.pathname)) {
      const host = url.pathname.split('/').pop();
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const event = normalizeEvent(host, req.headers, body);
      const cfg = notConfigured(host);
      return sendJson(res, 501, { ...cfg, event: event ? { repo: event.repo, prNumber: event.prNumber, action: event.action } : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      // Public BYOM table: Axofy pays $0 for every provider. No keys here.
      return sendJson(res, 200, { axofyCostUsd: 0, note: 'Bring your own model: your key, your bill (free tiers / local = $0). Axofy never pays for a model and never stores your key.', providers: listProviders() });
    }
    if (req.method === 'POST' && url.pathname === '/api/providers/test') {
      const body = await readJsonBody(req);
      // byom.apiKey is used for this test only — never stored, never logged.
      const result = await testProvider({ provider: body.provider, model: body.model, baseUrl: body.baseUrl, apiKey: body.apiKey });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/gates') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.findings)) return sendJson(res, 400, { error: 'findings is required (array)' });
      const cfg = loadConfig(body.configYaml || '');
      return sendJson(res, 200, evaluateGates(body.findings, cfg.qualityGates, { testGap: body.testGap === true || body.findings.some((f) => f.source === 'deep:test-gap') }));
    }
    if (req.method === 'POST' && url.pathname === '/api/autofix/bulk') {
      const body = await readJsonBody(req);
      if (!body.diff) return sendJson(res, 400, { error: 'diff is required' });
      let findings = body.findings;
      if (!findings) {
        const review = await reviewDiff(body.diff, { repo: body.repo || null, profile: body.profile, byom: body.byom || null });
        findings = [...review.findings, ...review.groupedFindings];
      }
      const result = buildBulkAutofix(body.diff, findings, { maxFiles: Math.min(200, Number(body.maxFiles) || 200) });
      return sendJson(res, 200, { status: 'ok', ...result, note: 'Apply with: git apply axoreview-fix.patch — review the patch before applying; manual items need a human.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/learnings/feedback') {
      const body = await readJsonBody(req);
      if (typeof body.accepted !== 'boolean') return sendJson(res, 400, { error: 'accepted (true/false) is required' });
      const entry = recordFeedback({ findingId: body.findingId, title: body.title, file: body.file, line: body.line, source: body.source, accepted: body.accepted, repo: body.repo });
      if (!entry) return sendJson(res, 400, { error: 'could not store feedback' });
      return sendJson(res, 201, { ok: true, feedback: entry, note: body.accepted ? 'Finding confirmed as correct — it will keep appearing.' : 'Finding rejected — similar findings will be suppressed in future reviews.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/review-jobs') {
      const body = await readJsonBody(req);
      if (!body.diff || typeof body.diff !== 'string') return sendJson(res, 400, { error: 'diff is required (unified diff text)' });
      // byom.apiKey (if any) lives only in this job's memory closure until the
      // run finishes — never written to disk, never logged, never cached.
      const job = reviewJobs.create(() => reviewDiff(body.diff, {
        repo: body.repo || null, prBody: body.prBody || '', prTitle: body.prTitle || '',
        configYaml: body.configYaml || '', profile: body.profile, depth: body.depth, previousDiff: body.previousDiff || null,
        byom: body.byom || null,
      }));
      return sendJson(res, 202, { jobId: job.id, status: job.status, poll: '/api/review-jobs/' + job.id, note: 'Async review — poll the URL above until status is done. Fully reliable on a long-running server (local / desktop / self-host). On Vercel serverless the function may freeze after this 202, so jobs there are best-effort: use sync /api/review-diff for small diffs, CLI / desktop / self-host for large PRs.' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/review-jobs/')) {
      const id = url.pathname.split('/').pop();
      const job = reviewJobs.get(id);
      if (!job) return sendJson(res, 404, { error: 'job not found' });
      return sendJson(res, 200, reviewJobs.publicView(job));
    }
    if (req.method === 'POST' && url.pathname === '/api/review-line-by-line') {
      const body = await readJsonBody(req);
      // Agent-first line-by-line mode: every changed line gets a verdict.
      // Accepts a unified diff, or a single file ({file: content, path}).
      let diffText = body.diff;
      if (!diffText && (body.file || body.content)) {
        diffText = diffFromFile(body.path || 'file.txt', body.file || body.content);
      }
      if (!diffText || typeof diffText !== 'string') return sendJson(res, 400, { error: 'diff is required (unified diff text), or file + path for a single file' });
      const review = await reviewLineByLine(diffText, {
        repo: body.repo || null, prBody: body.prBody || '', prTitle: body.prTitle || '',
        configYaml: body.configYaml || '', profile: body.profile, depth: body.depth, previousDiff: body.previousDiff || null,
        byom: body.byom || null, seEnabled: body.se !== undefined ? Boolean(body.se) : undefined,
      });
      saveLastReview(review);
      return sendJson(res, 200, review);
    }
    if (req.method === 'POST' && url.pathname === '/api/review-diff') {
      const body = await readJsonBody(req);
      if (!body.diff || typeof body.diff !== 'string') return sendJson(res, 400, { error: 'diff is required (unified diff text)' });
      const review = await reviewDiff(body.diff, {
        repo: body.repo || null, prBody: body.prBody || '', prTitle: body.prTitle || '',
        configYaml: body.configYaml || '', profile: body.profile, depth: body.depth, previousDiff: body.previousDiff || null,
        byom: body.byom || null, seEnabled: body.se !== undefined ? Boolean(body.se) : undefined,
      });
      saveLastReview(review);
      return sendJson(res, 200, review);
    }
    if (req.method === 'POST' && url.pathname === '/api/slop') {
      const body = await readJsonBody(req);
      if (!body.diff) return sendJson(res, 400, { error: 'diff is required' });
      const files = parseDiff(body.diff);
      return sendJson(res, 200, detectSlop({ diffText: body.diff, files, prBody: body.prBody || '', prTitle: body.prTitle || '' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/autofix') {
      const body = await readJsonBody(req);
      if (!body.diff) return sendJson(res, 400, { error: 'diff is required' });
      let findings = body.findings;
      if (!findings) {
        const review = await reviewDiff(body.diff, { repo: body.repo || null, profile: body.profile });
        findings = [...review.findings, ...review.groupedFindings];
      }
      const result = buildAutofixPatch(body.diff, findings);
      return sendJson(res, 200, { status: 'ok', ...result, note: 'Apply with: git apply axoreview-fix.patch — review the patch before applying; manual items need a human.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/finishing') {
      const body = await readJsonBody(req);
      if (!body.diff) return sendJson(res, 400, { error: 'diff is required' });
      const kind = body.kind === 'docstrings' ? 'docstrings' : 'tests';
      if (llmMode() === 'mock') {
        return sendJson(res, 200, { status: 'needs-llm', kind, output: null, note: 'Finishing touches need an LLM. Set a free key (NVIDIA_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY or GEMINI_API_KEY) — see .env.example. Nothing was faked.' });
      }
      const prompt = kind === 'tests'
        ? 'Write focused unit tests for the added/changed code below. Cover edge cases and error paths. Output only the test code with a short header comment saying which framework it targets.'
        : 'Write concise docstrings/comments for the added/changed code below. Explain why, not what. Output only the documented code.';
      const { content } = await chat(
        [{ role: 'system', content: 'You are a senior engineer writing tests and documentation. Output only code.' },
         { role: 'user', content: prompt + '\n\nDiff:\n' + String(body.diff).slice(0, 12000) }],
        { temperature: 0.1, maxTokens: 4096 }
      );
      return sendJson(res, 200, { status: 'ok', kind, output: content });
    }
    if (req.method === 'POST' && url.pathname === '/api/post-merge') {
      const body = await readJsonBody(req);
      if (!body.diff) return sendJson(res, 400, { error: 'diff is required' });
      const files = parseDiff(body.diff);
      const stats = diffStats(files);
      const date = new Date().toISOString().slice(0, 10);
      const version = body.version || 'Unreleased';
      const lines = [`## [${version}] - ${date}`, '', `### Changed`, ...files.map((f) => `- ${f.path} (${f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').length} added, ${f.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'del').length} removed)`), '', `_${stats.files} file(s), +${stats.added}/-${stats.removed} lines. Generated by Axofy Code Review post-merge actions._`];
      return sendJson(res, 200, { status: 'ok', changelog: lines.join('\n'), note: 'Deterministic draft from the diff — edit before publishing. No LLM used.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/triage') {
      const repoParam = url.searchParams.get('repo');
      if (!repoParam || !/^[^/]+\/[^/]+$/.test(repoParam)) return sendJson(res, 400, { error: 'repo is required, e.g. ?repo=owner/repo' });
      const [owner, repo] = repoParam.split('/');
      const token = process.env.GITHUB_TOKEN || null;
      const prs = await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=8`, token);
      const scored = [];
      for (const pr of prs) {
        try {
          const diffText = await gh.getPrDiff({ owner, repo, number: pr.number }, token);
          const files = parseDiff(diffText);
          const review = await reviewDiff(diffText, { repo: repoParam, prTitle: pr.title, prBody: pr.body || '', skipLlm: true });
          const crit = review.findings.filter((f) => f.severity === 'critical').length;
          const major = review.findings.filter((f) => f.severity === 'major').length;
          const riskScore = crit * 10 + major * 5 + review.findings.filter((f) => f.severity === 'minor').length * 2;
          scored.push({
            number: pr.number, title: pr.title, author: pr.user?.login, url: pr.html_url,
            files: review.stats.files, added: review.stats.added, effort: review.effort, risk: review.risk,
            riskScore, critical: crit, major, slop: review.slop?.verdict,
            action: crit ? 'review-first' : review.slop?.verdict === 'likely-slop' ? 'close-or-ask' : riskScore > 15 ? 'review' : 'merge-candidate',
          });
        } catch (e) {
          scored.push({ number: pr.number, title: pr.title, url: pr.html_url, error: 'could not score: ' + e.message.slice(0, 120) });
        }
      }
      scored.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
      return sendJson(res, 200, { repo: repoParam, prs: scored, note: 'Scored by deterministic checks + slop only (no per-PR LLM cost). Highest risk first.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/explain') {
      const body = await readJsonBody(req);
      let diffText = body.diff;
      if (!diffText && body.prUrl) {
        const { owner, repo, number } = gh.parsePrUrl(body.prUrl);
        diffText = await gh.getPrDiff({ owner, repo, number }, process.env.GITHUB_TOKEN || null);
      }
      if (!diffText) return sendJson(res, 400, { error: 'diff or prUrl is required' });
      const files = parseDiff(diffText);
      // Semantic diff: identical lines deleted in one place and added in another = moved code.
      const deleted = [], added = [];
      for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
        if (l.type === 'del' && l.content.trim()) deleted.push({ file: f.path, line: l.oldLine, content: l.content.trim() });
        if (l.type === 'add' && l.content.trim()) added.push({ file: f.path, line: l.newLine, content: l.content.trim() });
      }
      const addedSet = new Map(added.map((a) => [a.content, a]));
      const moved = deleted.filter((d) => addedSet.has(d.content)).map((d) => ({ from: `${d.file}:${d.line}`, to: `${addedSet.get(d.content).file}:${addedSet.get(d.content).line}`, code: d.content.slice(0, 120) }));
      const changeStack = {};
      for (const f of files) {
        const mod = f.path.split('/').slice(0, -1).join('/') || '(root)';
        (changeStack[mod] = changeStack[mod] || []).push(f.path);
      }
      const blastRadius = files.map((f) => ({ file: f.path, callers: findCallers(files, f) })).filter((b) => b.callers.length);
      let architectureImpact = null;
      if (llmMode() !== 'mock') {
        try {
          const { content } = await chat(
            [{ role: 'system', content: 'You are a software architect. Describe the systemic/architectural impact of this change in 3-5 short bullets: which modules, contracts, data flows or invariants are affected. Only use what the diff shows.' },
             { role: 'user', content: 'Changed files: ' + files.map((f) => f.path).join(', ') + '\n\nDiff (truncated):\n' + diffText.slice(0, 8000) }],
            { temperature: 0.1, maxTokens: 1024 }
          );
          architectureImpact = content;
        } catch { architectureImpact = null; }
      }
      return sendJson(res, 200, {
        status: 'ok',
        diagram: buildDiagram(files, []),
        changeStack,
        semanticDiff: { movedLines: moved, movedCount: moved.length, note: moved.length ? 'These lines look moved, not new — review them as a move, not new logic.' : 'No moved code detected.' },
        blastRadius,
        architectureImpact: architectureImpact || 'Architecture impact needs an LLM (set a free key) — the change stack and blast radius above are deterministic and complete without one.',
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/deep-scan') {
      const body = await readJsonBody(req);
      if (!body.repo || !/^[^/]+\/[^/]+$/.test(body.repo)) return sendJson(res, 400, { error: 'repo is required, e.g. owner/repo' });
      const [owner, repo] = body.repo.split('/');
      const result = await deepScan({ owner, repo, ref: body.ref || 'HEAD' }, process.env.GITHUB_TOKEN || null);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJsonBody(req);
      if (!body.question) return sendJson(res, 400, { error: 'question is required' });
      let diffText = body.diff;
      if (!diffText && body.prUrl) {
        const { owner, repo, number } = gh.parsePrUrl(body.prUrl);
        diffText = await gh.getPrDiff({ owner, repo, number }, process.env.GITHUB_TOKEN || null);
      }
      if (llmMode() === 'mock') {
        return sendJson(res, 200, { status: 'needs-llm', answer: null, note: 'Axofy Code Review chat needs an LLM. Set a free key (see .env.example). The deterministic review, checks, triage and deep scan all work without one.' });
      }
      const { content } = await chat(
        [{ role: 'system', content: 'You are Axofy Code Review, a code-review assistant. Answer only from the diff/context provided. Cite file:line. If you do not know, say so.' },
         { role: 'user', content: (diffText ? 'Diff:\n' + diffText.slice(0, 10000) + '\n\n' : '') + 'Question: ' + body.question }],
        { temperature: 0.1, maxTokens: 2048 }
      );
      return sendJson(res, 200, { status: 'ok', answer: content });
    }
    if (req.method === 'GET' && url.pathname === '/api/kb') {
      return sendJson(res, 200, { entries: listKbEntries(url.searchParams.get('repo') || null) });
    }
    if (req.method === 'POST' && url.pathname === '/api/kb') {
      const body = await readJsonBody(req);
      const entry = addKbEntry({ repo: body.repo, source: body.source, title: body.title, text: body.text });
      if (!entry) return sendJson(res, 400, { error: 'text is required' });
      return sendJson(res, 201, { ok: true, entry });
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      const body = await readJsonBody(req);
      if (!body.prUrl) return sendJson(res, 400, { error: 'prUrl is required, e.g. https://github.com/owner/repo/pull/123' });
      const { owner, repo, number } = gh.parsePrUrl(body.prUrl);
      const review = await runPrReview({ owner, repo, number }, { profile: body.profile, depth: body.depth, post: body.post === true, byom: body.byom || null });
      return sendJson(res, 200, review);
    }
    if (req.method === 'POST' && url.pathname === '/webhook/github') {
      return handleWebhook(req, res);
    }
    if (req.method === 'GET') return serveStatic(req, res);
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[axoreview]', e.message);
    return sendJson(res, e.status || 500, { error: e.message.slice(0, 300) });
  }
}

if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, () => {
    console.log(`Axofy Code Review listening on http://localhost:${PORT}`);
    console.log(`LLM: ${process.env.NVIDIA_API_KEY ? 'direct (NVIDIA_API_KEY set)' : 'vault helper / mock'}`);
    console.log(`GitHub App: ${gh.appConfigured() ? 'configured' : 'not configured — posting will be skipped'}`);
  });
}

module.exports = { handleRequest };
