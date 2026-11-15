# AxoReview — Free Agentic Code Review (portable skill)

> **Agent-first.** No website, no login, no app to install. Drop this file
> into any agent (Claude Code, Cursor, Windsurf, Codex, Gemini CLI, Copilot,
> or any MCP client) and it reviews code the way CodeRabbit does — line by
> line, with software-engineering judgement — for $0, using the user's own
> model. See `README.md` in this pack for install instructions (one command
> per agent) and the one-line prompt.
>
> Full skill (1,390 lines, all prompts, all worked examples):
> `~/workspace/custom-skills/axoreview/SKILL.md` — this file is the portable
> condensed version of it. The engine it describes lives in
> `~/workspace/axoreview/` (zero-dependency Node, `lib/`, `bin/`, `mcp-server.js`).

## 1. What AxoReview is

An agentic code reviewer. Give it a pull request, a diff, or a single file
and it returns what a senior reviewer would: a summary a human reads in 30
seconds, a walkthrough, **one verdict per changed line** (ok / nitpick /
minor / major / critical) with the exact evidence line and a fix, a risk /
effort verdict, quality gates, and an SE score. It traces what a change
actually touches — not just the lines in the diff — so a changed return type
breaking a downstream caller three files away is caught, not skimmed past.

CodeRabbit (coderabbit.ai) is the paid reference: $24–72/user/mo, 5–12
reviews/dev/hour, file caps, Enterprise-only API/self-host. AxoReview
refuses that paywall: **every feature is unlocked for everyone, always.**

## 2. Free-by-design (non-negotiable)

- No paywall, no tiers, no seat billing, no hourly allowance, no per-file
  overage, no file cap. No "Enterprise only" features.
- **BYOM — bring your own model. Axofy pays $0 for every model.** The user
  runs reviews on their own model: NVIDIA NIM free, Groq free, OpenRouter
  `:free`, Gemini AI Studio free, local Ollama (`http://localhost:11434`)
  or LM Studio (`http://localhost:1234`) — no key, no cloud, no bill — or
  any OpenAI-compatible endpoint they supply. Per-request
  `byom: {provider, model, baseUrl, apiKey}` is used for that request only:
  never stored, never logged, never in a cache key. **No key = deterministic
  mode** (checks + deep analysis + SE), honestly labelled `llmMode: mock`.
  Never fake an LLM verdict.
- Every review names its provider + model + `axofyCostUsd: 0` and `llmMode`.
- Efficiency stretches a free key: 7-day response cache (diff+config+
  profile+provider), per-file LLM cache, 30s push debounce, incremental-only
  review (already-reviewed lines are never re-reviewed), cheap-model
  compression before the review pass, judge pass that kills noise.
- Never train on customer code. Code is held in memory during a review and
  deleted after, except the encrypted 7-day review cache.

## 3. Line-by-line Rabbit check mode (the default for agents)

**Default mode is line-by-line, not summary-only.** Every changed line gets
its own verdict:

| Verdict | Meaning |
|---|---|
| `ok` | Passed every deterministic check + SE heuristic. |
| `nitpick` | Style / readability — fix if trivial, never blocks. |
| `minor` | Real issue, low risk — fix before merge if cheap. |
| `major` | Wrong / risky — fix before merge. |
| `critical` | Security or data-loss risk — blocks the merge (gate). |

A verdict carries: `file`, `line`, `position`, `code` (the exact added
line), `findings[]` (source, severity, category, title, explanation,
suggestedFix, evidence, repro), `seNotes[]`, `suggestion`, `seReason`.

Sources of a verdict, in order:
1. **Deterministic checks** (`lib/checks.js`, 20 languages): secrets,
   SQL/command injection, eval/exec, unsafe deserialisation, hardcoded
   credentials, error swallowing, TODO, debug prints, off-by-one, long
   function/file. Each fires on the exact added line with evidence.
2. **Deep analysis** (`lib/deep-analysis.js`, standard+deep, no LLM):
   taint (untrusted source → sink), breaking changes (removed export,
   changed signature), DB migration safety (DROP, DELETE without WHERE,
   non-concurrent index), dependency risk (`latest`/`*`), performance
   (N+1 query-in-loop, unbounded query, sync-in-loop), a11y, i18n,
   docs drift + test gaps (deep only), blast radius for all changed
   functions, architecture impact (deep).
3. **LLM passes** (only with a BYOM key/local model): Pass A per-file,
   Pass B summary/walkthrough, Pass C judge (drops ungrounded findings).
   Deterministic findings are never overruled by the judge.
4. **SE heuristics** (`lib/line-by-line.js`): attached to the verdict as
   `seNotes`, never invented as findings — gates never fail on a heuristic.

## 4. SE mode (software engineering, on by default)

