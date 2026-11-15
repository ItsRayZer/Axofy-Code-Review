# Axofy Code Review (AxoReview)

A free code-review tool, in the style of CodeRabbit. Free. No paid tiers.

It reviews pull requests the way a senior reviewer would — summary, walkthrough, inline comments with fixes you can apply in one click — and it borrows CodeAnt's better ideas too: quality gates, bulk autofix, plain-English custom rules, steps of reproduction, and learnings from your feedback. The method follows CodeRabbit's public docs and an independent teardown of its pipeline. GitHub is fully live; GitLab, Bitbucket and Azure DevOps are adapter-ready (see "Supported hosts").

Planned home: https://codereview.axofy.shop (not live yet).

## Landing page

`/` serves the Axofy Code Review landing page: same section order as the
CodeRabbit homepage (nav, hero, live review demo, products, how it works,
features, comparison, pricing, install/docs, FAQ, footer) with Axofy
purple/violet branding and Marco, our own words, and no copied copy — plus
the review tool itself at `#app`. The demo shows the real fixture review
(`fixtures/sample-pr.diff`: SQL injection at `src/users.js:15`, insecure
`eval` at `:31`, off-by-one at `:23`). No fake stats, no fake testimonials.
"Run this sample live" loads the fixture into the tool and runs a real review.

## What it does

- Auto-reviews every PR (GitHub App + webhook), posts a summary + walkthrough and
  inline comments with one-click fixes, and learns team preferences.
- PR summary injected into the PR description under the `<!-- axoreview-summary -->`
  marker (`@axoreview summary`, mirroring `@coderabbitai summary`).
- Walkthrough: changed-files summary + Mermaid **sequence diagram** + effort 1–5 +
  suggested labels/reviewers + linked-issue assessment.
