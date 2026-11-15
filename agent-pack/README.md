# AxoReview — code review for your terminal and editor (no website, no app, no login)

There is nothing to install, nothing to open, nothing to sign into. AxoReview is a skill, a CLI, and an MCP server you can use in one step. It reviews code the way CodeRabbit does — line by line, with software-engineering judgement — free, using your own model key.

**Skill v2 (15 Nov 2026):** `SKILL.md` is now "AxoReview v2: deep,
evidence-driven code review" — intent model, line-by-line execution
reasoning, cross-file impact, adversarial pass, self-falsification, and
whole-app mode (`qa` / `audit app` / `harden` / `privacy`) that inventories
and tests every element and audits security/privacy with real scanners.
Its method files live in `references/` (copies of `methods/` in the repo)
and its helper scripts in `scripts/`.

## The 1-step use

Paste this with your diff / PR:

```
Review this diff line by line like CodeRabbit, SE mode on, using AxoReview
```

That's it. The skill file (`SKILL.md`) lays out the review. If the engine (`~/workspace/axoreview/`) is present it runs the real checks; if not, the review follows the skill by hand on the pasted diff.

## Four ways to use it (pick one — all free)

### 1. Copy the skill — 30 seconds, works everywhere
```bash
# Editor skills folders — drop the whole pack in (the skill
# needs its references/ and scripts/ next to it):
cp -r agent-pack ~/.claude/skills/axoreview
# Cursor — copy the skill, or use .cursorrules (in this pack):
cp agent-pack/.cursorrules /path/to/your/repo/.cursorrules
# Any repo — add the AGENTS.md snippet (in this pack) to your AGENTS.md
```
Then ask for a review of a diff. No server, no key, no website.

### 2. CLI — one command, works with no server
```bash
node <path-to-axoreview>/bin/axoreview.js review --file path/to.diff --line-by-line --se
node <path-to-axoreview>/bin/axoreview.js review --base main --line-by-line --se
```
If a server runs at `$AXOREVIEW_URL` it is used; otherwise the CLI runs
the same engine **locally** (deterministic checks + SE, free, no key).
`--no-se` disables SE notes, `--depth quick|standard|deep`,
`--profile quiet|chill|assertive`.

### 3. MCP server — any MCP client (Claude Desktop, Cursor, VS Code)
```bash
node <path-to-axoreview>/mcp-server.js   # stdio JSON-RPC, zero dependencies
```
Tools: `review_diff`, `line_by_line`, `review_file`, `review_pr`,
`explain`, `autofix`, `gates`, `providers`. Config files in this pack:
- `mcp.json` — generic (copy the `mcpServers.axoreview` block)
- `mcp-claude-desktop.json` — Claude Desktop
- `mcp-cursor.json` — Cursor
- `mcp-vscode.json` — VS Code
Replace `<ABSOLUTE_PATH_TO_AXOREVIEW>` with the real path to the
`axoreview/` folder. Set `AXOREVIEW_LLM=mock` in the config env to run
deterministic-only with no key at all.

### 4. HTTP API on localhost — for anything that speaks HTTP
```bash
node <path-to-axoreview>/server.js   # http://localhost:3000, zero dependencies
POST /api/review-line-by-line  {diff} | {file, path}
POST /api/review-diff           {diff}
POST /api/autofix/bulk          {diff, findings?}
POST /api/gates                 {findings}
GET  /api/providers
```

## What you get (every review, every way)

- **Line-by-line verdicts (default):** every changed line gets
  `ok / nitpick / minor / major / critical` with file:line, the exact
  evidence line, a fix, and Steps of Reproduction. Never summary-only.
- **SE mode (on by default):** SOLID, DRY/KISS/YAGNI, clean code, naming,
  complexity, design-pattern misuse, TDD/testability, API/backward-compat,
  DB/migration safety, OWASP security, performance, concurrency, error
  handling — plus an SE score 0–100, grade A–D, code smells, and a
  ship-it / needs-changes summary.
- **CodeRabbit method/format:** 3-pass review (per-file → summary →
  judge), walkthrough + Mermaid diagram + effort 1–5, inline findings,
  `@axoreview` commands, profiles quiet/chill/assertive, `.axoreview.yaml`.