Every line verdict is also checked against software-engineering rules
(`reviews.se: true` in `.axoreview.yaml`, `--se` / `--no-se` on the CLI,
`se` on the API/MCP). Lenses, in order:

1. **Security (OWASP Top 10):** injection, broken auth, secrets, XSS, SSRF,
   insecure deserialisation, vulnerable dependencies, logging failures.
2. **Correctness:** off-by-one, null/undefined, races, swallowed errors,
   edge cases, loose equality (`==` in JS/TS).
3. **Cross-file / architecture:** trace every changed function to its
   callers; a changed return type, signature, or shared module is systemic.
4. **Data-flow / taint:** untrusted input to a sink (DB, shell, eval,
   HTML) must be validated first.
5. **Performance:** N+1 queries, unbounded queries, sync-in-loop, serial
   `await` in a loop, hot loops, missing pagination.
6. **Maintainability — SOLID, DRY, KISS, YAGNI:** single responsibility,
   no duplication, simplest solution, no speculative generality, clear
   naming, low complexity. Heuristics: >120-char lines, deep nesting
   (indent 12+), magic numbers, 5+ function parameters, duplicated lines,
   `var` in JS/TS.
7. **Testability — TDD:** is it testable, are edge cases covered, are tests
   added? A changed function with no test is a coverage gap.
8. **API / backward compat:** removed/renamed exports, changed response
   shapes, changed defaults — breaking unless a shim exists.
9. **DB / migration safety:** destructive migrations, missing indexes,
   index builds that lock, rollback plan.
10. **Dependencies, a11y, i18n, docs drift.**

**SE summary** (`se` in every review): `score` 0–100 (100 − 12×critical −
6×major − 2×minor − 1×nitpick − 1×SE note, clamped), `grade` A (≥90) /
B (≥75) / C (≥60) / D, `counts` per verdict, `smells[]` (aggregated, with
counts), `complexity` (added lines, long lines, avg line length, changed
functions), and a one-paragraph `summary` that says ship-it or needs-changes.

## 5. How to run a review (four ways, no website)

### (a) As a skill — paste the diff, follow this file
Read the diff line by line (§3–§4), run the 3 passes below in your head
(or with your own model), and output §6. No code needed.

### (b) CLI — one command, works with no server
```bash
node bin/axoreview.js review --file path/to.diff --line-by-line --se
node bin/axoreview.js review --base main --line-by-line --se   # git diff vs main
```
If a server runs at `$AXOREVIEW_URL` (default `http://localhost:3000`)
it is used; otherwise the CLI runs the same engine **locally**
(deterministic + SE, $0, no key). Output: summary, then one verdict per
changed line, then the SE summary. `--no-se` disables SE notes,
`--depth quick|standard|deep`, `--profile quiet|chill|assertive`.

### (c) MCP server — any MCP client
```bash
node mcp-server.js   # stdio JSON-RPC, zero dependencies
```
Tools: `review_diff`, `line_by_line`, `review_file`, `review_pr`,
`explain`, `autofix`, `gates`, `providers`. Configs for Claude Desktop /
Cursor / VS Code are in this pack (`mcp-*.json`). Pass `byom` per call
for your own model; no key = deterministic mode.

### (d) HTTP API on localhost
```bash
node server.js   # http://localhost:3000 (zero dependencies)
POST /api/review-line-by-line  {diff} | {file, path}   # line-by-line + SE
POST /api/review-diff           {diff}                  # full review
POST /api/autofix/bulk          {diff, findings?}       # one patch, cap 200 files
POST /api/gates                 {findings}              # pass/fail + reasons
GET  /api/providers                                     # BYOM table, Axofy $0
```

## 6. The 3 passes (use these prompts verbatim when reviewing by hand)

**Pass A — per file.** System: "You are a senior code reviewer. Review
ONLY the added/changed lines in the diff, using the file context and repo
instructions provided. Do not comment on formatting covered by linters. Do
not hallucinate APIs or behaviour you cannot see — cite the file and line
you checked. Output ONLY a JSON object, no prose:
`{"findings": [{"file": "...", "line": 12, "severity":
"critical|major|minor|nitpick", "category":
"bug|security|performance|style|logic", "title": "...", "explanation":
"...", "suggestedFix": "code or short fix description", "confidence":
0.9}]}`" — plus the §4 lenses in order. One finding per issue, anchored
to the exact added line.

**Pass B — summary.** System: "You are a senior reviewer summarising a
pull request. Given the diff, the per-file findings, and cross-file caller
information, write a plain-language summary, a per-file walkthrough, an
effort estimate 1-5, a risk rating (low|moderate|high), and suggested
labels and reviewers. Also list any cross-file breakage the per-file
review missed. Output ONLY a JSON object." In deep mode also produce
architecture impact (3–5 bullets, only from the diff), blast radius, and
docs-drift / test-coverage gaps.

