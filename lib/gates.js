// lib/gates.js — quality gates (CodeAnt-style merge gates, free here).
// Config lives in .axoreview.yaml under reviews.quality_gates:
//   block_on_critical (default true), block_on_secrets (default true),
//   block_on_high (default false), max_major (default null = no cap),
//   require_tests (default false — a deep:test-gap finding fails the gate).
// Returns {pass, reasons, checks[]} — the Check Run reflects this result.
// A gate never invents a failure: every failed check names the finding(s).
'use strict';

function evaluateGates(findings, gates, opts = {}) {
  const g = {
    blockOnCritical: gates?.blockOnCritical !== false,
    blockOnSecrets: gates?.blockOnSecrets !== false,
    blockOnHigh: gates?.blockOnHigh === true,
    maxMajor: typeof gates?.maxMajor === 'number' ? gates.maxMajor : null,
    requireTests: gates?.requireTests === true,
  };
  const all = findings || [];
  const critical = all.filter((f) => f.severity === 'critical');
  const major = all.filter((f) => f.severity === 'major');
  const secrets = all.filter((f) => /secret/i.test(f.title || '') || String(f.source || '').includes('secret'));
  const testGap = Boolean(opts.testGap) || all.some((f) => f.source === 'deep:test-gap');
  const checks = [];
  checks.push({ name: 'no critical findings', pass: !(g.blockOnCritical && critical.length), detail: critical.length ? critical.length + ' critical: ' + critical.slice(0, 3).map((f) => f.file + ':' + f.line).join(', ') : 'none' });
  checks.push({ name: 'no hardcoded secrets', pass: !(g.blockOnSecrets && secrets.length), detail: secrets.length ? secrets.length + ' secret finding(s)' : 'none' });
  if (g.blockOnHigh) checks.push({ name: 'no high-risk findings', pass: critical.length + major.length === 0, detail: (critical.length + major.length) + ' critical/major finding(s)' });
  if (g.maxMajor !== null) checks.push({ name: 'major findings <= ' + g.maxMajor, pass: major.length <= g.maxMajor, detail: major.length + ' major finding(s)' });
  if (g.requireTests) checks.push({ name: 'tests added for changed behaviour', pass: !testGap, detail: testGap ? 'changed functions with no test in this PR' : 'tests present or no changed functions' });
  const failed = checks.filter((c) => !c.pass);
  return { pass: failed.length === 0, reasons: failed.map((c) => c.name + ' — ' + c.detail), checks, blockedBy: failed.map((c) => c.name) };
}

module.exports = { evaluateGates };
