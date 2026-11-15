// lib/github.js — GitHub REST/GraphQL client for Axofy Code Review.
// - Public repos: no token needed for diff + file fetch.
// - Private repos: GITHUB_TOKEN env (classic PAT, repo scope).
// - Posting (reviews, PR body, check runs): GitHub App installation token
//   when GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are set; otherwise posting
//   is skipped with a clear log and the review JSON is still returned.
// Never runs untrusted repo code. Never logs tokens.
'use strict';

const crypto = require('crypto');

const API = 'https://api.github.com';

function authHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'AxoReview/0.1', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

async function fetchJson(url, token, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: authHeaders(token),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${(data && data.message) || text.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parsePrUrl(prUrl) {
  const m = String(prUrl || '').trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!m) throw new Error('Invalid PR URL. Expected https://github.com/<owner>/<repo>/pull/<number>');
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

async function getPrDiff({ owner, repo, number }, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { ...authHeaders(token), Accept: 'application/vnd.github.diff' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} fetching PR diff — check the repo is public or set GITHUB_TOKEN`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function getPr({ owner, repo, number }, token) {
  return fetchJson(`${API}/repos/${owner}/${repo}/pulls/${number}`, token);
}

async function getFileContent({ owner, repo, path, ref }, token) {
  const data = await fetchJson(`${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref || 'HEAD')}`, token);
  if (!data || data.type !== 'file' || !data.content) return null;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

// --- GitHub App auth (RS256 JWT, built with node:crypto — no dependency) ---
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createAppJwt(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + payload);
  const signature = base64url(signer.sign(privateKeyPem));
  return header + '.' + payload + '.' + signature;
}

async function getInstallationToken({ owner, repo }) {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  const jwt = createAppJwt(appId, privateKey.replace(/\\n/g, '\n'));
  const installs = await fetchJson(`${API}/repos/${owner}/${repo}/installation`, jwt);
  const tokenRes = await fetchJson(`${API}/app/installations/${installs.id}/access_tokens`, jwt, { method: 'POST' });
  return tokenRes.token || null;
}

function appConfigured() {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

// Effort estimate per finding (1-5), mirroring CodeRabbit's per-comment effort.
function findingEffort(f) {
  if (typeof f.effort === 'number') return Math.min(5, Math.max(1, f.effort));
  return { critical: 3, major: 2, minor: 1, nitpick: 1 }[f.severity] || 2;
}

// Post a review: summary comment + inline comments with ```suggestion blocks
// and a "Prompt for Coding Agents" section, CodeRabbit-style.
async function postReview({ owner, repo, number, review, headSha }, token) {
  const comments = (review.findings || [])
    .filter((f) => f.line && f.position)
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: `**[${f.severity.toUpperCase()} · ${f.category}] ${f.title}**\n\n${f.explanation}\n\n**Effort:** ${findingEffort(f)}/5${f.evidence ? `\n\n**Evidence:** \`${f.evidence}\`` : ''}\n\n${f.suggestedFix ? '```suggestion\n' + stripToSuggestion(f.suggestedFix) + '\n```\n\n' : ''}<details>\n<summary>Prompt for Coding Agents</summary>\n\nFix the following issue in \`${f.file}:${f.line}\` (${f.severity}, ${f.category}): ${f.title}. ${f.explanation}${f.suggestedFix ? ' Suggested fix: ' + f.suggestedFix : ''} Do not change unrelated code.\n\n</details>\n\n_Axofy Code Review · ${f.source || 'llm'}_`,
    }));
  const summaryBody = buildSummaryBody(review);
  const body = {
    commit_id: headSha,
    body: summaryBody,
    event: 'COMMENT',
    comments,
  };
  return fetchJson(`${API}/repos/${owner}/${repo}/pulls/${number}/reviews`, token, { method: 'POST', body });
}

function stripToSuggestion(fix) {
  // Suggested fix may be prose; keep it short and code-like for the block.
  const lines = String(fix || '').split('\n').filter((l) => l.trim());
  return lines.slice(0, 12).join('\n');
}

