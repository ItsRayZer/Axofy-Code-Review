// update-check.js — check GitHub Releases for a newer Axofy Code Review.
// STUB by design: it only REPORTS an available update with a link. It never
// downloads or installs anything automatically. Testable with plain node.
'use strict';

const https = require('https');

// Compare two semver-ish strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '').split('.').map((n) => {
    const m = /^\d+/.exec(n);
    return m ? parseInt(m[0], 10) : 0;
  });
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchLatestRelease(repo, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases/latest`,
        headers: { 'User-Agent': 'Axofy-Code-Review-Desktop', Accept: 'application/vnd.github+json' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 404) return resolve({ error: 'No releases published yet for ' + repo });
          if (res.statusCode !== 200) return resolve({ error: 'GitHub API returned HTTP ' + res.statusCode });
          try {
            const json = JSON.parse(body);
            resolve({ tag: json.tag_name || '', name: json.name || '', url: json.html_url || '', publishedAt: json.published_at || '' });
          } catch {
            resolve({ error: 'Could not parse the GitHub Releases response.' });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ error: 'Update check failed: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'Update check timed out.' }); });
  });
}

async function checkForUpdate(currentVersion, repo) {
  const latest = await fetchLatestRelease(repo);
  if (latest.error) return { updateAvailable: false, currentVersion, ...latest };
  const cmp = compareVersions(latest.tag, currentVersion);
  return {
    updateAvailable: cmp > 0,
    currentVersion,
    latestVersion: latest.tag,
    latestName: latest.name,
    url: latest.url,
    publishedAt: latest.publishedAt,
    message: cmp > 0
      ? `Version ${latest.tag} is available (you have ${currentVersion}). Open the release page to download it.`
      : `You are on the latest version (${currentVersion}).`,
  };
}

module.exports = { compareVersions, fetchLatestRelease, checkForUpdate };