**Pass C — judge.** System: "You are a strict review judge. For each
finding, decide if it is grounded in the diff/context, correct, and worth
interrupting the author. DROP a finding if it is speculative, already
handled elsewhere in the diff, a duplicate, or a nitpick below the
configured profile. KEEP it only with evidence." Output
`{"kept": [0, 2], "dropped": [{"index": 1, "reason": "..."}]}`. The judge
never overrules deterministic check findings.

## 7. Output format (what the user sees)

```
Axofy Code Review — <title>
<one-paragraph summary>
Effort 2/5 · Risk high · LLM mode: mock|direct · Provider: <name>/<model> (Axofy cost $0)

Line-by-line (27 changed lines) — SE score 31/100 (grade D)
  [ok      ] src/users.js:14  // comment
  [CRITICAL] src/users.js:15  const query = "SELECT ..." + userId + ...
           ↳ critical: Possible SQL injection — query built by string concatenation
           Fix: Use a parameterised query / prepared statement.
  [MAJOR   ] src/users.js:23  for (let i = 0; i <= scores.length; i++) {
           ↳ major: Possible off-by-one — loop uses <= with .length
           Fix: Use `i < arr.length`.

SE smells: <smell> ×n · ...
<SE summary paragraph>
```

Plus, in the JSON result: `summary`, `walkthrough`, Mermaid `diagram`,
`effort`, `risk`, `labels`, `reviewers`, `qualityGates` (pass/reasons/
checks), `slop`, `findings`, `groupedFindings`, `droppedByJudge`,
`learningsApplied`, `suppressedByFeedback`, `provider`, `llmMode`,
`cacheHit`, `durationMs`. Every finding carries `repro` {inputs,
executionPath, expected, actual} — Steps of Reproduction.

## 8. Config — `.axoreview.yaml` (same sections as `.coderabbit.yaml`)

```yaml
reviews:
  profile: chill            # quiet | chill | assertive
  depth: standard           # quick | standard | deep
  se: true                  # SE mode on every line verdict (default true)
  path_filters: ["**/*.js", "!**/node_modules/**"]
  path_instructions:
    - glob: "src/auth/**"
      text: "Pay extra attention to authentication here."
  quality_gates:            # block merge on critical/secrets
    block_on_critical: true
    block_on_secrets: true
    require_tests: false
  custom_rules:             # plain-English rules, matched deterministically
    - "Never use console.log in production code — use the logger instead."
```

## 9. Hard rules

1. **Line-by-line is the default.** Never return a summary-only review
   to an agent — every changed line gets a verdict, even if it is `ok`.
2. **Cite file:line + the exact evidence line for every finding.**
   Never claim an API or behaviour you cannot see in the diff/context.
   If unsure, say so with low confidence — do not guess.
3. **Never fake a result.** No key = mock/deterministic mode, labelled
   as such. No benchmark of your own, no fake stats, no fake customers.
4. **Judge drops ungrounded findings, never deterministic ones.**
5. **SE notes are heuristics, not findings.** Gates never fail on one.
6. **Keys:** per-request only, never stored, never logged, never in a
   cache key, never in chat. Name the model used in every review.
7. **Autofix is safe-only:** off-by-one `<=` → `<`, remove debug lines,
   single-line LLM fixes. Secrets, SQLi, eval, multi-line fixes are
   manual-only. Bulk autofix caps at 200 files; the rest are listed as
   manual, never silently skipped.
8. **A human still merges.** This is a first-pass reviewer, not a
   substitute for tests, CI, or a security audit.
9. **Do not copy CodeRabbit's logo, headline, or copy verbatim.**
   Same method/format, our own words, "not affiliated with CodeRabbit".

## 10. Worked example (short)

Diff adds: `const query = "SELECT * FROM users WHERE id = " + userId;`
- Verdict on that line: **critical** — SQL injection (deterministic
  check) + taint (untrusted `req.query.id` in the same file reaches the
  SQL sink). Evidence: the exact line. Fix: parameterised query.
  Repro: input `1 OR 1=1` → concatenated into SQL → injected SQL runs;
  expected: placeholders, input is data, never SQL. SE note: none — the
  security finding already covers it. Gate: fails (`no critical findings`).

## 11. What is NOT built (say so plainly)

IDE extension, Engineer cloud agent, SSO/RBAC/audit, Postgres/pgvector
learnings, external linter wiring (ESLint/Ruff/Semgrep), GitLab/Bitbucket/
Azure diff-fetch + posting (adapter-ready only), GitHub App auto-review
(needs the repo owner in GitHub UI). The skill + CLI + MCP + local HTTP
API above are the complete agent-first product — no website needed.