- Inline comments anchored to exact diff `position`/`line`/`side`, with
  severity/category, effort, a GitHub ````suggestion` block, and a
  **Prompt for Coding Agents** section.
- Check Run named `AxoReview`, pending → completed (gateable in branch protection).
- Result format mirrors CodeRabbit's posted output exactly in structure:
  check-run line, PR-summary block, walkthrough + Mermaid diagram + effort +
  labels/reviewers + linked-issue assessment, findings grouped by severity
  (critical → major → minor → nitpick) with evidence + suggestion block +
  Prompt for Coding Agents, a GitHub-style inline-comments view with Resolve,
  and a method line (pipeline steps, code graph / blast radius, judge-pass
  note, learnings applied).
- `@axoreview` chat with the same commands as `@coderabbitai`: `review`,
  `full review`, `pause`, `resume`, `summary`, `resolve`, `configuration`,
  `help`, `generate docstrings`, `generate sequence diagram`, `approve`.
- Profiles `quiet` / `chill` / `assertive`; review depth `quick` / `standard` /
  `deep` (UI selector, API `depth`, or `reviews.depth` in `.axoreview.yaml`).
  Quick = deterministic checks only; standard adds taint, breaking changes,
  migrations, dependency risk, performance, a11y/i18n and blast radius;
  deep adds architecture impact on every PR, docs drift and test gaps —
  all deterministic, even without a model key.
- Language-aware deterministic checks for 20 languages (see table below);
  the model review is language-agnostic and runs on all of them.
- `.axoreview.yaml` with the same sections as `.coderabbit.yaml` (`general`, `reviews`, `chat`,
  `knowledge_base`, `tools`, `path_filters`, `path_instructions`).
- Slop detection, pre-merge checks (built-in + custom natural-language),
  finishing touches (unit tests, docstrings), Autofix patch, post-merge
  changelog draft, Triage queue, Explain (Change Stack, semantic diff,
  blast radius, architecture impact), Secure / Deep Scan (whole-repo secrets
  + SAST + dependency + IaC), Learnings + knowledge base, CLI
  (`axoreview review --base main`).

## How free works

There is no Axofy model account to pay for: every review runs on a model the user brings. Bring your own API key — a free cloud tier, or a model running on your own machine. Free cloud tiers (NVIDIA Nemotron, Groq, OpenRouter `:free`, Gemini AI Studio) cost the user nothing; local models (Ollama, LM Studio) cost nothing and never leave the user's machine; a custom OpenAI-compatible endpoint costs whatever that endpoint charges the user. Axofy charges nothing either way. A key sent with a request is used for that request only: never stored server-side, never logged, never put in a cache key. With no key at all the server runs in mock/deterministic mode and says `needs-llm` honestly. `GET /api/providers` lists every provider with its cost to Axofy (none) and to the user.

### Providers

Works with NVIDIA, Groq, OpenRouter, Gemini, Ollama, and LM Studio — plus any OpenAI-compatible endpoint you point it at.

CodeRabbit pays for frontier models on every review, Cloud Run workers, and a
team — so it charges $24–$72/user/month. CodeAnt charges $24/dev/mo with no
free tier. Axofy Code Review avoids those costs:

| Cost CodeRabbit pays | What Axofy Code Review does instead | Tradeoff |
|---|---|---|
| Frontier model per review | Free-tier models: NVIDIA Nemotron 3 Ultra (primary), Groq free, OpenRouter `:free` models, Gemini AI Studio free — bring your own key | Free-tier rate limits (~40 rpm on NVIDIA); smaller models than frontier on some tasks; you bring the key |
| Cloud Run + sandbox fleet | Your server / Vercel Hobby free tier (1 serverless function) + local `git clone` sandbox | No managed scale; big repos clone slower; Vercel Hobby limits apply |
| Managed data + team | GitHub free + self-hosted JSON stores (learnings/KB/cache) | No SSO/RBAC/audit; Postgres/pgvector is phase 2 |

Free-tier rate limits are the real tradeoff. A few things stretch the free tier further: 7-day response caching (hash of diff+config+profile), per-file model caching, 30s push debounce, incremental-only review (already-reviewed lines are never re-reviewed), cheap-model compression before the review pass, and a judge pass that kills noise before posting.
Nothing is ever charged — there is no billing code at all.

## Supported languages (deterministic checks, all live)

| Language | Checks include |
|---|---|
| JavaScript / TypeScript | SQL injection, eval/Function, innerHTML XSS, child_process exec, console/debugger, off-by-one |
| Python | f-string SQL injection, eval/exec, shell=True, pickle, yaml.load, bare except, print debug |
| Go | exec sh -c, template.HTML, Sprintf SQL, ignored errors (`_ =`), fmt.Println debug, off-by-one |
| Rust | unsafe blocks, unwrap(), println! debug, todo!(), formatted SQL |
| Java / Kotlin | Runtime.exec, ObjectInputStream deserialisation, SQL concat, System.out debug, MD5 |
| PHP | eval/exec/shell_exec, unserialize, SQL concat with $_GET, var_dump, MD5 |
| Ruby | eval, backticks/system, Marshal/YAML.load, SQL interpolation, puts debug |
| C / C++ | system/popen, strcpy/strcat/gets/sprintf |
| Swift / C# | try!, NSKeyedUnarchiver, Process.Start, BinaryFormatter, Console debug |
| SQL / Shell | DELETE without WHERE, DROP TABLE, dynamic EXEC, eval, curl \| sh |
| HTML / CSS / YAML / JSON / TOML | img without alt, inline handlers, unquoted secrets in config |
| Docker / Terraform | :latest base, USER root, 0.0.0.0/0 ingress, plaintext passwords |

Every language also gets the global rules (AWS/GitHub secrets, hardcoded
secrets, TODO/FIXME) and the deep analysis (taint, breaking changes,
migrations, deps, N+1, blast radius). Fixtures in `fixtures/` cover JS,
Python, Go, Java, PHP, SQL and Rust, each with a planted bug the tests
assert is caught.

## Supported hosts

| Host | Status | What works |
|---|---|---|
| GitHub (.com + Enterprise Server) | **Live** | GitHub App, webhook, diff fetch, posting, check runs, chat commands |
| GitLab (.com + self-managed) | Adapter-ready | Webhook parsing (`lib/hosts.js` `normalizeEvent`) + setup docs; diff/posting need `GITLAB_TOKEN` + `GITLAB_WEBHOOK_SECRET` — webhook returns 501 not-configured until then |
| Bitbucket (Cloud + Data Center) | Adapter-ready | Same: parsing + docs; needs `BITBUCKET_TOKEN` |
| Azure DevOps | Adapter-ready | Same: parsing + docs; needs `AZURE_DEVOPS_TOKEN` |

`GET /api/hosts` returns this table with live configured flags.

## More than CodeRabbit

- Free — no tiers, no seat billing, no hourly cap, no file cap.
- Every review names its model and provider; switch with `LLM_PROVIDER`.
- Self-host is the default — no 500-seat enterprise gate.
- Deep mode runs on every PR: architecture impact, blast radius, docs drift
  and test gaps, deterministically, even without a model key.
- 20 languages with deterministic checks, not model-only for less-common languages.

## How a review runs

```
GitHub App install → PR webhook → queue (dedupe by repo/PR/head SHA,
30s debounce, cancel superseded) → ephemeral sandbox worker
(shallow git clone, sparse-checkout honouring path_filters,
never runs untrusted repo code) → 20+ deterministic tools in parallel
(secrets, SQLi, eval, off-by-one, …) → fresh per-review code graph
(definitions / call sites / imports, blast-radius tracing) → 10-15
context points (diff, guidelines AGENTS.md/CLAUDE.md, linked Jira/Linear
issue, past PRs, CI logs, learnings) → cheap-model compression first →
planner task graph → targeted investigation via ripgrep (ast-grep when
installed) → 3-pass model review (per-file → summary → judge) →
post summary + inline comments + check run
```

## Use it from your terminal or editor

There is no website to open, no app to install, no login. AxoReview is a portable skill, a CLI, an MCP server, and a localhost HTTP API — pick whichever fits how you already work.

**The 1-step use** — paste this with your diff / PR:

> Review this diff line by line like CodeRabbit, SE mode on, using AxoReview

**Four ways in:**
1. **Copy the skill** — `agent-pack/SKILL.md` into your editor's skills folder; `agent-pack/AGENTS.md` /
   `.cursorrules` snippets for repos. One command / one file copy.
2. **CLI** — `node bin/axoreview.js review --file path/to.diff --line-by-line --se`
   (or `--base main`). Works with no server: falls back to the local engine.
3. **MCP server** — `node mcp-server.js` (stdio JSON-RPC, zero deps).
   Tools: `review_diff`, `line_by_line`, `review_file`, `review_pr`,
   `explain`, `autofix`, `gates`, `providers`. Configs in `agent-pack/mcp-*.json`.
4. **HTTP API on localhost** — `POST /api/review-line-by-line {diff}` |
   `{file, path}`, `POST /api/review-diff {diff}`, `POST /api/autofix/bulk`,
   `POST /api/gates`, `GET /api/providers`.

**What every review includes:** line-by-line verdicts for every changed
line (ok / nitpick / minor / major / critical, default mode — never
summary-only) + SE mode (SOLID, DRY/KISS/YAGNI, clean code, naming,
complexity, patterns, TDD/testability, API compat, DB safety, OWASP,
performance, concurrency, error handling) with an SE score 0–100, grade
A–D, and code smells. Tests: `npm test` = 133 passed, 0 failed
(116 suite + 17 MCP). Full detail: `agent-pack/README.md`.

## Quick start

```bash
cd ~/workspace/axoreview
cp .env.example .env   # add one free key: NVIDIA_API_KEY (or Groq/OpenRouter/Gemini)
node server.js         # http://localhost:3000  (no npm install — zero dependencies)
```

Then open the UI, paste a PR URL or a diff, pick a profile, and Run review.
No key at all? The server still works in **mock mode**: deterministic checks,
Triage, Deep Scan, Autofix and the changelog all run; model features return a
clear `needs-llm` note instead of faked output. The response always says
which mode it ran in (`llmMode: direct | vault | mock`).

### CLI

```bash
node bin/axoreview.js review --base main --profile chill
# or: axoreview review --file fixtures/sample-pr.diff
# Env: AXOREVIEW_URL (default http://localhost:3000)
```

## Env vars

| Var | Purpose |
|---|---|
| `NVIDIA_API_KEY` | Primary model (free NVIDIA NIM endpoint, Nemotron 3 Ultra) |
| `LLM_PROVIDER` | `nvidia` (default) \| `groq` \| `openrouter` \| `gemini` |
| `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `GEMINI_API_KEY` | Fallback free providers |
| `LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY` | Generic provider overrides |
| `GITHUB_TOKEN` | Private repos + higher API rate limits (public repos work without) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Posting reviews/comments/check runs |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC verification |
| `PORT` | Server port (default 3000) |
| `AXOREVIEW_LLM=mock` | Force mock mode (deterministic checks only) |
| `OLLAMA` / `LMSTUDIO` | Local models: set `LLM_PROVIDER=ollama` (http://localhost:11434) or `lmstudio` (http://localhost:1234) — no key, no bill |
| `LLM_PROVIDER=custom` | Custom endpoint: `LLM_BASE_URL` + `LLM_MODEL` + `LLM_API_KEY` (yours) |

Local dev can also use the vault helper (`scripts/nemotron_via_vault.py`),
which attaches the registered NVIDIA credential without ever exposing the key.

## GitHub App setup (for auto-review + posting)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   Name `Axofy Code Review`, homepage URL your server URL, webhook URL
   `https://<your-server>/webhook/github`, webhook secret = `GITHUB_WEBHOOK_SECRET`.
2. Permissions: **read-only** Actions, Checks, Discussions, Members, Metadata;
   **read-write** Code, Commit statuses, Issues, Pull requests. No write access
   to repo contents (Axofy Code Review never pushes, branches, or merges).
3. Subscribe to events: `pull_request`, `pull_request_review_comment`,
   `issue_comment`, `check_run`.
4. Install the app on your repos. Set `GITHUB_APP_ID` +
   `GITHUB_APP_PRIVATE_KEY` in `.env` and restart. Without the App,
   reviews still run via the UI/API — posting is skipped with a clear log
   (`posting skipped — no GitHub App configured`).

## API

| Endpoint | What it does |
|---|---|
| `GET /health` | Status, model mode, GitHub App configured? |
| `GET /sample.diff` | The fixture diff used by the landing demo and "Load sample diff" |
| `POST /api/review` `{prUrl, profile?, post?}` | Review a PR (optionally post it) |
| `POST /api/review-diff` `{diff, profile?, depth?, previousDiff?, configYaml?}` | Review a pasted diff; `previousDiff` = incremental-only; `depth` = quick\|standard\|deep |
| `GET /api/hosts` | Supported-host table with live/configured status |
| `POST /webhook/github` | GitHub webhooks (HMAC-verified) |
| `POST /api/slop` `{diff, prBody?, prTitle?}` | Slop score |
| `POST /api/autofix` `{diff, findings?}` | Safe-fix patch (manual items listed) |
| `POST /api/finishing` `{diff, kind: tests\|docstrings}` | Needs a model, else `needs-llm` |
| `POST /api/post-merge` `{diff, version?}` | Changelog draft |
| `GET /api/triage?repo=o/r` | Open PRs scored by risk/effort |
| `POST /api/explain` `{prUrl\|diff}` | Change Stack, semantic diff, blast radius, arch impact |
| `POST /api/deep-scan` `{repo, ref?}` | Whole-repo deterministic scan |
| `POST /api/chat` `{question, diff?\|prUrl?}` | Ask about a diff (needs a model) |
| `GET/POST /api/learnings`, `GET/POST /api/kb` | Learnings + knowledge base |
| `GET /api/providers` | Provider table: cost to Axofy (none) + cost to user + key needed? + local? |
| `POST /api/providers/test` `{provider, model?, baseUrl?, apiKey?}` | Test a provider config (key used once, never stored) |
| `POST /api/gates` `{findings, configYaml?}` | Evaluate quality gates (pass/fail + reasons) |
| `POST /api/autofix/bulk` `{diff, findings?, maxFiles?}` | Bulk autofix: all safe fixes in one patch, cap 200 files |
| `POST /api/learnings/feedback` `{title, file, line, source?, accepted, repo?}` | Real-time learning: accepted=true reinforces, accepted=false suppresses similar findings |
| `POST /api/review-diff` / `POST /api/review` | Now also accept a per-request key override, `byom: {provider, model?, baseUrl?, apiKey?}` |
| `POST /api/review-jobs` `{diff, profile?, depth?, byom?}` | Async review: returns 202 + `jobId`; poll `GET /api/review-jobs/:id` until `status: done` |
| `GET /api/review-jobs/:id` | Poll an async job: `queued` → `running` → `done` (with `result`) or `error` |

## Feature checklist — CodeRabbit vs Axofy Code Review

| CodeRabbit feature | Axofy Code Review status |
|---|---|
| PR summary + walkthrough + Mermaid diagram + effort + labels/reviewers + linked-issue assessment | Done — same format, summary injected under `@axoreview summary` marker |
| Inline comments, severity/category, effort, suggestion block, Prompt for Coding Agents | Done |
| Incremental + full review, 30s debounce, dedupe by repo/PR/head SHA, cancel superseded | Done |
| @bot chat + commands (review, full review, pause, resume, summary, resolve, configuration, help, generate docstrings, generate sequence diagram, approve) | Done (resolve/approve/configuration need the GitHub App) |
| Profiles quiet/chill/assertive | Done |
| `.coderabbit.yaml` sections (general, reviews, chat, knowledge_base, tools, path_filters, path_instructions) | Done as `.axoreview.yaml` |
| 1-click fix / Autofix | Done — safe auto-fixes only; risky ones listed as manual |
| Slop detection | Done (deterministic heuristics) |
| Pre-merge checks (built-in + custom NL) | Done (model-evaluated; built-in checks run in mock too) |
| Finishing touches (unit tests, docstrings) | Done (needs a model key) |
| Post-merge actions (changelog draft) | Done (deterministic draft) |
| Triage queue | Done (deterministic scoring) |
| Explain (Change Stack, semantic diff, blast radius, architecture impact) | Done (arch impact needs a model; rest deterministic) |
| Secure (secrets, SAST, deps, IaC) + Deep Scan | Done (deterministic whole-repo scan) |
| Learnings + knowledge base (guidelines, Jira/Linear paste, MCP note) | Done (JSON store; keyword match, not embeddings) |
| IDE extension / CLI | CLI done (`bin/axoreview.js`); IDE extension phase 2 |
| Multi-host (GitLab, Bitbucket, Azure) | **Adapter-ready** — webhook parsing + docs in `lib/hosts.js`, `GET /api/hosts`, 501 not-configured webhooks; GitHub live |
| Engineer agent / cloud coding agent | Phase 2 |
| SSO / RBAC / audit logs / API | Phase 2 |
| Postgres/pgvector learnings | Phase 2 (JSON file now) |
| Self-hosting at enterprise scale | Free — self-host is the default; no 500-seat gate |
| Quality gates (CodeAnt) | Done — `quality_gates` in `.axoreview.yaml`, block on critical/secrets/high/major-cap/tests; Check Run reflects the gate |
| Bulk autofix (CodeAnt) | Done — `POST /api/autofix/bulk`, all safe fixes in one patch, cap 200 files, manual list separate |
| Plain-English custom rules (CodeAnt) | Done — `custom_rules` in `.axoreview.yaml` + UI editor, deterministic match + model-enforced |
| Steps of Reproduction (CodeAnt) | Done — every finding carries `repro` (inputs, execution path, expected vs actual) |
| Real-time learnings from feedback (CodeAnt) | Done — `POST /api/learnings/feedback`; rejected findings suppress similar ones |
| Bring your own model key | Done — NVIDIA/Groq/OpenRouter/Gemini free tiers + Ollama/LM Studio local + custom endpoint; Axofy pays nothing |
| First-run checklist + demo PR + quota meter | Done — in-app 4-step checklist, one-click demo PR, live limit meter (Axofy: none) |
| Pricing | Free — no tiers, no caps; the provider's free-tier rate limits are the only limit |

## Review techniques (`lib/review-methods.js`)

Line-by-line, cross-file / blast-radius tracing, data-flow, control-flow,
security (OWASP Top 10, secrets, injection, auth), performance (N+1, loops,
allocations), correctness (off-by-one, null, race, error handling),
maintainability (SOLID, DRY, KISS, YAGNI, naming, complexity), testability
(TDD, edge cases), API/backward-compat, DB/migration safety, docs. Every
finding cites `file:line` + the exact evidence line; the judge drops
ungrounded findings. No hallucinated APIs.

## Deploy (Vercel)

Single serverless function: `api/index.js` wraps `server.js` (Vercel Hobby
caps 12 functions; Axofy Code Review uses **1**). `vercel.json` rewrites everything to
it. Set env vars in the Vercel dashboard; never commit keys.

### Vercel limits (honest)

- **Serverless timeout:** a Vercel Hobby function times out far sooner than
  a large PR review takes (a big review can run minutes). Small diffs review
  fine synchronously via `POST /api/review-diff`. **Large PRs on the Vercel
  deployment are NOT guaranteed** — for them use the CLI (`bin/axoreview.js`),
  the Windows desktop app, or a self-hosted `node server.js`, where the same
  code runs with no timeout.
- **Async jobs:** `POST /api/review-jobs` (202 + poll) works fully on a
  long-running server, but on Vercel serverless the function may freeze after
  the 202 response, so jobs there are best-effort. Do not rely on them on
  Vercel for large reviews.
- **Live site:** https://codereview.axofy.shop (after DNS CNAME
  `codereview` → `cname.vercel-dns.com`). Default mode is mock
  (deterministic checks); model reviews use the caller's own key per
  request — Axofy pays nothing.

