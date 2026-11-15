// public/app.js — Axofy Code Review UI logic. Vanilla JS, no framework.
// Every button calls a real endpoint; phase-2 / needs-LLM responses are
// shown as-is, never faked as working.
'use strict';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(el, msg, isErr) {
  el.textContent = msg || '';
  el.classList.toggle('err', Boolean(isErr));
}

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function copyBtn(text) {
  const id = 'cb' + Math.random().toString(36).slice(2, 8);
  return `<button class="btn copy" data-copy="${id}">Copy</button><span hidden id="${id}">${esc(text)}</span>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = document.getElementById(btn.dataset.copy).textContent;
  navigator.clipboard.writeText(text).then(() => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); });
});

// Tabs
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-' + t.dataset.tab).classList.add('active');
  });
});

// Health
fetch('/health').then((r) => r.json()).then((h) => {
  $('health').textContent = `server ok · LLM: ${h.llm} · GitHub App: ${h.githubApp ? 'configured' : 'not configured'} · billing: none`;
}).catch(() => { $('health').textContent = 'server unreachable'; });

function findingHtml(f) {
  const effort = { critical: 3, major: 2, minor: 1, nitpick: 1 }[f.severity] || 2;
  const agentPrompt = `Fix the following issue in ${f.file}:${f.line} (${f.severity}, ${f.category}): ${f.title}. ${f.explanation}${f.suggestedFix ? ' Suggested fix: ' + f.suggestedFix : ''} Do not change unrelated code.`;
  return `<div class="finding">
    <span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
    <strong> ${esc(f.title)}</strong> ${copyBtn(f.suggestedFix || f.explanation)}
    <div class="meta">${esc(f.file)}:${esc(f.line)} · ${esc(f.category)} · Effort ${effort}/5 · ${esc(f.source || '')}${f.confidence ? ' · confidence ' + esc(f.confidence) : ''}${f.alreadyReviewed ? ' · already reviewed' : ''}</div>
    <div>${esc(f.explanation)}</div>
    ${f.evidence ? `<div class="meta">Evidence:</div><pre>${esc(f.evidence)}</pre>` : ''}
    ${f.suggestedFix ? `<div class="meta">Suggested fix (one-click, GitHub suggestion block):</div><pre>\`\`\`suggestion
${esc(f.suggestedFix)}
\`\`\`</pre>` : ''}
    ${f.repro ? `<details open><summary>Steps of Reproduction</summary><p><strong>Inputs:</strong> ${esc(f.repro.inputs)}</p><pre>${esc(f.repro.executionPath)}</pre><p><strong>Expected:</strong> ${esc(f.repro.expected)}</p><p><strong>Actual:</strong> ${esc(f.repro.actual)}</p></details>` : ''}
    <details><summary>Prompt for Coding Agents</summary><pre>${esc(agentPrompt)}</pre></details>
    <div class="row"><span class="meta">Was this finding right?</span><button class="btn" data-feedback="true" data-finding='${esc(JSON.stringify({ title: f.title, file: f.file, line: f.line, source: f.source }))}' type="button">Correct</button><button class="btn" data-feedback="false" data-finding='${esc(JSON.stringify({ title: f.title, file: f.file, line: f.line, source: f.source }))}' type="button">Wrong — suppress similar</button></div>
  </div>`;
}

const SEV_ORDER = ['critical', 'major', 'minor', 'nitpick'];

function groupBySeverity(findings) {
  const groups = [];
  for (const sev of SEV_ORDER) {
    const list = (findings || []).filter((f) => f.severity === sev);
    if (list.length) groups.push({ sev, list });
  }
  return groups;
}

// GitHub-style inline comment: the same finding, shown as it appears on a PR.
function inlineCommentHtml(f) {
  const effort = { critical: 3, major: 2, minor: 1, nitpick: 1 }[f.severity] || 2;
  const agentPrompt = `Fix the following issue in ${f.file}:${f.line} (${f.severity}, ${f.category}): ${f.title}. ${f.explanation}${f.suggestedFix ? ' Suggested fix: ' + f.suggestedFix : ''} Do not change unrelated code.`;
  return `<article class="gh-comment">
    <header><img src="/marco.png" alt="" width="28" height="28"><span><strong>@axoreview</strong> commented on <code>${esc(f.file)}:${esc(f.line)}</code></span><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span><span class="pill">${esc(f.category)}</span><button class="btn copy" data-resolve type="button">Resolve</button></header>
    <p><strong>${esc(f.title)}</strong> · Effort ${effort}/5${f.confidence ? ' · confidence ' + esc(f.confidence) : ''}${f.alreadyReviewed ? ' · already reviewed' : ''}</p>
    <p>${esc(f.explanation)}</p>
    ${f.evidence ? `<p class="meta">Evidence:</p><pre>${esc(f.evidence)}</pre>` : ''}
    ${f.suggestedFix ? `<p class="meta">Suggested fix (one-click, GitHub suggestion block):</p><pre>\`\`\`suggestion
${esc(f.suggestedFix)}
\`\`\`</pre>` : ''}
    <details><summary>Prompt for Coding Agents</summary><pre>${esc(agentPrompt)}</pre></details>
  </article>`;
}

function reviewHtml(r) {
  const all = [...(r.findings || []), ...(r.groupedFindings || [])];
  const counts = {};
  all.forEach((f) => { counts[f.severity] = (counts[f.severity] || 0) + 1; });
  const critical = counts.critical || 0;
  const check = critical > 0
    ? { cls: 'action', text: `AxoReview check run: completed — action required (${critical} critical finding${critical === 1 ? '' : 's'})` }
    : { cls: 'ok', text: 'AxoReview check run: completed — success (no critical findings)' };
  const kept = (r.findings || []).length + (r.groupedFindings || []).length;
  const dropped = (r.droppedByJudge || []).length;
  const graphEntries = r.codeGraph && r.codeGraph.blastRadius ? Object.entries(r.codeGraph.blastRadius) : [];
  const graphNote = r.codeGraph
    ? 'Code graph built fresh for this review (' + ((r.codeGraph.edges || []).length) + ' edges). Blast radius: ' + (graphEntries.length ? graphEntries.map(([file, b]) => file + ' is used by ' + (b.callers || []).map((c) => c.file + ' (via ' + c.via + ')').join(', ')).join('; ') : 'no cross-file callers detected in the changed files.')
    : 'Code graph: not built for this diff-only review — review a PR URL (or a cloned repo) to trace callers and blast radius.';
  const inlineGroups = groupBySeverity(r.findings || []);
  return `
    <div class="check-run ${check.cls}"><span class="dot"></span><span>${esc(check.text)}</span><span class="meta">${esc(r.durationMs)} ms · LLM: ${esc(r.llmMode)}${r.provider ? ' · Model: ' + esc(r.provider.name) + ' / ' + esc(r.provider.model) + ' (Axofy cost: $0)' : ''}${r.cacheHit ? ' (cached — saved a model call)' : ''}</span></div>
    ${r.qualityGates ? `<div class="check-run ${r.qualityGates.pass ? 'ok' : 'action'}"><span class="dot"></span><span>Quality gates: ${r.qualityGates.pass ? 'PASS — merge allowed' : 'FAIL — merge blocked'}</span><span class="meta">${r.qualityGates.reasons.length ? esc(r.qualityGates.reasons.join('; ')) : 'no critical findings, no secrets'}</span></div>` : ''}
    ${r.customRules && r.customRules.applied && r.customRules.applied.length ? `<p class="meta">Custom rules applied: ${esc(r.customRules.applied.join('; '))} — matched ${esc(r.customRules.matched)}${r.customRules.unmatched && r.customRules.unmatched.length ? ', unmatched: ' + esc(r.customRules.unmatched.join('; ')) : ''}.</p>` : ''}
    ${r.suppressedByFeedback && r.suppressedByFeedback.length ? `<p class="meta">Suppressed by your earlier feedback: ${r.suppressedByFeedback.length} finding(s) hidden.</p>` : ''}
    <div class="pr-summary-block">
      <p class="marker">PR summary — posted into the PR description under &lt;!-- axoreview-summary --&gt; · @axoreview summary</p>
      <h2>${esc(r.summary.title)}</h2>
      <p>${esc(r.summary.text)}</p>
      <p>
        <span class="pill">Effort ${esc(r.effort)}/5</span>
        <span class="pill">Risk: ${esc(r.risk)}</span>
        <span class="pill">Findings: ${Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') || 'none'}</span>
        ${r.slop ? `<span class="pill">Slop: ${esc(r.slop.verdict)} (${esc(r.slop.score)})</span>` : ''}
        ${r.incremental ? `<span class="pill">Incremental: ${esc(r.incremental.skippedAlreadyReviewed)} already-reviewed skipped</span>` : ''}
      </p>
    </div>
    <div class="view-toggle" role="tablist" aria-label="Result view">
      <button class="btn active" data-result-view="summary" type="button">Summary view</button>
      <button class="btn" data-result-view="inline" type="button">Inline comments (${(r.findings || []).length})</button>
    </div>
    <div data-view-panel="summary">
      ${r.walkthrough && r.walkthrough.length ? `<h3>Walkthrough</h3><ul>${r.walkthrough.map((w) => `<li><strong>${esc(w.file)}</strong> — ${esc(w.what)}</li>`).join('')}</ul>` : ''}
      ${r.diagram ? `<h3>Sequence diagram</h3><pre class="code">${esc(r.diagram)}</pre>` : ''}
      ${r.labels && r.labels.length ? `<p>Suggested labels: ${r.labels.map((l) => `<span class="pill">${esc(l)}</span>`).join('')}</p>` : ''}
      ${r.reviewers && r.reviewers.length ? `<p>Suggested reviewers: ${r.reviewers.map((x) => `<span class="pill">${esc(x)}</span>`).join('')}</p>` : ''}
      ${r.linkedIssues && r.linkedIssues.length ? `<h3>Linked-issue assessment</h3><p>Referenced issues: ${r.linkedIssues.map((n) => '#' + n).join(', ')} — the review checked the change against the linked issue text where available.</p>` : ''}
      ${r.plan && r.plan.tasks ? `<h3>Review plan (${esc(r.plan.source)})</h3><ul>${r.plan.tasks.map((t) => `<li>${esc(t.task)}</li>`).join('')}</ul>` : ''}
      <div class="method-line"><strong>How this review was made.</strong> ${esc(r.depth || 'standard')} depth · 3-pass pipeline: per-file review → cross-file summary → judge. ${esc(graphNote)} Judge pass: every finding was verified against the diff and file context — kept ${kept}, dropped ${dropped} as ungrounded or below profile.${r.learningsApplied && r.learningsApplied.length ? ' Learnings applied: ' + r.learningsApplied.map(esc).join('; ') + '.' : ''}${r.kbApplied && r.kbApplied.length ? ' Knowledge base applied: ' + r.kbApplied.map(esc).join('; ') + '.' : ''}</div>
      ${r.deepAnalysis && r.deepAnalysis.architectureImpact ? `<h3>Architecture impact (deep)</h3><ul>${r.deepAnalysis.architectureImpact.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      ${r.deepAnalysis && r.deepAnalysis.blastRadius && Object.keys(r.deepAnalysis.blastRadius.callers || {}).length ? `<h3>Blast radius (deterministic)</h3><ul>${Object.entries(r.deepAnalysis.blastRadius.callers).map(([fn, hits]) => `<li><strong>${esc(fn)}</strong> called from ${hits.map((h) => esc(h.file) + ':' + esc(h.line)).join(', ')}</li>`).join('')}</ul>` : ''}
      <h3>Findings (${r.findings.length} inline${r.groupedFindings.length ? `, ${r.groupedFindings.length} grouped` : ''})</h3>
      ${inlineGroups.length ? inlineGroups.map((g) => `<div class="sev-group"><h3>${g.sev.charAt(0).toUpperCase() + g.sev.slice(1)} (${g.list.length})</h3>${g.list.map(findingHtml).join('')}</div>`).join('') : '<p>No inline findings at this profile.</p>'}
      ${r.groupedFindings.length ? `<h3>Grouped (below profile threshold)</h3>` + r.groupedFindings.map(findingHtml).join('') : ''}
      ${r.droppedByJudge && r.droppedByJudge.length ? `<h3>Dropped by judge (${r.droppedByJudge.length})</h3><ul>${r.droppedByJudge.map((d) => `<li>${esc(d.reason || '')}</li>`).join('')}</ul>` : ''}
      ${r.preMergeChecks && r.preMergeChecks.length ? `<h3>Pre-merge checks</h3><ul>${r.preMergeChecks.map((c) => `<li>${c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'UNKNOWN'} — ${esc(c.name)}: ${esc(c.note || '')}</li>`).join('')}</ul>` : ''}
    </div>
    <div data-view-panel="inline" hidden>
      <p class="meta">The same inline findings, shown as GitHub PR comments from @axoreview. Resolve marks a thread resolved in this view only — resolving on GitHub itself needs the GitHub App.</p>
      ${(r.findings || []).length ? (r.findings || []).map(inlineCommentHtml).join('') : '<p>No inline findings at this profile.</p>'}
    </div>`;
}

let lastDiff = '';
let lastReview = null;


// ---- BYOM (bring your own model): key lives in the input only, never stored ----
// Provider/model/baseUrl are remembered in localStorage; the API key is NOT.
function getByom() {
  const provider = $('byomProvider') ? $('byomProvider').value : 'nvidia';
  const model = $('byomModel') ? $('byomModel').value.trim() : '';
  const baseUrl = $('byomBaseUrl') ? $('byomBaseUrl').value.trim() : '';
  const apiKey = $('byomKey') ? $('byomKey').value : '';
  const byom = { provider };
  if (model) byom.model = model;
  if (baseUrl) byom.baseUrl = baseUrl;
  if (apiKey) byom.apiKey = apiKey;
  try { localStorage.setItem('axoreview-byom', JSON.stringify({ provider, model, baseUrl })); } catch { /* private mode */ }
  return byom;
}
function loadByomPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('axoreview-byom') || '{}');
    if (saved.provider && $('byomProvider')) $('byomProvider').value = saved.provider;
    if (saved.model && $('byomModel')) $('byomModel').value = saved.model;
    if (saved.baseUrl && $('byomBaseUrl')) $('byomBaseUrl').value = saved.baseUrl;
  } catch { /* ignore */ }
}
function customRulesYaml() {
  const rules = ($('customRules') ? $('customRules').value : '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!rules.length) return '';
  return 'reviews:\n  custom_rules:\n' + rules.map((r) => '    - "' + r.replace(/"/g, "'") + '"\n').join('');
}
if ($('testByom')) {
  loadByomPrefs();
  $('testByom').addEventListener('click', async () => {
    const byom = getByom();
    setStatus($('reviewStatus'), 'Testing provider connection…');
    try {
      const data = await postJson('/api/providers/test', byom);
      $('byomStatus').textContent = data.ok ? 'Connection OK: ' + data.provider + ' / ' + data.model + '. ' + (data.note || '') : 'Connection failed: ' + (data.reason || 'unknown error');
      setStatus($('reviewStatus'), '');
    } catch (e) { $('byomStatus').textContent = 'Test failed: ' + e.message; }
  });
}
// Quota / limit meter: Axofy limits = none; provider limits from /api/providers; cache saves.
fetch('/api/providers').then((r) => r.json()).then((d) => {
  const el = $('quotaMeter');
  if (!el) return;
  const lines = (d.providers || []).map((p) => `${p.label}: ${p.userCost}${p.local ? ' (local)' : ''}`).join(' · ');
  el.innerHTML = '<strong>Limits — Axofy: none.</strong> No hourly cap, no file cap, no seat billing. Your provider’s free-tier limit is the only limit: ' + esc(lines) + '. Cache: 7-day response cache + per-file cache + incremental-only review, so repeat reviews cost $0 model calls.';
}).catch(() => { const el = $('quotaMeter'); if (el) el.textContent = 'Limits — Axofy: none. Provider limits could not be loaded.'; });
// First-run checklist, saved in the browser only.
document.querySelectorAll('#onboardingChecklist input[data-step]').forEach((cb) => {
  try { cb.checked = localStorage.getItem('axoreview-step-' + cb.dataset.step) === '1'; } catch { /* ignore */ }
  cb.addEventListener('change', () => { try { localStorage.setItem('axoreview-step-' + cb.dataset.step, cb.checked ? '1' : '0'); } catch { /* ignore */ } });
});
// One-click demo PR: load the sample diff and run a real review.
if ($('demoPrOneClick')) {
  $('demoPrOneClick').addEventListener('click', async () => {
    try {
      const res = await fetch('/sample.diff');
      $('diffInput').value = res.ok ? await res.text() : '';
      $('prUrl').value = '';
      await runReview(false);
      const step = document.querySelector('#onboardingChecklist input[data-step="review"]');
      if (step) { step.checked = true; step.dispatchEvent(new Event('change')); }
    } catch (e) { setStatus($('reviewStatus'), 'Demo failed: ' + e.message, true); }
  });
}
// Feedback buttons (correct / wrong) on findings — event delegation.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-feedback]');
  if (!btn) return;
  try {
    const f = JSON.parse(btn.dataset.finding);
    const data = await postJson('/api/learnings/feedback', { ...f, accepted: btn.dataset.feedback === 'true' });
    btn.textContent = btn.dataset.feedback === 'true' ? 'Thanks — confirmed' : 'Thanks — will suppress similar';
    btn.disabled = true;
    setStatus($('reviewStatus'), data.note || '');
  } catch (err) { setStatus($('reviewStatus'), 'Feedback failed: ' + err.message, true); }
});

async function runReview(incremental) {
  const status = $('reviewStatus');
  const prUrl = $('prUrl').value.trim();
  const diff = $('diffInput').value;
  if (!prUrl && !diff.trim()) { setStatus(status, 'Enter a PR URL or paste a diff first.', true); return; }
  const btn = $('runReview');
  btn.disabled = true;
  setStatus(status, 'Reviewing… (deterministic checks first, then LLM passes)');
  try {
    let r;
    if (prUrl) {
      r = await postJson('/api/review', { prUrl, profile: $('profile').value, depth: $('depth').value, post: $('postToGh').checked, byom: getByom() });
    } else {
      const body = { diff, profile: $('profile').value, depth: $('depth').value, byom: getByom() };
      const cr = customRulesYaml();
      if (cr) body.configYaml = cr;
      if (incremental && lastDiff) body.previousDiff = lastDiff;
      r = await postJson('/api/review-diff', body);
      lastDiff = diff;
    }
    lastReview = r;
    $('reviewResult').innerHTML = reviewHtml(r);
    setStatus(status, r.posted && r.posted.skipped ? 'Review done. Posting skipped: ' + r.posted.reason : 'Review done.');
  } catch (e) {
    setStatus(status, 'Review failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('runReview').addEventListener('click', () => runReview(false));
$('runIncremental').addEventListener('click', () => runReview(true));
$('loadSample').addEventListener('click', async () => {
  try {
    const res = await fetch('/sample.diff');
    $('diffInput').value = res.ok ? await res.text() : 'Sample diff is served from the repo fixtures folder — paste a diff manually if this fails.';
  } catch {
    $('diffInput').value = '';
    setStatus($('reviewStatus'), 'Could not load the sample — paste a diff manually.', true);
  }
});

// Triage
$('runTriage').addEventListener('click', async () => {
  const repo = $('triageRepo').value.trim();
  if (!repo) { setStatus($('triageStatus'), 'Enter a repo (owner/repo).', true); return; }
  setStatus($('triageStatus'), 'Scoring open PRs…');
  try {
    const res = await fetch('/api/triage?repo=' + encodeURIComponent(repo));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    $('triageResult').innerHTML = data.prs.length ? `<table><tr><th>PR</th><th>Risk</th><th>Effort</th><th>Action</th></tr>${data.prs.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener">#${esc(p.number)} ${esc(p.title)}</a><br><span class="meta">${esc(p.author || '')}</span></td><td>${esc(p.risk || p.error || '')} (score ${esc(p.riskScore ?? '')})<br>${esc(p.critical ?? '')} critical, ${esc(p.major ?? '')} major</td><td>${esc(p.effort ?? '')}/5</td><td>${esc(p.action || '')}</td></tr>`).join('')}</table><p class="lede">${esc(data.note || '')}</p>` : '<p>No open PRs.</p>';
    setStatus($('triageStatus'), '');
  } catch (e) { setStatus($('triageStatus'), 'Triage failed: ' + e.message, true); }
});

// Deep Scan
$('runScan').addEventListener('click', async () => {
  const repo = $('scanRepo').value.trim();
  if (!repo) { setStatus($('scanStatus'), 'Enter a repo (owner/repo).', true); return; }
  setStatus($('scanStatus'), 'Scanning repo (this can take a minute)…');
  try {
    const data = await postJson('/api/deep-scan', { repo, ref: $('scanRef').value.trim() || 'HEAD' });
    $('scanResult').innerHTML = `<p>Scanned ${esc(data.filesScanned)} files (${esc(data.filesSkipped)} skipped) in ${esc(data.durationMs)} ms. By severity: ${Object.entries(data.bySeverity || {}).map(([k, v]) => v + ' ' + k).join(', ') || 'none'}.</p>
      <p class="lede">${esc(data.note || '')}</p>
      ${data.findings.map(findingHtml).join('') || '<p>No findings.</p>'}`;
    setStatus($('scanStatus'), '');
  } catch (e) { setStatus($('scanStatus'), 'Deep Scan failed: ' + e.message, true); }
});

// Explain
$('runExplain').addEventListener('click', async () => {
  const prUrl = $('explainUrl').value.trim();
  const diff = $('explainDiff').value;
  if (!prUrl && !diff.trim()) { setStatus($('explainStatus'), 'Enter a PR URL or paste a diff.', true); return; }
  setStatus($('explainStatus'), 'Explaining…');
  try {
    const data = await postJson('/api/explain', prUrl ? { prUrl } : { diff });
    $('explainResult').innerHTML = `
      ${data.diagram ? `<h3>Sequence diagram</h3><pre class="code">${esc(data.diagram)}</pre>` : ''}
      <h3>Change Stack</h3><pre class="code">${esc(JSON.stringify(data.changeStack, null, 2))}</pre>
      <h3>Semantic diff — moved code (${esc(data.semanticDiff.movedCount)})</h3>
      <p>${esc(data.semanticDiff.note)}</p>
      ${data.semanticDiff.movedLines.map((m) => `<p><code>${esc(m.from)} → ${esc(m.to)}</code><br>${esc(m.code)}</p>`).join('')}
      <h3>Blast radius</h3>
      ${data.blastRadius.length ? data.blastRadius.map((b) => `<p><strong>${esc(b.file)}</strong> is used by: ${b.callers.map((c) => esc(c.file) + ' (' + c.names.join(', ') + ')').join('; ')}</p>`).join('') : '<p>No cross-file callers detected in this diff.</p>'}
      <h3>Architecture impact</h3><pre class="code">${esc(data.architectureImpact)}</pre>`;
    setStatus($('explainStatus'), '');
  } catch (e) { setStatus($('explainStatus'), 'Explain failed: ' + e.message, true); }
});

// Tools
function toolsDiff() {
  return $('toolsDiff').value.trim() || lastDiff;
}
$('runFinish').addEventListener('click', async () => {
  const diff = toolsDiff();
  if (!diff) { setStatus($('toolsStatus'), 'Paste a diff or run a review first.', true); return; }
  setStatus($('toolsStatus'), 'Generating…');
  try {
    const data = await postJson('/api/finishing', { diff, kind: $('finishKind').value });
    $('toolsResult').innerHTML = data.status === 'needs-llm'
      ? `<p><strong>Needs an LLM key.</strong> ${esc(data.note)}</p>`
      : `<h3>${esc(data.kind === 'tests' ? 'Generated tests' : 'Generated docstrings')}</h3><pre class="code">${esc(data.output)}</pre>`;
    setStatus($('toolsStatus'), '');
  } catch (e) { setStatus($('toolsStatus'), 'Failed: ' + e.message, true); }
});
$('runAutofix').addEventListener('click', async () => {
  const diff = toolsDiff();
  if (!diff) { setStatus($('toolsStatus'), 'Paste a diff or run a review first.', true); return; }
  setStatus($('toolsStatus'), 'Building Autofix patch…');
  try {
    const findings = lastReview ? [...lastReview.findings, ...lastReview.groupedFindings] : undefined;
    const data = await postJson('/api/autofix', { diff, findings });
    $('toolsResult').innerHTML = `<h3>Autofix patch</h3>
      <p>Applied ${esc(data.applied.length)} fix(es); ${esc(data.manual.length)} need a human.</p>
      ${data.patch ? `<pre class="code">${esc(data.patch)}</pre>` : '<p>No safe automatic fixes for these findings.</p>'}
      <h3>Manual (needs a human)</h3><ul>${data.manual.map((m) => `<li>${esc(m.file)}:${esc(m.line)} — ${esc(m.title)}: ${esc(m.reason)}</li>`).join('')}</ul>
      <p class="lede">${esc(data.note)}</p>`;
    setStatus($('toolsStatus'), '');
  } catch (e) { setStatus($('toolsStatus'), 'Failed: ' + e.message, true); }
});

$('runBulkAutofix').addEventListener('click', async () => {
  const diff = toolsDiff();
  if (!diff) { setStatus($('toolsStatus'), 'Paste a diff or run a review first.', true); return; }
  setStatus($('toolsStatus'), 'Applying all safe fixes (bulk, up to 200 files)…');
  try {
    const findings = lastReview ? [...lastReview.findings, ...lastReview.groupedFindings] : undefined;
    const data = await postJson('/api/autofix/bulk', { diff, findings, byom: getByom() });
    $('toolsResult').innerHTML = `<h3>Bulk Autofix patch</h3>
      <p>Applied ${esc(data.applied.length)} fix(es) across ${esc(data.filesFixed)} file(s)${data.capped ? ' — capped at 200 files, ' + esc(data.totalFiles - data.maxFiles) + ' file(s) need manual fixes' : ''}; ${esc(data.manual.length)} need a human.</p>
      ${data.patch ? `<pre class="code">${esc(data.patch)}</pre>` : '<p>No safe automatic fixes for these findings.</p>'}
      <h3>Manual (needs a human)</h3><ul>${data.manual.map((m) => `<li>${esc(m.file)}:${esc(m.line)} — ${esc(m.title)}: ${esc(m.reason)}</li>`).join('')}</ul>
      <p class="lede">${esc(data.note)}</p>`;
    setStatus($('toolsStatus'), '');
  } catch (e) { setStatus($('toolsStatus'), 'Failed: ' + e.message, true); }
});
$('runChangelog').addEventListener('click', async () => {
  const diff = toolsDiff();
  if (!diff) { setStatus($('toolsStatus'), 'Paste a diff or run a review first.', true); return; }
  try {
    const data = await postJson('/api/post-merge', { diff });
    $('toolsResult').innerHTML = `<h3>Changelog draft</h3><pre class="code">${esc(data.changelog)}</pre><p class="lede">${esc(data.note)}</p>`;
    setStatus($('toolsStatus'), '');
  } catch (e) { setStatus($('toolsStatus'), 'Failed: ' + e.message, true); }
});
$('runChat').addEventListener('click', async () => {
  const q = $('chatQ').value.trim();
  if (!q) { setStatus($('toolsStatus'), 'Ask a question first.', true); return; }
  setStatus($('toolsStatus'), 'Asking…');
  try {
    const data = await postJson('/api/chat', { question: q, diff: toolsDiff() || undefined });
    $('toolsResult').innerHTML = data.status === 'needs-llm'
      ? `<p><strong>Needs an LLM key.</strong> ${esc(data.note)}</p>`
      : `<h3>Answer</h3><pre class="code">${esc(data.answer)}</pre>`;
    setStatus($('toolsStatus'), '');
  } catch (e) { setStatus($('toolsStatus'), 'Failed: ' + e.message, true); }
});

// Learnings & KB
async function refreshKb() {
  try {
    const [l, k] = await Promise.all([
      fetch('/api/learnings').then((r) => r.json()),
      fetch('/api/kb').then((r) => r.json()),
    ]);
    $('kbResult').innerHTML = `<h3>Learnings (${(l.learnings || []).length})</h3><ul>${(l.learnings || []).map((x) => `<li>[${esc(x.repo)}] ${esc(x.rule)}</li>`).join('') || '<li>None yet.</li>'}</ul>
      <h3>Knowledge base (${(k.entries || []).length})</h3><ul>${(k.entries || []).map((x) => `<li>[${esc(x.source)} · ${esc(x.repo)}] <strong>${esc(x.title || '')}</strong> — ${esc(x.text.slice(0, 160))}</li>`).join('') || '<li>None yet.</li>'}</ul>`;
    setStatus($('kbStatus'), '');
  } catch (e) { setStatus($('kbStatus'), 'Failed to load: ' + e.message, true); }
}
$('addLearning').addEventListener('click', async () => {
  const rule = $('learnRule').value.trim();
  if (!rule) { setStatus($('kbStatus'), 'Write a rule first.', true); return; }
  try {
    await postJson('/api/learnings', { repo: $('learnRepo').value.trim() || 'global', rule });
    $('learnRule').value = '';
    setStatus($('kbStatus'), 'Learning saved.');
    refreshKb();
  } catch (e) { setStatus($('kbStatus'), 'Failed: ' + e.message, true); }
});
$('addKb').addEventListener('click', async () => {
  const text = $('kbText').value.trim();
  if (!text) { setStatus($('kbStatus'), 'Paste some text first.', true); return; }
  try {
    await postJson('/api/kb', { repo: $('kbRepo').value.trim() || 'global', source: $('kbSource').value, title: $('kbTitle').value.trim(), text });
    $('kbText').value = ''; $('kbTitle').value = '';
    setStatus($('kbStatus'), 'KB entry saved.');
    refreshKb();
  } catch (e) { setStatus($('kbStatus'), 'Failed: ' + e.message, true); }
});
$('refreshKb').addEventListener('click', refreshKb);
refreshKb();
