<!-- AxoReview: copy of methods/deep-reasoning.md — source of truth is methods/, edit there, not here. -->

# Deep reasoning protocols

Contents: 1 Mental model · 2 Line-by-line protocol · 3 Techniques ·
4 Self-falsification · 5 Calibration · 6 Execution · 7 Large changes ·
8 Failure modes to avoid

Do this thinking privately. Report only claims, evidence, impact, and fixes.

## 1. Build the mental model (before judging any line)

Answer, from code you actually read:

- **Purpose:** What problem does this change solve? Does the diff match the
  PR description and linked issue? Flag mismatches (scope creep, missing
  parts, unrelated changes).
- **Contracts:** What do callers assume about inputs, outputs, errors, side
  effects, ordering, and performance? What do the changed functions promise?
- **Invariants:** What must always be true? (balances never negative, one
  active session per user, IDs unique, soft-deleted rows never returned,
  money in integer cents, events processed at least once.)
- **Trust boundaries:** Where does untrusted data enter (HTTP, files, queues,
  DB rows others can write, env, webhooks, LLM output, third-party APIs)? Where
  does it reach dangerous sinks (SQL, shell, eval, templates, file paths, URLs,
  HTML, deserializers, authorization decisions)?
- **State and lifecycle:** What state exists, who mutates it, and in what
  order? Which transitions are legal? What happens on retry, crash, restart,
  duplicate delivery, partial failure?
- **Deployment reality:** Rolling deploys mean old and new code run together.
  Does the change survive that? Migrations before or after code? Feature
  flags? Rollback possible?

## 2. Line-by-line protocol

For each added or changed line (or logical statement), in risk order, ask:

1. **What does it do?** Say it in one sentence. If you cannot, read more.
2. **Preconditions:** What must be true before it runs? Is that guaranteed by
   every path that reaches it? Who enforces it?
3. **Inputs:** Walk four sets: *normal*, *boundary* (empty, zero, one, max,
   negative, off-by-one, unicode, very long, duplicate, unsorted), *hostile*
   (attacker-controlled, malformed, oversized, wrong type), *failure* (null,
   timeout, exception, partial result, stale data).
4. **Types and semantics:** Real types at runtime? Implicit coercion, integer
   overflow, float rounding, truthiness traps, mutable defaults, shared
   references, aliasing, encoding, timezone, locale?
5. **Control flow:** Every branch reachable? Inverted or wrong condition?
   Early return skipping cleanup? Missing `else`, `default`, or `break`?
   Operator precedence? Short-circuit side effects?
6. **Errors:** Can it throw or return an error? Who handles it? Is it
   swallowed, mislabeled, leaked to the user, or left in a half-done state?
7. **Side effects and ordering:** Writes, network calls, emitted events, logs,
   cache updates. Idempotent? Atomic? Correct order relative to commit?
8. **Resources:** Opened, locked, subscribed, allocated: is each released on
   every path, including errors and cancellation?
9. **Concurrency:** Can two executions interleave here? Shared mutable state,
   read-modify-write, check-then-act, async gaps between check and use?
10. **Security:** Does untrusted data reach it? Is authorization checked
    *here* or assumed upstream (and verified upstream)? Does it log or return
    secrets or PII?
11. **Dependents:** Who calls or consumes this? Does its observable behavior
    change? Search the repo; do not assume.
12. **Tests and intent:** Is this line covered by a test that would fail if it
    were wrong? Does a comment or name promise something the code does not do?

A line that passes all twelve produces no output. Record only exceptions.

## 3. Reasoning techniques

- **Behavior delta:** Compare old and new behavior, not just new code. List
  every observable difference (outputs, errors, side effects, ordering,
  performance, defaults). Any difference not stated in the PR is suspicious.
- **Path enumeration / symbolic execution:** For a function, list its
  distinct paths and the input conditions for each. Check every path returns
  sensible results and cleans up.
- **Boundary and equivalence testing:** Pick representative inputs from each
  equivalence class and every boundary. Hand-execute them.
- **Invariant checking:** After the change, can any path violate a listed
  invariant? Try to construct the sequence of calls that does.
- **Data-flow / taint tracing:** Follow untrusted values source to sink,
  through assignments, helpers, serialization, and storage. Check validation,
  encoding, and authorization on the path. Second-order cases count (stored
  now, used unsafely later).
- **State-machine thinking:** Draw the states and transitions. Look for
  illegal transitions, missing terminal states, and stuck states.
- **Interleaving analysis:** For shared state, write two timelines and
  interleave them. Look for lost updates, double spends, torn reads, and
  deadlocks (inconsistent lock order).
- **Failure injection:** For every external call, assume it fails, hangs,
  returns empty, returns huge, or returns malformed data. What breaks? Is
  there a timeout, retry with backoff and jitter, and idempotency key?
