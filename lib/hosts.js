// lib/hosts.js — git-host adapters behind one common PR-event schema.
// GitHub is fully implemented (live). GitLab / Bitbucket / Azure DevOps
// have real webhook parsing + a documented setup, but their diff-fetch and
// comment-posting need that host's token + webhook configured — until then
// they return a clear "not-configured" status, never faked as working.
// Common event: { host, event, repo, prNumber, action, headSha, title, body, url }
'use strict';

const HOSTS = {
  github: {
    name: 'GitHub', status: 'live',
    webhookPath: '/webhook/github', eventHeader: 'x-github-event',
    docs: 'GitHub App: Settings → Developer settings → GitHub Apps. Permissions: read Actions/Checks/Discussions/Members/Metadata; read-write Code, Commit statuses, Issues, Pull requests. Events: pull_request, pull_request_review_comment, issue_comment, check_run.',
    needs: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'],
  },
  gitlab: {
    name: 'GitLab', status: 'adapter-ready',
    webhookPath: '/webhook/gitlab', eventHeader: 'x-gitlab-event',
    docs: 'GitLab: Settings → Webhooks → add URL <server>/webhook/gitlab with a Secret Token (= GITLAB_WEBHOOK_SECRET). Trigger on Merge request events + Note events. Token GITLAB_TOKEN (api scope) is needed to fetch the MR diff and post discussions.',
    needs: ['GITLAB_TOKEN', 'GITLAB_WEBHOOK_SECRET'],
  },
  bitbucket: {
    name: 'Bitbucket', status: 'adapter-ready',
    webhookPath: '/webhook/bitbucket', eventHeader: 'x-event-key',
    docs: 'Bitbucket Cloud: Repository settings → Webhooks → add <server>/webhook/bitbucket, trigger on Pull request created/updated + comment created. Token BITBUCKET_TOKEN (App password, pullrequest:write) is needed to fetch the diff and post comments. Bitbucket Data Center uses the same webhook shape with a different base URL.',
    needs: ['BITBUCKET_TOKEN', 'BITBUCKET_WEBHOOK_SECRET'],
  },
  azure: {
    name: 'Azure DevOps', status: 'adapter-ready',
    webhookPath: '/webhook/azure', eventHeader: 'x-azure-event',
    docs: 'Azure DevOps: Project Settings → Service hooks → Webhook → <server>/webhook/azure, trigger on Pull request created/updated + Commented on pull request. Token AZURE_DEVOPS_TOKEN (PAT, Code read+write) is needed to fetch the diff and post review comments.',
    needs: ['AZURE_DEVOPS_TOKEN', 'AZURE_WEBHOOK_SECRET'],
  },
};

function hostStatus() {
  return Object.entries(HOSTS).map(([id, h]) => ({
    id, name: h.name, status: h.status, webhookPath: h.webhookPath,
    configured: h.id === 'github'
      ? Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY)
      : h.needs.every((v) => Boolean(process.env[v])),
    needs: h.needs,
  }));
}

// Parse a webhook payload into the common event schema. Returns null when
// the payload is not a PR/MR event this host handles.
function normalizeEvent(host, headers, body) {
  if (host === 'github') {
    const ev = headers['x-github-event'];
    const repo = body.repository?.full_name || '';
    if (ev === 'pull_request' && body.pull_request) {
      return { host, event: 'pull_request', repo, prNumber: body.pull_request.number, action: body.action, headSha: body.pull_request.head?.sha || '', title: body.pull_request.title || '', body: body.pull_request.body || '', url: body.pull_request.html_url || '' };
    }
    if (ev === 'issue_comment' && body.issue?.pull_request) {
      return { host, event: 'issue_comment', repo, prNumber: body.issue.number, action: 'comment', headSha: '', title: '', body: body.comment?.body || '', url: body.comment?.html_url || '' };
    }
    return null;
  }
  if (host === 'gitlab') {
    const kind = body.object_kind;
    const repo = body.project?.path_with_namespace || '';
    if (kind === 'merge_request' && body.object_attributes) {
      const a = body.object_attributes;
      return { host, event: 'pull_request', repo, prNumber: a.iid, action: a.action, headSha: a.last_commit?.id || '', title: a.title || '', body: a.description || '', url: a.url || '' };
    }
    if (kind === 'note' && body.merge_request) {
      return { host, event: 'issue_comment', repo, prNumber: body.merge_request.iid, action: 'comment', headSha: '', title: '', body: body.object_attributes?.note || '', url: body.object_attributes?.url || '' };
    }
    return null;
  }
  if (host === 'bitbucket') {
    const key = headers['x-event-key'];
    const repo = body.repository?.full_name || '';
    const pr = body.pullrequest;
    if (pr && key && key.startsWith('pullrequest:')) {
      return { host, event: 'pull_request', repo, prNumber: pr.id, action: key.replace('pullrequest:', ''), headSha: pr.source?.commit?.hash || '', title: pr.title || '', body: pr.description || '', url: pr.links?.html?.href || '' };
    }
    if (pr && key === 'pullrequest:comment_created') {
      return { host, event: 'issue_comment', repo, prNumber: pr.id, action: 'comment', headSha: '', title: '', body: body.comment?.content?.raw || '', url: '' };
    }
    return null;
  }
  if (host === 'azure') {
    const type = body.eventType;
    const repo = body.resource?.repository?.name || '';
    const pr = body.resource;
    if (pr && type && type.startsWith('git.pullrequest.')) {
      return { host, event: 'pull_request', repo, prNumber: pr.pullRequestId, action: type.replace('git.pullrequest.', ''), headSha: pr.lastMergeSourceCommit?.commitId || '', title: pr.title || '', body: pr.description || '', url: '' };
    }
    return null;
  }
  return null;
}

function notConfigured(host) {
  const h = HOSTS[host];
  return { status: 'not-configured', host, name: h?.name || host, needs: h?.needs || [], docs: h?.docs || '', note: `Axofy Code Review on ${h?.name || host} is adapter-ready, not live: set ${ (h?.needs || []).join(' + ') } and point the webhook at ${h?.webhookPath || ''}. Nothing was faked — no review was run or posted.` };
}

// Fetch a PR/MR diff. GitHub is implemented via lib/github.js (passed in
// to avoid a circular require). Other hosts throw a not-configured error
// with their setup docs attached.
async function fetchDiff(host, { owner, repo, number }, github) {
  if (host === 'github') return github.getPrDiff({ owner, repo, number }, process.env.GITHUB_TOKEN || null);
  throw Object.assign(new Error(notConfigured(host).note), { status: 'not-configured', host });
}

module.exports = { HOSTS, hostStatus, normalizeEvent, notConfigured, fetchDiff };