- **CodeAnt extras, free:** quality gates, bulk autofix (cap 200 files),
  plain-English custom rules, Steps of Reproduction, real-time learnings.
- **20 languages, deterministic:** JS/TS, Python, Go, Rust, Java, Kotlin,
  PHP, Ruby, C/C++, Swift, C#, SQL, Shell, HTML/CSS, YAML/JSON/TOML,
  Docker, Terraform — plus taint, breaking changes, blast radius,
  architecture impact (deep mode), all without a model key.

## Free — how it works

Reviews run on your own model key: NVIDIA Nemotron free, Groq free, OpenRouter
`:free`, Gemini AI Studio free, local Ollama / LM Studio (no key, no cloud,
no bill), or any OpenAI-compatible endpoint you supply. Per-request keys
are used for that call only — never stored, never logged. No key means
deterministic mode, honestly labelled. Every review names its provider +
model + `axofyCostUsd: 0`.

## Files in this pack

| File | What it is |
|---|---|
| `SKILL.md` | Portable skill v2 — drop into any agent |
| `references/` | The 5 method files the skill reads (`deep-reasoning`, `functional-qa`, `language-pitfalls`, `security-privacy-audit`, `agent-ops`) — copies of `methods/` in the repo |
| `scripts/` | Helper scripts the skill uses (`preflight.sh`, `crawl.mjs`) — copies of `scripts/` in the repo |
| `README.md` | This file — how to use it in 1 step |
| `AGENTS.md` | Snippet to paste into a repo's `AGENTS.md` |
| `.cursorrules` | Snippet for Cursor repos |
| `mcp.json` | Generic MCP server config |
| `mcp-claude-desktop.json` | Claude Desktop MCP config |
| `mcp-cursor.json` | Cursor MCP config |
| `mcp-vscode.json` | VS Code MCP config |
| `skill.yaml` | Skill metadata (name axoreview, version) |

Full skill (v2, 497 lines): `~/workspace/custom-skills/axoreview/SKILL.md`.
Engine: `~/workspace/axoreview/` — `lib/line-by-line.js` (line-by-line +
SE), `lib/pipeline.js` (3-pass review), `mcp-server.js`, `bin/axoreview.js`,
`server.js`. Tests: `npm test` in that folder (133 passed, 0 failed at
last check — 116 suite + 17 MCP).

## Review methods (`methods/` in the repo, copies in `references/` here)

- `methods/deep-reasoning.md` — **default line-by-line protocol.** Mental model first, then a verdict on every changed line. Read it before every review.
- `methods/language-pitfalls.md` — **per-language checks** (JS/TS, React, Node, Python, Go, Rust, Java/Kotlin, C/C++, and more). Read it when the diff touches one of those languages/platforms.
- `methods/functional-qa.md` — **test every element.** Inventory every UI/API element in the diff, test case per element type. Use when the change is user-facing or adds behaviour. First pass on a running app: `node scripts/crawl.mjs <url>`.
- `methods/security-privacy-audit.md` — **security pass** (authorization/scope, threat model, scanner stack). Use when the review touches auth, data, secrets, or user input, and as a final pass before ship.
- `methods/agent-ops.md` — **operations for long audits.** Preflight/capability levels, safety rules, baseline, fix loop, independent verifier, state/resume. Use for `qa` / `audit app` / `harden` runs.

## Helper scripts (`scripts/` in the repo, copies in `scripts/` here)

- `scripts/preflight.sh` — **run first, read-only.** Detects tools and stack, outputs JSON with the capability level (L0 read-only → L3 staging + accounts). No network, no installs.
- `scripts/crawl.mjs` — **Playwright crawler.** Inventories and click-tests a running app (`node scripts/crawl.mjs <baseUrl>`), writes `report.json` + `inventory.json` + screenshots. Requires Playwright (`npm i -D playwright`); findings are heuristic leads, verify each before marking FAIL.

## What is NOT here (on purpose)

No website, no app, no login, no GitHub App, no Vercel deploy — on purpose.
The engine in `~/workspace/axoreview/` still works as a server if you need it.
