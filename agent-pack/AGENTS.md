# AxoReview — agent instructions (paste into your repo's AGENTS.md)

Review every pull request and every local diff with AxoReview before
merging. AxoReview is a free, agent-first code reviewer (CodeRabbit method,
$0, BYOM — your own model, Axofy pays $0).

## How to review (default: line-by-line, SE on)

1. Get the diff (`git diff main...HEAD`, or the PR diff).
2. Run it through AxoReview — one of:
   - CLI: `node <path-to-axoreview>/bin/axoreview.js review --file diff.txt --line-by-line --se`
   - MCP: `line_by_line` tool on the AxoReview MCP server (`node <path-to-axoreview>/mcp-server.js`)
   - HTTP: `POST http://localhost:3000/api/review-line-by-line {diff}`
   - By hand: follow `agent-pack/SKILL.md` (or the full skill at
     `~/workspace/custom-skills/axoreview/SKILL.md`) on the pasted diff.
3. **Every changed line gets a verdict** — ok / nitpick / minor / major /
   critical — with file:line, the exact evidence line, a fix, and Steps of
   Reproduction. Never return a summary-only review.
4. **SE mode is on by default** — check every line against SOLID, DRY /
   KISS / YAGNI, clean code, naming, complexity, design-pattern misuse,
   TDD/testability, API/backward-compat, DB/migration safety, OWASP
   security, performance, concurrency, error handling. Report the SE
   score (0–100), grade, and code smells.
5. Block the merge on critical findings and failed quality gates
   (`POST /api/gates` or the `gates` MCP tool). A human still merges.

## One-line prompt

> Review this diff line by line like CodeRabbit, SE mode on, using AxoReview

## Rules

- Cite file:line + the exact evidence line for every finding. Never claim
  an API or behaviour you cannot see in the diff/context.
- No key = deterministic mode, labelled `llmMode: mock`. Never fake an
  LLM verdict, a benchmark, a stat, or a customer.
- Keys are per-request only — never stored, never logged, never in chat.
- Autofix is safe-only (off-by-one, remove debug lines, single-line
  fixes). Secrets, SQLi, eval, multi-line fixes are manual-only.
