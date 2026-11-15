// lib/secure.js — Secure / Deep Scan (whole-repo mode).
// Deterministic only: fetches the repo file tree via GitHub API, downloads
// text files (size-capped), and runs the same secret/SAST pattern rules as
// lib/checks.js plus dependency + IaC checks (package.json deps with known
// risky patterns, Dockerfiles running as root, Terraform open ingress).
// No LLM needed, so Deep Scan works even with no API key. Never executes
// repo code; only reads it through the GitHub API.
'use strict';

const { RULES } = require('./checks');
const gh = require('./github');

const MAX_FILES = 200;
const MAX_FILE_BYTES = 100 * 1024;
const SKIP_RE = /(^|\/)(node_modules|dist|build|\.git|vendor|__pycache__|\.next|coverage)(\/|$)/;
const TEXT_EXT = /\.(js|ts|jsx|tsx|py|go|rb|php|java|kt|rs|sh|yml|yaml|json|toml|tf|dockerfile|md|txt|env|sql|html|css)$/i;

const DEP_RULES = [
  { id: 'dep-lodash-old', re: /"lodash"\s*:\s*"[<=~^]*[123]\./, title: 'Old lodash version in dependencies', severity: 'minor', explanation: 'Lodash < 4.17.21 has known prototype-pollution issues. Pin a patched version.' },
  { id: 'dep-wildcard', re: /"(dependencies|devDependencies)"[\s\S]*?"[^"]+"\s*:\s*"\*"/, title: 'Wildcard dependency version', severity: 'minor', explanation: 'A "*" dependency can pull breaking or malicious updates at install time.' },
];

const IAC_RULES = [
  { id: 'iac-docker-root', re: /^\s*USER\s+root/m, title: 'Dockerfile runs as root', severity: 'major', explanation: 'Containers running as root amplify a container escape. Use a non-root USER.' },
  { id: 'iac-tf-open-ingress', re: /from_port\s*=\s*0[\s\S]{0,200}to_port\s*=\s*0[\s\S]{0,200}cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/, title: 'Terraform security group open to the world', severity: 'critical', explanation: 'Ingress 0.0.0.0/0 on all ports exposes the resource publicly.' },
];

async function listRepoFiles({ owner, repo, ref }, token) {
  const tree = await gh.fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref || 'HEAD')}?recursive=1`, token);
  return (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
}

async function deepScan({ owner, repo, ref }, token, { onProgress } = {}) {
  const started = Date.now();
  const allPaths = await listRepoFiles({ owner, repo, ref }, token);
  const candidates = allPaths.filter((p) => !SKIP_RE.test(p) && (TEXT_EXT.test(p) || p.toLowerCase() === 'dockerfile')).slice(0, MAX_FILES);
  const findings = [];
  let scanned = 0, skipped = 0;
  for (const p of candidates) {
    try {
      const text = await gh.getFileContent({ owner, repo, path: p, ref: ref || 'HEAD' }, token);
      if (!text) { skipped += 1; continue; }
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) { skipped += 1; continue; }
      scanned += 1;
      const lines = text.split('\n');
      for (const rule of RULES) {
        lines.forEach((content, i) => {
          if (rule.re.test(content)) {
            findings.push({ source: 'deep-scan:' + rule.id, file: p, line: i + 1, severity: rule.severity, category: rule.category, title: rule.title, explanation: rule.explanation, suggestedFix: rule.fix, confidence: 0.95, evidence: content.trim().slice(0, 200) });
          }
        });
      }
      const extraRules = /package\.json$/.test(p) ? DEP_RULES : /\.tf$/.test(p) || /dockerfile/i.test(p) ? IAC_RULES : [];
      for (const rule of extraRules) {
        if (rule.re.test(text)) {
          findings.push({ source: 'deep-scan:' + rule.id, file: p, line: 1, severity: rule.severity, category: 'security', title: rule.title, explanation: rule.explanation, suggestedFix: 'Review and fix the flagged configuration.', confidence: 0.8, evidence: '' });
        }
      }
      if (onProgress) onProgress(scanned, candidates.length);
    } catch { skipped += 1; }
  }
  const bySeverity = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return {
    repo: `${owner}/${repo}`, ref: ref || 'HEAD',
    filesListed: allPaths.length, filesScanned: scanned, filesSkipped: skipped,
    findings: findings.sort((a, b) => ({ critical: 4, major: 3, minor: 2, nitpick: 1 }[b.severity] || 0) - ({ critical: 4, major: 3, minor: 2, nitpick: 1 }[a.severity] || 0)),
    bySeverity, durationMs: Date.now() - started,
    note: `Deterministic scan only (secrets, SAST patterns, dependency + IaC rules). No LLM used. Caps: ${MAX_FILES} files, ${MAX_FILE_BYTES / 1024}KB per file.`,
  };
}

module.exports = { deepScan, listRepoFiles, MAX_FILES, MAX_FILE_BYTES };
