# AxoReview — agent-first code review (no website, no app, no login)

**People are lazy. So there is nothing to install, nothing to open, nothing
to sign into.** AxoReview is a skill + a CLI + an MCP server that any agent
or AI can use in one step. It reviews code the way CodeRabbit does — line
by line, with software-engineering judgement — for $0, using the user's own
model.

## The lazy-user 1-step use

Paste this to your agent (Claude Code, Cursor, ChatGPT, Gemini, Copilot,
any AI) along with your diff / PR:

```
Review this diff line by line like CodeRabbit, SE mode on, using AxoReview
```

That's it. The agent reads `SKILL.md` in this pack (or the full skill at
`~/workspace/custom-skills/axoreview/SKILL.md`) and does the review. If the
agent has the engine (`~/workspace/axoreview/`), it runs the real checks;
if not, it follows the skill by hand on the pasted diff.

## Four ways to use it (pick one, all $0)

### 1. Copy the skill — 30 seconds, works everywhere
```bash
# Claude Code / Codex / Gemini CLI — drop the skill in:
cp agent-pack/SKILL.md ~/.claude/skills/axoreview/SKILL.md
# Cursor — copy the skill, or use .cursorrules (in this pack):
cp agent-pack/.cursorrules /path/to/your/repo/.cursorrules
# Any repo — add the AGENTS.md snippet (in this pack) to your AGENTS.md
```
Then ask your agent to review a diff. No server, no key, no website.

### 2. CLI — one command, works with no server
```bash
node bin/axoreview.js review --file path/to.diff --line-by-line --se
node bin/axoreview.js review --base main --line-by-line --se
```
If a server runs at `$AXOREVIEW_URL` it is used; otherwise the CLI runs
the same engine **locally** (deterministic checks + SE, $0, no key).
`--no-se` disables SE notes, `--depth quick|standard|deep`,
`--profile quiet|chill|assertive`.

### 3. MCP server — any MCP client (Claude Desktop, Cursor, VS Code)
```bash
node mcp-server.js   # stdio JSON-RPC, zero dependencies
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

### 4. HTTP API on localhost — for agents that speak HTTP
```bash
node server.js   # http://localhost:3000, zero dependencies
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
  architecture impact (deep mode), all without an LLM key.

## Free — how it costs nobody anything

**Axofy pays $0 for every model. The user pays $0 extra.** Reviews run on
the user's own model (BYOM): NVIDIA Nemotron free, Groq free, OpenRouter
`:free`, Gemini AI Studio free, local Ollama / LM Studio (no key, no cloud,
no bill), or any OpenAI-compatible endpoint they supply. Per-request keys
are used for that call only — never stored, never logged. No key =
deterministic mode, honestly labelled. Every review names its provider +
model + `axofyCostUsd: 0`.

## Files in this pack

| File | What it is |
|---|---|
| `SKILL.md` | Portable condensed skill — drop into any agent |
| `README.md` | This file — how to use it in 1 step |
| `AGENTS.md` | Snippet to paste into a repo's `AGENTS.md` |
| `.cursorrules` | Snippet for Cursor repos |
| `mcp.json` | Generic MCP server config |
| `mcp-claude-desktop.json` | Claude Desktop MCP config |
| `mcp-cursor.json` | Cursor MCP config |
| `mcp-vscode.json` | VS Code MCP config |
| `skill.yaml` | Skill metadata (name axoreview, version) |

Full skill (1,390 lines, all prompts + worked examples):
`~/workspace/custom-skills/axoreview/SKILL.md`.
Engine: `~/workspace/axoreview/` — `lib/line-by-line.js` (line-by-line +
SE), `lib/pipeline.js` (3-pass review), `mcp-server.js`, `bin/axoreview.js`,
`server.js`. Tests: `npm test` in that folder (133 passed, 0 failed at
last check — 116 suite + 17 MCP).

## What is NOT here (on purpose)

No website, no app, no login, no GitHub App, no Vercel deploy — dropped
by owner order 15 Nov 2026 ("people are lazy"). If the website/app plan
ever resumes, the engine in `~/workspace/axoreview/` is untouched and
still works as a server. Until then: agent-first only.
