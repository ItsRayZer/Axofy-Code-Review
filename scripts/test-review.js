// scripts/test-review.js — Axofy Code Review test suite (no test framework, zero deps).
// Default: mock LLM mode (AXOREVIEW_LLM=mock) — asserts the deterministic
// pipeline: checks find the planted bugs, autofix patches them, incremental
// review marks them already-reviewed, and the cache hits on repeat.
// Real LLM: AXOREVIEW_LLM=real npm run test:real — uses the vault helper or
// NVIDIA_API_KEY; asserts llmMode is not mock and the review still contains
// the planted bugs. Never fakes a live LLM result.
// Exit 0 = all pass, 1 = failure (prints each check).
'use strict';

const fs = require('fs');
const path = require('path');

const REAL = process.env.AXOREVIEW_LLM === 'real';
if (!REAL) process.env.AXOREVIEW_LLM = 'mock';
// Hermetic cache for tests (a running server shares data/cache.json).
process.env.AXOREVIEW_CACHE_FILE = require('path').join(__dirname, '..', 'data', 'cache.test.json');
process.env.AXOREVIEW_FEEDBACK_FILE = require('path').join(__dirname, '..', 'data', 'feedback.test.json');
try { fs.rmSync(process.env.AXOREVIEW_FEEDBACK_FILE, { force: true }); } catch { /* ignore */ }

const { reviewDiff } = require('../lib/pipeline');
const { buildAutofixPatch } = require('../lib/autofix');
const { parseDiff } = require('../lib/diff');
const { verifySignature } = require('../lib/webhook');
const { loadConfig } = require('../lib/config');

