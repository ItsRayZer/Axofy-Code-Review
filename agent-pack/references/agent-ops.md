<!-- AxoReview: copy of methods/agent-ops.md — source of truth is methods/, edit there, not here. -->

# Agent operations: how to run long audits reliably

Contents: 1 Preflight and capability level · 2 Safety rules · 3 Baseline ·
4 Boot the app · 5 Critical journeys · 6 Fix loop upgrades · 7 Independent
verifier · 8 Test quality · 9 State and resume · 10 Parallel work ·
11 Machine-readable output · 12 Stop rules

## 1. Preflight and capability level

Run `scripts/preflight.sh` from the project root first. State the level and
what it limits, in plain words:

| Level | Has | Can do | Cannot do |
|---|---|---|---|
| L0 | No shell | Read and reason about code | Run anything; runtime items are `UNVERIFIED` |
| L1 | Shell + git | Tests, type checks, linters, scanners | Click the UI |
| L2 | L1 + browser automation | Crawl, click, screenshot, e2e | Authenticated areas without test accounts |
| L3 | L2 + staging URL + test accounts | Full journeys, authz matrix, DAST | Production-only behavior |

If the level is below what the request needs, say how to reach the next level
(install Playwright, provide a staging URL, give test credentials) and
continue with what is possible. Do not install packages or use the network
unless the user allows it.

## 2. Safety rules (always)

- Work on a new branch `axoreview/<yyyy-mm-dd>`; never on main or in
  production. If not a git repo, copy to a scratch directory first.
- Checkpoint commit before each fix; keep fixes small so any one can be
  reverted with `git revert`.
- Never `git push`, deploy, run migrations on real data, send real
  emails/SMS, charge real cards, or delete data without explicit approval.
- Use synthetic data and test accounts. Redact secrets in all output.
- Do not run attack tooling or load tests against systems the user does not
  own. Confirm the target before any DAST scan.
- Dry-run anything destructive (`--dry-run`, `terraform plan`, `SELECT` before
  `DELETE`).
- Never disable tests, lint rules, or security checks to get green.

## 3. Baseline before changing anything

On the untouched code, run install, build, tests, type check, lint, and
scanners. Save to `.axoreview/baseline.json`: command, exit code, pass/fail
counts, failing test names, scanner finding IDs. Everything failing here is
`PRE-EXISTING`. Later results are compared to it so you can tell regressions
from old problems, and report both. If the baseline cannot run (missing deps,
env vars), record exactly what is missing and ask.

## 4. Boot the app

Find the run command from `package.json` scripts, README, Makefile,
`docker-compose`, or framework defaults. Start it in the background, wait for
a health check (HTTP 200 on `/` or `/health`), capture logs to a file, and
seed synthetic data. Record the exact steps in `.axoreview/run.md` so anyone
can reproduce. Stop the process cleanly at the end. If it will not boot, that
is the first finding: fix or report it before anything else.

## 5. Critical user journeys

Ask the user for, or infer from the code and docs, the 3 to 7 journeys that
matter most (for example: sign up, verify email, log in, core action, pay,
download, log out, reset password). Write each as numbered steps with expected
results and turn each into an end-to-end test. Run them first (to know the
current state) and last (to confirm nothing regressed). A site with every
button passing but a broken checkout is broken.

## 6. Fix loop upgrades

- **Reproduce first** with a failing test or script.
- **Bisect regressions:** if something passed in the baseline and fails now,
  `git bisect` between baseline and HEAD to find the commit.
- **Group by root cause:** ten failing buttons may share one broken handler or
  API error. Fix the cause once.
- **One change at a time**, re-run affected tests, then the full suite.
- **Flaky tests:** re-run 3 times, record pass rate, find the cause (timing,
  order, shared state, network). Quarantine only with a tracked reason.
- **Neighbor sweep:** after each fix, search for the same pattern elsewhere
  and fix or list it.
- **Fix review:** read your own diff before committing. Does it fix the cause?
  Does it change behavior elsewhere? Does it handle the failure path?

## 7. Independent verifier (fresh eyes)

After a batch of fixes, run a separate verification pass that sees only: the
original issue, the fix diff, and the tests. If sub-agents or a fresh context
exist, use them. Instructions to the verifier: try to break the fix; look for
regressions, missed edge cases, new security issues, and tests that would pass
even if the fix were reverted. Revert the fix in a scratch copy and confirm
the regression test fails. Anything the verifier disputes goes back into the
loop. A fix is not `FIXED` until the verifier agrees or the dispute is
resolved with evidence.

## 8. Test quality (tests can lie)

- **Revert check:** each regression test must fail on the old code.
- **Mutation testing** for critical modules when available (Stryker for JS/TS,
  mutmut or cosmic-ray for Python, PIT for Java, cargo-mutants for Rust).
  Surviving mutants mean weak assertions; strengthen the tests.
- **Property and fuzz tests** for parsers, validators, money/date math, and
  serializers (fast-check, Hypothesis, go-fuzz, cargo-fuzz).
- **Contract tests** between frontend and backend (schema or OpenAPI
  validation of real responses).
- **Coverage is a map, not a goal:** review uncovered lines in risky code.
- **Visual and cross-browser:** screenshot diffs (Playwright) and at least
  Chromium, Firefox, WebKit, plus a mobile viewport for key journeys.
- **Failure testing:** offline, slow network, 500s, expired sessions, empty
  data, huge data.

## 9. State and resume (survive context limits)

Persist progress in `.axoreview/` after every item so a long run can resume
after the context resets or the session ends:

```
inventory.json   all elements, status, test ids, evidence paths
backlog.json     findings with severity, root cause, status, attempts
baseline.json    pre-change results
run.md           how to boot, seed, and test
progress.md      what is done, in progress, next, and key decisions
report.md        latest assurance report
```

At the start of any session, read these files first, check the repo has not
changed underneath (commit SHA), then continue from `progress.md`. Keep
`progress.md` short and current: next three actions at the top.

## 10. Parallel work

When sub-agents or parallel sessions exist, split by area (auth, payments,
API, UI, data layer, infra) with disjoint file ownership to avoid conflicts.
Each reports findings in the shared backlog format; one coordinator merges,
dedupes, and runs the full suite after integration. Without parallelism, work
strictly in risk order.

## 11. Machine-readable output

Besides `report.md`, emit `report.json` (findings, statuses, counts, tools,
versions, commit SHA). When the user uses GitHub code scanning or similar, also
emit SARIF 2.1.0 so findings appear in their security tab. Include stable
finding IDs so reruns can show new, fixed, and unchanged items.

## 12. Stop rules and honesty

- 3 attempts per item, then `BLOCKED` with what was tried and options.
- Stop and ask when: intent is ambiguous, a fix needs a product decision, an
  action is destructive or irreversible, credentials or access are missing, or
  progress stalls (two full rounds with no net improvement).
- Watch budget (time, tokens, cost). When it runs short, finish the highest
  risk items, save state, and report exactly what remains.
- The final report states what was done, what passed with evidence, what
  failed or is blocked, what is unverified and why, and the residual risk. No
  "all fixed" without the evidence table.