// CodeRabbit-style summary body: plain-language summary + walkthrough +
// Mermaid sequence diagram + effort + suggested labels/reviewers +
// linked-issue assessment. Posted as the review comment AND injected into
// the PR description under the <!-- axoreview-summary --> marker (the
// @axoreview summary placeholder, mirroring @coderabbitai summary).
function buildSummaryBody(review) {
  const counts = {};
  for (const f of review.findings || []) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const sevLine = ['critical', 'major', 'minor', 'nitpick'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ') || 'no findings';
  let md = `## Axofy Code Review summary\n\n${review.summary?.text || ''}\n\n`;
  md += `**Effort:** ${review.effort || 3}/5 · **Risk:** ${review.risk || 'moderate'} · **Findings:** ${sevLine}\n\n`;
  if (review.walkthrough?.length) {
    md += `### Walkthrough\n`;
    for (const w of review.walkthrough) md += `- **${w.file}** — ${w.what}\n`;
    md += '\n';
  }
  if (review.diagram) {
    md += `### Sequence diagram\n\n\`\`\`mermaid\n${review.diagram}\n\`\`\`\n\n`;
  }
  if (review.linkedIssues?.length) {
    md += `### Linked-issue assessment\n`;
    for (const n of review.linkedIssues) md += `- Issue #${n} is referenced by this PR (Fixes/Closes). The review checked the change against the linked issue where its text was available.\n`;
    md += '\n';
  }
  if (review.labels?.length) md += `**Suggested labels:** ${review.labels.join(', ')}\n\n`;
  if (review.reviewers?.length) md += `**Suggested reviewers:** ${review.reviewers.join(', ')}\n\n`;
  if (review.slop && review.slop.verdict !== 'ok') md += `**Slop check:** ${review.slop.verdict} (score ${review.slop.score}/100) — ${review.slop.signals.join('; ')}\n\n`;
  return md;
}

const SUMMARY_MARKER = '<!-- axoreview-summary -->';

async function updatePrBodySummary({ owner, repo, number }, review, token) {
  const pr = await getPr({ owner, repo, number }, token);
  const existing = pr.body || '';
  const summary = SUMMARY_MARKER + '\n' + buildSummaryBody(review) + '\n' + SUMMARY_MARKER;
  let next;
  if (existing.includes(SUMMARY_MARKER)) {
    next = existing.replace(new RegExp(SUMMARY_MARKER + '[\\s\\S]*?' + SUMMARY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), summary);
  } else {
    next = existing ? existing + '\n\n' + summary : summary;
  }
  return fetchJson(`${API}/repos/${owner}/${repo}/pulls/${number}`, token, { method: 'PATCH', body: { body: next } });
}

async function createCheckRun({ owner, repo, headSha }, { status, conclusion, output }, token) {
  return fetchJson(`${API}/repos/${owner}/${repo}/check-runs`, token, {
    method: 'POST',
    body: { name: 'AxoReview', head_sha: headSha, status, conclusion, output },
  });
}

// List open review threads on a PR (for @axoreview resolve).
async function listReviewThreads({ owner, repo, number }, token) {
  const query = `query { repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${number}) { reviewThreads(first: 50) { nodes { id isResolved path line comments(first: 1) { nodes { body } } } } } } }`;
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  const data = await res.json();
  return data?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
}

// Approve a PR (for @axoreview approve).
async function approvePr({ owner, repo, number }, token) {
  return fetchJson(`${API}/repos/${owner}/${repo}/pulls/${number}/reviews`, token, {
    method: 'POST',
    body: { event: 'APPROVE', body: 'Approved by Axofy Code Review — all findings resolved or below threshold.' },
  });
}

// Resolve a review thread via GraphQL (used by the @axoreview resolve command).
async function resolveThread(threadId, token) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'mutation { resolveReviewThread(input: {threadId: "' + threadId + '"}) { thread { isResolved } } }' }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  parsePrUrl, getPrDiff, getPr, getFileContent, getInstallationToken, appConfigured,
  postReview, buildSummaryBody, updatePrBodySummary, createCheckRun, resolveThread,
  listReviewThreads, approvePr, findingEffort,
  SUMMARY_MARKER, fetchJson,
};