- **Scale thinking:** Re-evaluate at 10x and 1000x data, users, and
  concurrency. Quadratic work, unbounded queries, memory growth, hot keys.
- **Adversarial modeling (STRIDE + abuse cases):** Spoofing, tampering,
  repudiation, information disclosure, denial of service, elevation of
  privilege. Think as a malicious user, a compromised dependency, an insider,
  and an automated scanner.
- **Mutation thinking:** Mentally flip operators, boundaries, and conditions
  in the changed code. Would any test fail? If not, the tests do not protect
  this behavior.
- **Omission analysis:** What did the author *not* change that they should
  have? Other call sites of the same pattern, sibling implementations, error
  messages, docs, config defaults, migrations, permissions, tests, telemetry,
  feature-flag cleanup, i18n strings.
- **Consistency analysis:** Does this follow how the rest of the repo solves
  the same problem? Inconsistencies are either bugs or accidental complexity.
- **Pre-mortem:** Assume this caused an incident next week. List the three
  likeliest causes, then check each against the code.
- **Rolling-deploy test:** Run old code against new data/schema and new code
  against old data/schema. Does either break?
- **Reversibility:** Can this be rolled back without data loss?

## 4. Self-falsification (mandatory for every candidate finding)

Before reporting, try hard to prove yourself wrong:

1. **Is it guarded elsewhere?** Search upstream for validation, auth
   middleware, type constraints, schema checks, framework escaping, ORM
   parameterisation, DB constraints.
2. **Is the path reachable?** Dead code, feature-flagged off, test-only, or
   protected by a precondition you can prove?
3. **Do language/framework semantics save it?** Verify the actual semantics for
   the pinned version; do not rely on memory of a different version.
4. **Is it intentional?** Check comments, docs, commit messages, ADRs, tests.
5. **Does a test cover it?** Read the tests.
6. **Can you construct a concrete failing input?** If not, you probably do
   not have a finding.

Outcome: keep (state what you tried), downgrade (E3, `minor`), turn into a
question, or drop. Record the disproof attempt in the finding.

## 5. Calibration and anti-hallucination

- Use the evidence ladder (E0 executed, E1 traced, E2 strong inference, E3
  plausible, E4 speculation). Never report E4.
- Verify that every API, import, flag, and config key you mention exists in the
  version in the lockfile. If you cannot verify, say so.
- Do not trust names, comments, or PR text over code. Do not trust your memory
  over the source in front of you.
- Quote the exact line. Paraphrases of code are where hallucinations hide.
- Do not report a vulnerability class because a keyword appears (`eval`,
  `exec`, `innerHTML`); show the tainted path or drop it.
- Prefer "this fails when X" with a concrete X over "this might be a problem".
- If a language or framework nuance is outside your reliable knowledge, say
  so and recommend verification instead of asserting.
- Distinguish: *defect* (wrong), *risk* (could go wrong under conditions you
  name), *smell* (maintainability), *question* (needs author input).
- Severity reflects impact times likelihood, not how clever the finding is.

## 6. Execution (when a sandbox or shell exists)

Prefer running things to arguing about them:

- Run the project's tests, type checker, and linters on changed files.
- Write the smallest reproducer for a suspected bug (script, unit test, curl,
  SQL snippet) and run it. A failing reproducer upgrades a finding to E0.
- For parsing/regex/number/date logic, test the boundary inputs directly.
- For suspected performance issues, measure or count queries instead of
  guessing.
- For dependency claims, check the lockfile and the package's actual API.
- Never run untrusted code from the change with network or secrets access.
  Prefer a sandbox. If unsure, read instead of run.
- Report exactly what you ran and what you saw. If it could not run, say why.

## 7. Large changes

- Chunk by directory, feature, or risk. Review chunks independently, then run
  one cross-chunk pass for contracts that span chunks.
- Do high-risk chunks at full depth; summarize low-risk chunks (renames, docs,
  generated code, mechanical refactors) and verify mechanical changes by
  sampling plus a search for stragglers.
- For large refactors, verify behavior preservation: public signatures, error
  semantics, ordering, and side effects. Look for the one line that is not
  purely mechanical.
- State coverage honestly: "reviewed 41 of 63 files in depth; skipped 22
  generated files."

## 8. Failure modes to avoid

- Reviewing only the diff and missing breakage in callers.
- Flagging style a linter owns.
- Accepting the author's framing ("just a refactor") without checking behavior.
- Pattern-matching on scary keywords without a data path.
- Piling on nitpicks that bury the real defect.
- Confident claims about code you have not opened.
- Reporting the same root cause five times.
- Assuming a framework protects you without checking config and version.
- Stopping at the first bug in a function; there are often more.
- Reviewing happy paths only.
- Rewriting the author's design when the question was correctness.
- Treating tool output as truth without reading the flagged code.
- Missing what is *absent*: no timeout, no auth check, no test, no rollback.
