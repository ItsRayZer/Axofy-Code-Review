# Language and platform pitfalls

Contents: JS/TS · React · Node · Python · Go · Rust · Java/Kotlin · C/C++ ·
C# · PHP · Ruby · Swift · SQL · Shell · Terraform/K8s/Docker · GitHub Actions ·
Smart contracts · LLM/AI apps

Use as a checklist of *things to verify*, not automatic findings. Each still
needs a traced path and evidence.

## JavaScript / TypeScript
- Missing `await`, floating promises, `async` in `forEach`, `Promise.all` vs
  serial intent, unhandled rejections.
- `==` vs `===`, truthiness (`0`, `""`, `NaN`), `typeof null`, `parseInt` radix,
  float math, `Date` parsing and timezones, array holes, `sort()` default
  string order, `in` vs `hasOwn`.
- Prototype pollution (`merge`, `Object.assign`, `__proto__`), `eval`,
  `new Function`, `innerHTML`, `dangerouslySetInnerHTML`, ReDoS regexes.
- TypeScript: `any`, unsafe `as`, non-null `!`, `@ts-ignore`, types that do
  not match runtime validation, optional chaining hiding bugs.
- Closures in loops, stale state, listeners and timers not cleaned up.

## React / frontend
- Hook rules, missing/incorrect dependency arrays, stale closures, effects
  that should be derived state, state mutation, unstable keys, re-render
  storms, memory leaks, hydration mismatches, race conditions in fetch effects
  (no abort), XSS via `href="javascript:"`, unsanitized HTML, a11y roles and
  labels, focus management, tokens in `localStorage`.

## Node / backend JS
- Blocking the event loop, unbounded request bodies, missing timeouts, path
  traversal in `fs`/`path.join`, `child_process` with user input, SSRF in
  fetchers, missing auth middleware order, CORS wildcards with credentials,
  cookie flags (`HttpOnly`, `Secure`, `SameSite`), JWT verification options.

## Python
- Mutable default args, late-binding closures, `is` vs `==`, bare `except`,
  swallowed exceptions, generators consumed twice, integer/float division,
  naive vs aware datetimes, `yaml.load`, `pickle`, `eval/exec`, `subprocess`
  with `shell=True`, SQL string formatting, `assert` for validation (stripped
  with `-O`), `requests` without timeout, `open` without encoding/closing,
  Django/Flask: `DEBUG=True`, missing CSRF, `mark_safe`, raw queries,
  N+1 with ORM (`select_related`/`prefetch_related`).

## Go
- Ignored errors, `defer` in loops, loop-variable capture (pre-1.22), nil map
  writes, nil interface vs nil pointer, goroutine leaks, missing `context`
  cancellation/timeouts, data races (run with `-race`), `http.Client` without
  timeout, unclosed `resp.Body`, slices aliasing after `append`, `time.After`
  leaks.

## Rust
- `unwrap`/`expect` in non-test paths, `unsafe` justification and soundness,
  integer overflow in release, blocking calls in async, holding locks across
  `.await`, `clone` hiding perf cost, panics across FFI, lifetime workarounds
  that hide design bugs.

## Java / Kotlin
- Null handling, `equals`/`hashCode` contracts, mutable shared state, resource
  leaks (try-with-resources), `SimpleDateFormat` thread-safety, unchecked
  casts, SQL concatenation, deserialization (`ObjectInputStream`, Jackson
  polymorphic types), Spring: missing `@Transactional` boundaries, self-
  invocation bypass, security filter order; Kotlin: `!!`, platform types,
  coroutine scope leaks, blocking in `Dispatchers.Main`.

## C / C++
- Buffer overflow, off-by-one, use-after-free, double free, uninitialized
  reads, integer overflow/signedness, format strings, TOCTOU, missing bounds
  checks, ownership/RAII violations, data races, iterator invalidation,
  undefined behavior, `strcpy`/`sprintf` family.

## C# / .NET
- `async void`, `.Result`/`.Wait()` deadlocks, `IDisposable` leaks, `DateTime`
  kinds, LINQ deferred execution surprises, EF N+1 and tracking, SQL
  concatenation, model-binding over-posting, missing `[Authorize]`.

## PHP
- Type juggling (`==`), SQL concatenation, file inclusion, `unserialize`,
  missing escaping, `extract()`, session handling, `eval`, upload validation,
  mass assignment (Laravel `$fillable`), CSRF.

## Ruby / Rails
- Mass assignment/strong params, `send`/`constantize` on user input, SQL
  fragments in `where`, N+1 (`includes`), `html_safe`/`raw`, callbacks with
  side effects, `Marshal.load`, open redirects.

## Swift / mobile
- Retain cycles (`[weak self]`), force unwraps, main-thread UI updates,
  Keychain vs UserDefaults for secrets, ATS exceptions, deep-link handling,
  permission strings, background task limits; Android: exported components,
  intent injection, `WebView` JS bridges, cleartext traffic.

## SQL / data
- Missing `WHERE` on `UPDATE`/`DELETE`, implicit joins and cartesian products,
  `NOT IN` with NULLs, missing indexes for new predicates, functions on
  indexed columns, non-concurrent index builds, `SELECT *` in contracts,
  transaction isolation assumptions, deadlock-prone ordering, migrations that
  rewrite large tables, adding NOT NULL without default/backfill, timezone
  columns, unbounded `IN` lists, injection through dynamic identifiers.

## Shell / Bash
- Unquoted variables, missing `set -euo pipefail`, `rm -rf $VAR/`, `eval`,
  `curl | sh`, parsing `ls`, word splitting, temp-file races (`mktemp`),
  secrets in args or `ps`, non-portable bashisms under `sh`.

## Docker / Kubernetes / Terraform
- Running as root, `latest` tags, secrets in image layers/env, missing
  healthchecks and resource limits, privileged/hostPath, `0.0.0.0/0`, wildcard
  IAM, public buckets/DBs, unencrypted storage, missing network policies,
  destructive plan changes (`force replacement`), state/secret leakage,
  missing lifecycle/prevent_destroy on stateful resources.

## GitHub Actions / CI
- `pull_request_target` checking out PR code, `${{ github.event.* }}` injected
  into `run:`, over-broad `permissions`, unpinned third-party actions (pin to
  SHA), secrets exposed to forks, caching poisoning, self-hosted runner
  exposure, artifacts containing secrets.

## Smart contracts
- Reentrancy, checks-effects-interactions, unchecked external calls, access
  control on privileged functions, integer/rounding issues, front-running,
  oracle manipulation, upgradeability/storage-layout collisions, `tx.origin`,
  signature replay, gas griefing, unbounded loops.

## LLM / AI applications
- Prompt injection via retrieved content, user input, tool results, or files;
  model output executed or rendered unsafely; over-privileged tools and
  agents; secrets in prompts or logs; missing output validation and schema
  checks; unbounded tokens/cost/loops; PII sent to third parties; no human
  confirmation on destructive actions; evals and guardrails absent for
  behavior-critical prompts.