// Hermetic cache: clear the test review cache so this run is deterministic.
try { fs.rmSync(process.env.AXOREVIEW_CACHE_FILE, { force: true }); } catch { /* ignore */ }

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log('  PASS ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

async function main() {
  console.log(`Axofy Code Review tests (${REAL ? 'REAL LLM' : 'mock LLM'} mode)`);
  const diff = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-pr.diff'), 'utf8');
  const files = parseDiff(diff);
  check('fixture parses to 2 files', files.length === 2, 'got ' + files.length);

  const review = await reviewDiff(diff, { repo: 'test/sample', prTitle: 'Add user lookup', prBody: 'Fixes #42' });
  check('summary exists', Boolean(review.summary && review.summary.text));
  check('effort is 1-5', review.effort >= 1 && review.effort <= 5, 'effort=' + review.effort);
  check('walkthrough covers both files', review.walkthrough.length === 2, 'got ' + review.walkthrough.length);
  check('linked issue #42 detected', review.linkedIssues.includes(42), JSON.stringify(review.linkedIssues));
  check('diagram generated (mermaid)', typeof review.diagram === 'string' && review.diagram.startsWith('sequenceDiagram'), '');
  check('planner produced a task graph', Boolean(review.plan && review.plan.tasks && review.plan.tasks.length >= 2), 'tasks=' + (review.plan?.tasks?.length || 0));
  check('code graph present in result', review.codeGraph === null || typeof review.codeGraph === 'object', '');
  check('slop verdict present', Boolean(review.slop && review.slop.verdict), '');
  check('llmMode disclosed', typeof review.llmMode === 'string', 'mode=' + review.llmMode);
  if (REAL) check('real mode: llmMode is not mock', review.llmMode !== 'mock', 'mode=' + review.llmMode);
  else check('mock mode: llmMode is mock', review.llmMode === 'mock', 'mode=' + review.llmMode);

  const all = [...review.findings, ...review.groupedFindings];
  const has = (src) => all.some((f) => f.source === src);
  check('planted bug 1 found: SQL injection', has('check:sql-injection'));
  check('planted bug 2 found: off-by-one', has('check:off-by-one-length'));
  check('planted bug 3 found: insecure eval', has('check:insecure-eval'));
  check('console.log flagged', has('check:console-log'));
  const sqli = all.find((f) => f.source === 'check:sql-injection');
  check('SQL injection finding cites file:line + evidence', Boolean(sqli && sqli.file === 'src/users.js' && sqli.line && sqli.evidence && sqli.evidence.includes('SELECT')), JSON.stringify(sqli || null).slice(0, 200));
  check('every finding has severity + category', all.every((f) => f.severity && f.category));

  // Autofix: off-by-one and console.log are auto-fixed; SQLi/eval are manual.
  const fix = buildAutofixPatch(diff, all);
  check('autofix patch is non-empty', fix.patch.length > 50);
  check('autofix fixes off-by-one (<= -> <)', fix.patch.includes('i < scores.length') && fix.applied.some((a) => a.title.includes('off-by-one')));
  check('autofix removes console.log', fix.applied.some((a) => a.title.includes('console.log')));
  check('autofix leaves SQL injection as manual', fix.manual.some((m) => m.title.includes('SQL injection')));
  check('autofix leaves eval as manual', fix.manual.some((m) => m.title.includes('eval')));

  // Incremental: reviewing the same diff again marks everything already-reviewed.
  const inc = await reviewDiff(diff, { repo: 'test/sample', previousDiff: diff });
  check('incremental review marks findings already-reviewed', inc.incremental && inc.incremental.skippedAlreadyReviewed > 0, JSON.stringify(inc.incremental));
  check('incremental inline list is empty', inc.findings.length === 0, 'inline=' + inc.findings.length);

  // Cache: a repeat review of the same diff hits the cache.
  const cached = await reviewDiff(diff, { repo: 'test/sample', prTitle: 'Add user lookup', prBody: 'Fixes #42' });
  check('repeat review hits cache', cached.cacheHit === true, 'cacheHit=' + cached.cacheHit);

  // Webhook HMAC round-trip.
  const crypto = require('crypto');
  const secret = 'test-secret';
  const body = Buffer.from(JSON.stringify({ action: 'opened' }));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  check('webhook HMAC verifies', verifySignature(secret, body, sig).ok);
  check('webhook HMAC rejects bad signature', !verifySignature(secret, body, 'sha256=deadbeef').ok);

  // Config parsing (incl. CodeRabbit-style general/chat sections).
  const cfg = loadConfig('profile: quiet\nreviews:\n  token_budget_chars: 5000\n');
  check('config parses profile + token budget', cfg.profile === 'quiet' && cfg.maxContextChars === 5000, JSON.stringify(cfg.profile) + '/' + cfg.maxContextChars);
  const cfg2 = loadConfig('general:\n  language: en-US\n  tone: concise\nchat:\n  auto_reply: false\nreviews:\n  profile: assertive\n  summary: false\n');
  check('config parses general/chat/reviews sections', cfg2.language === 'en-US' && cfg2.tone === 'concise' && cfg2.chatAutoReply === false && cfg2.profile === 'assertive' && cfg2.summaryEnabled === false, JSON.stringify(cfg2));

  // Queue: dedupe by repo/PR/head SHA, cancel superseded.
  const { ReviewQueue } = require('../lib/queue');
  const q = new ReviewQueue({ debounceMs: 60000 });
  const r1 = q.enqueue({ repo: 'o/r', prNumber: 1, headSha: 'aaa' }, async () => {});
  const r2 = q.enqueue({ repo: 'o/r', prNumber: 1, headSha: 'aaa' }, async () => {});
  check('queue dedupes same repo/PR/head', r1.status === 'queued' && r2.status === 'duplicate', r1.status + '/' + r2.status);
  const r3 = q.enqueue({ repo: 'o/r', prNumber: 1, headSha: 'bbb' }, async () => {});
  check('queue supersedes older head', r3.status === 'queued' && r3.superseded === 1, JSON.stringify(r3));

  // --- Language-aware checks: one fixture per major language group ---
  const { detectLanguage, LANGUAGES } = require('../lib/checks');
  check('detectLanguage: Go / Python / Java / PHP / SQL / Rust', detectLanguage('a.go') === 'go' && detectLanguage('a.py') === 'python' && detectLanguage('A.java') === 'java' && detectLanguage('a.php') === 'php' && detectLanguage('m.sql') === 'sql' && detectLanguage('a.rs') === 'rust', '');
  check('LANGUAGES table covers 20 languages', Object.keys(LANGUAGES).length >= 20, 'got ' + Object.keys(LANGUAGES).length);
  async function langFixture(name, src) {
    const d = fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
    const r = await reviewDiff(d, { repo: 'test/lang', depth: 'standard' });
    const allL = [...r.findings, ...r.groupedFindings];
    return { review: r, all: allL, has: (s) => allL.some((f) => f.source === s) };
  }
  const go = await langFixture('sample-go.diff');
  check('Go fixture: Sprintf SQL injection found', go.has('check:sql-format-injection'));
  check('Go fixture: exec sh -c found', go.has('check:insecure-exec-go'));
  check('Go fixture: fmt.Println debug found', go.has('check:print-debug-go'));
  const py = await langFixture('sample-python.diff');
  check('Python fixture: f-string SQL injection found', py.has('check:sql-fstring-injection'));
  check('Python fixture: pickle.loads found', py.has('check:unsafe-pickle'));
  check('Python fixture: bare except: pass found', py.has('check:empty-except'));
  const java = await langFixture('sample-java.diff');
  check('Java fixture: SQL concatenation found', java.has('check:sql-injection'));
  check('Java fixture: Runtime.exec found', java.has('check:insecure-exec-java'));
  const php = await langFixture('sample-php.diff');
  check('PHP fixture: SQL concat with $_GET found', php.has('check:sql-php-concat'));
  check('PHP fixture: eval found', php.has('check:insecure-eval'));
  const sql = await langFixture('sample-sql.diff');
  check('SQL fixture: DELETE without WHERE found', sql.has('check:sql-delete-no-where'));
  check('SQL fixture: DROP TABLE found', sql.has('check:sql-drop-table'));
  const rust = await langFixture('sample-rust.diff');
  check('Rust fixture: unsafe block found', rust.has('check:unsafe-rust'));
  check('Rust fixture: unwrap() found', rust.has('check:unwrap-result'));

  // --- Deep analysis (deterministic, mock mode) ---
  const { analyseDeep, blastRadiusFor, architectureImpact } = require('../lib/deep-analysis');
  const deepFiles = parseDiff(diff);
  const deep = analyseDeep(deepFiles, { depth: 'deep' });
  check('deep analysis runs in deep mode', deep.depth === 'deep' && Array.isArray(deep.findings), '');
  const goDeep = await reviewDiff(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-go.diff'), 'utf8'), { repo: 'test/lang', depth: 'deep' });
  check('deep analysis: test-gap flagged (no test change for changed fns in Go fixture)', [...goDeep.findings, ...goDeep.groupedFindings].some((f) => f.source === 'deep:test-gap'), '');
  const quick = analyseDeep(deepFiles, { depth: 'quick' });
  check('quick depth skips deep analysis', quick.findings.length === 0, 'got ' + quick.findings.length);
  const br = blastRadiusFor(deepFiles, null);
  check('blast radius lists changed functions', br.changedFunctions.some((c) => c.name === 'sumScores'), JSON.stringify(br.changedFunctions.map((c) => c.name)));
  const arch = architectureImpact(deepFiles);
  check('architecture impact lists modules + bullets', arch.bullets.length >= 2 && arch.changedFunctionCount >= 1, JSON.stringify(arch.bullets));
  // Taint: source (req.query) + sink (SQL concat) in the same file.
  const taint = deep.findings.filter((f) => f.source === 'deep:taint');
  check('deep analysis: taint flow found in sample PR', taint.length >= 1, 'got ' + taint.length);
  // Breaking change: removed export.
  const breakDiff = 'diff --git a/src/api.js b/src/api.js\n--- a/src/api.js\n+++ b/src/api.js\n@@ -1,3 +1,2 @@\n-export function getUser(id) { return db.get(id); }\n export function listUsers() { return []; }\n';
  const breakReview = await reviewDiff(breakDiff, { repo: 'test/break', depth: 'standard' });
  check('deep analysis: removed export flagged as breaking change', [...breakReview.findings, ...breakReview.groupedFindings].some((f) => f.source === 'deep:breaking-change'), '');

  // --- Review depth (config + pipeline) ---
  const cfgD = loadConfig('reviews:\n  depth: deep\n');
  check('config parses reviews.depth', cfgD.depth === 'deep', 'got ' + cfgD.depth);
  const deepReview = await reviewDiff(diff, { repo: 'test/sample', depth: 'deep' });
  check('pipeline returns depth + deepAnalysis', deepReview.depth === 'deep' && deepReview.deepAnalysis && deepReview.deepAnalysis.depth === 'deep', JSON.stringify(deepReview.depth));
  check('deep review includes architecture impact', Boolean(deepReview.deepAnalysis.architectureImpact && deepReview.deepAnalysis.architectureImpact.bullets.length), '');
  const quickReview = await reviewDiff(diff, { repo: 'test/sample', depth: 'quick' });
  check('quick review skips deep analysis', quickReview.depth === 'quick' && quickReview.deepAnalysis.findings.length === 0, 'got ' + quickReview.deepAnalysis.findings.length);

  // --- Host adapters (honest status) ---
  const { hostStatus, normalizeEvent, notConfigured } = require('../lib/hosts');
  const hosts = hostStatus();
  check('hosts: GitHub live, others adapter-ready', hosts.find((h) => h.id === 'github').status === 'live' && hosts.filter((h) => h.id !== 'github').every((h) => h.status === 'adapter-ready'), JSON.stringify(hosts.map((h) => h.id + ':' + h.status)));
  const gl = normalizeEvent('gitlab', { 'x-gitlab-event': 'Merge Request Hook' }, { object_kind: 'merge_request', project: { path_with_namespace: 'o/r' }, object_attributes: { iid: 7, action: 'open', title: 'T', description: 'D', url: 'u', last_commit: { id: 'abc' } } });
  check('hosts: GitLab MR webhook normalises to common event', gl && gl.host === 'gitlab' && gl.prNumber === 7 && gl.repo === 'o/r', JSON.stringify(gl));
  const bb = normalizeEvent('bitbucket', { 'x-event-key': 'pullrequest:created' }, { repository: { full_name: 'o/r' }, pullrequest: { id: 3, title: 'T', source: { commit: { hash: 'def' } } } });
  check('hosts: Bitbucket PR webhook normalises', bb && bb.host === 'bitbucket' && bb.prNumber === 3, JSON.stringify(bb));
  const az = normalizeEvent('azure', {}, { eventType: 'git.pullrequest.created', resource: { repository: { name: 'r' }, pullRequestId: 9, title: 'T', lastMergeSourceCommit: { commitId: 'ghi' } } });
  check('hosts: Azure PR webhook normalises', az && az.host === 'azure' && az.prNumber === 9, JSON.stringify(az));
  check('hosts: not-configured is honest, never faked', notConfigured('gitlab').status === 'not-configured' && notConfigured('gitlab').note.includes('adapter-ready'), '');

  // --- BYOM: bring your own model, $0 to Axofy ---
  const { listProviders, resolveProvider, providerDescriptor, testProvider } = require('../lib/llm');
  const providers = listProviders();
  check('BYOM: 7 providers listed', providers.length === 7, 'got ' + providers.length);
  check('BYOM: Axofy pays $0 for every provider', providers.every((x) => x.axofyCostUsd === 0), '');
  check('BYOM: Ollama is local, no key needed', providers.some((x) => x.id === 'ollama' && x.local === true && x.keyNeeded === false), '');
  check('BYOM: provider list contains no API key value', !JSON.stringify(providers).includes('apiKey') && !providers.some((x) => 'apiKey' in x), '');
  const oll = resolveProvider({ provider: 'ollama' });
  check('BYOM: Ollama resolves with no key', oll.name === 'ollama' && oll.key === null && oll.local === true, JSON.stringify({ name: oll.name, key: oll.key }));
  const cust = resolveProvider({ provider: 'custom', model: 'my-model', baseUrl: 'https://example.test/v1', apiKey: 'sk-test-123' });
  check('BYOM: custom endpoint takes user baseUrl/model/key', cust.name === 'custom' && cust.model === 'my-model' && cust.baseUrl === 'https://example.test/v1' && cust.key === 'sk-test-123', '');
  check('BYOM: provider descriptor never carries the key', !('key' in providerDescriptor({ provider: 'custom', apiKey: 'sk-test-123' })) && !JSON.stringify(providerDescriptor({ provider: 'custom', apiKey: 'sk-test-123' })).includes('sk-test-123'), '');
  const noKey = await testProvider({ provider: 'nvidia' });
  check('BYOM: testProvider fails fast with no key (no network)', noKey.ok === false && /key/i.test(noKey.reason || ''), JSON.stringify(noKey));
  check('review result names provider + Axofy cost $0', review.provider && review.provider.name === 'nvidia' && review.provider.axofyCostUsd === 0, JSON.stringify(review.provider));

  // --- Quality gates ---
  const { evaluateGates } = require('../lib/gates');
  check('gates: pass with no findings', evaluateGates([], { blockOnCritical: true }).pass === true, '');
  check('gates: fail on critical finding', evaluateGates([{ severity: 'critical', file: 'a.js', line: 1, title: 'x', source: 'check:x' }], { blockOnCritical: true }).pass === false, '');
  check('gates: fail on hardcoded secret', evaluateGates([{ severity: 'major', file: 'a.js', line: 1, title: 'Possible hardcoded secret', source: 'check:secret-assignment' }], {}).pass === false, '');
  check('gates: require_tests fails on test-gap', evaluateGates([{ severity: 'minor', file: 'a.js', line: 1, title: 'Test coverage gap', source: 'deep:test-gap' }], { requireTests: true }).pass === false, '');
  check('gates: sample PR fails its gates (critical findings)', review.qualityGates && review.qualityGates.pass === false, JSON.stringify(review.qualityGates));
  const cfgG = loadConfig('reviews:\n  quality_gates:\n    block_on_critical: true\n    require_tests: true\n  custom_rules:\n    - "Never use console.log in production code"\n');
  check('config parses quality_gates + custom_rules', cfgG.qualityGates.requireTests === true && cfgG.customRules.length === 1, JSON.stringify(cfgG.qualityGates) + '/' + JSON.stringify(cfgG.customRules));

  // --- Bulk autofix (cap 200 files) ---
  const { buildBulkAutofix } = require('../lib/autofix');
  const bulk = buildBulkAutofix(diff, all);
  check('bulk autofix applies safe fixes in one patch', bulk.applied.length >= 1 && bulk.patch.length > 50, 'applied=' + bulk.applied.length);
  check('bulk autofix keeps SQL injection manual', bulk.manual.some((m) => m.title.includes('SQL injection')), '');
  const manyFindings = Array.from({ length: 250 }, (_, i) => ({ file: 'f' + i + '.js', line: 1, title: 'x' + i, source: 'check:console-log', evidence: 'console.log(1)' }));
  const capped = buildBulkAutofix('', manyFindings);
  check('bulk autofix caps at 200 files and lists the rest as manual', capped.capped === true && capped.totalFiles === 250 && capped.filesFixed === 200 && capped.manual.some((m) => /capped at 200/.test(m.reason)), JSON.stringify({ capped: capped.capped, total: capped.totalFiles, fixed: capped.filesFixed }));

  // --- Plain-English custom rules ---
  const { matchCustomRules } = require('../lib/custom-rules');
  const cr = matchCustomRules(files, all, ['Never use console.log in production code', 'Never deploy on a Friday']);
  check('custom rule matches console.log finding', cr.findings.some((f) => f.source === 'custom-rule' && /console\.log/.test(f.title)), JSON.stringify(cr.findings.map((f) => f.title)));
  check('custom rule with no match is reported unmatched', cr.unmatched.includes('Never deploy on a Friday'), JSON.stringify(cr.unmatched));
  const crReview = await reviewDiff(diff, { repo: 'test/sample', useCache: false, configYaml: 'reviews:\n  custom_rules:\n    - "Never use console.log in production code"\n' });
  check('custom rule via configYaml produces a finding', [...crReview.findings, ...crReview.groupedFindings].some((f) => f.source === 'custom-rule'), JSON.stringify(crReview.customRules));

  // --- Steps of Reproduction ---
  check('every finding carries a repro (inputs/path/expected/actual)', all.every((f) => f.repro && f.repro.inputs && f.repro.executionPath && f.repro.expected && f.repro.actual), '');
  const sqliRepro = sqli && sqli.repro;
  check('SQLi repro gives attacker input + expected parameterised query', Boolean(sqliRepro && /OR 1=1/.test(sqliRepro.inputs) && /parameterised/.test(sqliRepro.expected)), JSON.stringify(sqliRepro || null).slice(0, 200));

  // --- Real-time learnings: rejected feedback suppresses similar findings ---
  const { recordFeedback, isSuppressed } = require('../lib/learnings');
  const fb = recordFeedback({ title: sqli.title, file: sqli.file, line: sqli.line, source: sqli.source, accepted: false, repo: 'test/sample' });
  check('learnings feedback stores a rejection', Boolean(fb && fb.accepted === false), '');
  check('rejected finding is suppressed by feedback', isSuppressed(sqli) === true, '');
  check('accepted feedback does not suppress', (() => { recordFeedback({ title: 'Some other finding', file: 'x.js', source: 'check:other', accepted: true, repo: 'test/sample' }); return isSuppressed({ title: 'Some other finding', file: 'x.js', source: 'check:other' }) === false; })(), '');
  const suppressedReview = await reviewDiff(diff, { repo: 'test/sample', useCache: false });
  check('pipeline suppresses the rejected finding and reports it', ![...suppressedReview.findings, ...suppressedReview.groupedFindings].some((f) => f.source === 'check:sql-injection') && suppressedReview.suppressedByFeedback.length >= 1, JSON.stringify(suppressedReview.suppressedByFeedback));

  // --- Async review jobs (POST /api/review-jobs -> poll) ---
  const { JobStore } = require('../lib/jobs');
  const store = new JobStore();
  const job = store.create(() => reviewDiff(diff, { repo: 'test/sample', useCache: false }));
  check('job starts queued/running with an id', Boolean(job.id) && ['queued', 'running'].includes(job.status), job.status);
  await new Promise((r) => setTimeout(r, 3000));
  const finished = store.get(job.id);
  check('job finishes done with the full review result', finished.status === 'done' && finished.result && Array.isArray(finished.result.findings), finished.status);
  check('job public view hides the result until done', store.publicView({ id: 'x', status: 'running', createdAt: '', result: { findings: [] }, error: null }).result === null, '');
  check('unknown job id returns null', store.get('no-such-job') === null, '');

  // --- Read-only filesystem stores (Vercel fix) ---
  const { writableDataDir, atomicWriteJson } = require('../lib/store');
  const { writeFileSync } = require('fs');
  check('writableDataDir returns an existing writable directory', (() => { try { writeFileSync(path.join(writableDataDir(), '.probe'), 'x'); return true; } catch { return false; } })(), writableDataDir());
  check('atomicWriteJson writes valid JSON and returns true', atomicWriteJson(path.join(writableDataDir(), 'probe.json'), { ok: true }) === true, '');
  // Unwritable path: a regular FILE as the parent dir fails fast (ENOTDIR).
  // (Never use /proc here: Node's recursive mkdir can spin on pseudo-filesystems.)
  require('fs').writeFileSync('/tmp/axoreview-store-probe', 'x');
  check('atomicWriteJson never throws on an unwritable path', atomicWriteJson('/tmp/axoreview-store-probe/x.json', { ok: true }) === false, '');

  // --- Line-by-line Rabbit check mode + SE mode (agent-first default) ---
  const { reviewLineByLine, buildLineVerdicts, analyseSE, diffFromFile } = require('../lib/line-by-line');
  const { addedLines } = require('../lib/diff');
  const addedCount = addedLines(parseDiff(diff)).length;
  const llb = await reviewLineByLine(diff, { repo: 'test/llb', useCache: false });
  check('line-by-line: every changed line gets a verdict', Array.isArray(llb.lineByLine) && llb.lineByLine.length === addedCount, 'verdicts=' + (llb.lineByLine || []).length + ' added=' + addedCount);
  check('line-by-line: every verdict has file:line + code + severity', llb.lineByLine.every((v) => v.file && v.line && v.code !== undefined && v.verdict), '');
  const sqliLine = llb.lineByLine.find((v) => v.file === 'src/users.js' && /SELECT \* FROM users/.test(v.code));
  // Note: the earlier learnings test in this suite rejected check:sql-injection
  // via feedback, so the pipeline suppresses that exact finding here — the
  // line is still critical via the deep taint finding on the same sink.
  check('line-by-line: SQLi line verdict is critical', sqliLine && sqliLine.verdict === 'critical' && sqliLine.findings.some((f) => f.source === 'check:sql-injection' || f.source === 'deep:taint'), JSON.stringify(sqliLine || null).slice(0, 200));
  const offLine = llb.lineByLine.find((v) => /i <= scores\.length/.test(v.code));
  check('line-by-line: off-by-one line verdict is major', offLine && offLine.verdict === 'major', JSON.stringify(offLine || null).slice(0, 200));
  check('line-by-line: at least one changed line is ok', llb.lineByLine.some((v) => v.verdict === 'ok'), JSON.stringify(llb.lineByLine.map((v) => v.verdict)));
  check('line-by-line: review mode is line-by-line', llb.mode === 'line-by-line', 'mode=' + llb.mode);
  check('SE: summary has score 0-100 + grade + smells', llb.se && typeof llb.se.score === 'number' && llb.se.score >= 0 && llb.se.score <= 100 && typeof llb.se.grade === 'string' && Array.isArray(llb.se.smells), JSON.stringify(llb.se || null).slice(0, 200));
  check('SE: summary names the score and the fix-first advice', /SE score \d+\/100/.test(llb.se.summary || ''), (llb.se.summary || '').slice(0, 120));
  check('SE: pipeline review also carries lineByLine + se', Array.isArray(review.lineByLine) && review.lineByLine.length === addedCount && review.se && typeof review.se.score === 'number', '');
  // Pure verdict builder on a clean diff: every line ok.
  // buildLineVerdicts maps the findings it is given — run the real checks.
  const { runChecks } = require('../lib/checks');
  const cleanDiff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1,2 @@\n+const x = 1;\n+console.log(x);\n';
  const cleanFindings = runChecks(parseDiff(cleanDiff), loadConfig(''));
  const cleanVerdicts = buildLineVerdicts(parseDiff(cleanDiff), cleanFindings, { seEnabled: true });
  check('line-by-line: clean line is ok, console.log line is nitpick', cleanVerdicts.length === 2 && cleanVerdicts[0].verdict === 'ok' && cleanVerdicts[1].verdict === 'nitpick', JSON.stringify(cleanVerdicts.map((v) => v.verdict)));
  // SE heuristics: long line + too many params + loose equality.
  const seDiff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1,3 @@\n+function f(a, b, c, d, e) { return a; }\n+const longLine = "' + 'x'.repeat(130) + '";\n+if (userId == 0) { return null; }\n';
  const seVerdicts = buildLineVerdicts(parseDiff(seDiff), [], { seEnabled: true });
  check('SE: 5+ params flagged as SOLID/SRP major', seVerdicts[0].seNotes.some((n) => n.id === 'se:too-many-params'), JSON.stringify(seVerdicts[0].seNotes));
  check('SE: >120 char line flagged as long-line', seVerdicts[1].seNotes.some((n) => n.id === 'se:long-line'), JSON.stringify(seVerdicts[1].seNotes));
  check('SE: loose == flagged as correctness major', seVerdicts[2].seNotes.some((n) => n.id === 'se:loose-equality'), JSON.stringify(seVerdicts[2].seNotes));
  const seOff = buildLineVerdicts(parseDiff(seDiff), [], { seEnabled: false });
  check('SE: --no-se / reviews.se false disables SE notes', seOff.every((v) => v.seNotes.length === 0), '');
  const seSummary = analyseSE(parseDiff(seDiff), [], seVerdicts);
  check('SE: analyseSE scores a clean-ish change and lists smells', seSummary.score >= 0 && seSummary.score <= 100 && seSummary.smells.length >= 3, JSON.stringify(seSummary));
  // Config: reviews.se
  const cfgSe = loadConfig('reviews:\n  se: false\n');
  check('config parses reviews.se: false', cfgSe.seEnabled === false, 'seEnabled=' + cfgSe.seEnabled);
  const cfgSe2 = loadConfig('');
  check('config defaults SE on', cfgSe2.seEnabled === true, 'seEnabled=' + cfgSe2.seEnabled);
  const noSeReview = await reviewDiff(diff, { repo: 'test/llb', useCache: false, seEnabled: false });
  check('pipeline honours seEnabled:false (no SE notes, se.enabled false)', noSeReview.se.enabled === false && noSeReview.lineByLine.every((v) => v.seNotes.length === 0), '');
  // diffFromFile: single file -> parseable diff with one added line per line.
  const fileDiff = diffFromFile('src/hello.js', 'const x = 1;\nconst y = 2;\n');
  check('diffFromFile builds a parseable diff', addedLines(parseDiff(fileDiff)).length === 2 && parseDiff(fileDiff)[0].path === 'src/hello.js', JSON.stringify(addedLines(parseDiff(fileDiff))));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('Test crashed:', e); process.exit(1); });