## Tests

```bash
npm test            # mock model: planted-bug fixture, autofix, incremental, cache, queue, webhook HMAC
npm run test:real   # real model via vault helper / NVIDIA_API_KEY
```

Fixture `fixtures/sample-pr.diff` plants 3 bugs (SQL injection, off-by-one,
insecure `eval`) — the test asserts all three are found with file:line +
evidence.

## Review methods (`methods/`)

Four method notes the review follows — see `agent-pack/SKILL.md` for when each applies:

- `methods/deep-reasoning.md` — default line-by-line protocol (mental model, then a verdict per changed line).
- `methods/language-pitfalls.md` — per-language/platform checks (JS/TS, React, Node, Python, Go, Rust, Java/Kotlin, C/C++, and more).
- `methods/functional-qa.md` — test every element (inventory + test case per element type).
- `methods/security-privacy-audit.md` — security pass (authorization/scope, threat model, scanner stack).

## What is NOT yet built

IDE extension, Engineer agent, SSO/RBAC/audit, Postgres/pgvector
learnings, 20+ external linters (deterministic checks cover the highest-value
rules; ESLint/Ruff/Semgrep wiring is phase 2), eval harness with labelled PRs.
GitLab/Bitbucket/Azure diff-fetch + posting are adapter-ready, not live.
No benchmark is published (CodeAnt's benchmark claims contradict its own
blog and independent tests, so none is cited or repeated).

## Security notes

- Never runs untrusted repo code (clone is read-only; only `git` + `rg` run).
- Webhook HMAC-SHA256 verified; least-privilege GitHub App permissions.
- Keys only from env / the vault helper — never in code, logs, or commits.
- No training on customer code; review cache is local, 7-day TTL.
