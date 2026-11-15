# Functional QA: test every element

Contents: 1 Inventory · 2 Test cases per element type · 3 Execution ·
4 Evidence and statuses · 5 Fix loop rules · 6 Completeness checks

Goal: no user-reachable element goes unlisted, and none is marked working
without observed evidence.

## 1. Inventory (build it from several sources, then reconcile)

Sources, use all that apply and diff them against each other:

- **Code:** router config, page/route files, component trees, event handlers
  (`onClick`, `onSubmit`, `@click`, `addEventListener`), form definitions,
  controllers, API route files, GraphQL schema, OpenAPI/Swagger, gRPC protos,
  CLI definitions, cron/queue/job definitions, webhook handlers, exported
  functions, feature flags, env/config keys, email and notification templates.
- **Running app:** crawl in a real browser (Playwright). Collect every link,
  button, `[role=button]`, input, select, textarea, checkbox, radio, file
  input, dialog trigger, menu, tab, accordion, toggle, and shortcut. Repeat per
  role (anonymous, user, admin), viewport (mobile, desktop), and locale.
- **Network:** record API calls the UI makes; find endpoints never exercised
  by the UI and UI actions that call nothing.
- **Docs and tickets:** README, product specs, issues, changelogs, for
  promised features.

Record each item as:

```
{ id, type, location (file:line / URL / selector), purpose, roles,
  inputs, expected behavior, dependencies, test_ids[], status, evidence }
```

Reconcile: list items present in one source but missing in another (dead
buttons, orphan routes, undocumented endpoints, UI with no handler, handlers
with no UI). Each mismatch is a finding.

## 2. Test cases by element type

Write at least these for each item. Name each test after the item id.

**Buttons / links / controls:** visible and enabled when it should be;
disabled when it should be; correct handler fires once (no double-submit);
loading and error states; keyboard (Tab, Enter, Space, Esc) and screen reader
name/role; focus order and visible focus; works on touch; correct
destination, target, and `rel="noopener"`; no console errors; correct
behavior when offline or slow.

**Forms and inputs:** required/optional rules; type, length, pattern, and
range validation both client and server side; boundary values (empty, 1, max,
max+1); whitespace-only; unicode/emoji/RTL; very long input; paste and
autofill; special characters and HTML in text; duplicate submit; resubmit
after error; reset/cancel; error messages are specific, accessible, and
associated with fields; server rejects what the client forgot; CSRF token
present.

**File upload:** allowed and blocked types by content not extension; size
limit; zero-byte; double extensions; path traversal in names; malware-safe
handling; storage location is not web-executable; access control on download.

**Auth flows:** sign up, verify, login, logout, remember me, password reset,
change password/email, MFA, OAuth, session expiry, concurrent sessions,
lockout/rate limit, account deletion, enumeration resistance (same response
for known and unknown users).

**Navigation and routing:** every route resolves; 404 and error pages; deep
links; back/forward; redirects (no open redirect); protected routes redirect
or deny correctly per role; trailing slash and case handling.

**API endpoints:** method/status matrix; schema of requests and responses;
validation errors; pagination, sorting, filtering; idempotency; auth required
vs. public; per-object authorization (user A cannot read or change user B's
data); rate limiting; large payloads; content-type mismatch; CORS.

**Functions / modules:** unit tests for normal, boundary, invalid, and failure
inputs; pure-function property tests where useful; mocks only at true
boundaries; error propagation.

**Background jobs / webhooks:** run once, retry, duplicate delivery,
out-of-order delivery, poison messages, timeout, signature verification.

**State, data, and persistence:** create/read/update/delete round trip;
migrations up and down on realistic data; concurrency; caching and
invalidation; export/import; backup/restore if present.

**Cross-cutting:** responsive layouts; dark mode; i18n and RTL; accessibility
(axe, keyboard, contrast); performance budgets (Lighthouse); SEO basics;
cookie/consent behavior; error monitoring hooks; empty, loading, and error
states for every data view.

## 3. Execution

Use what the project already has, and add Playwright for browser flows.

```bash
# unit/integration (examples)
npm test | pytest -q | go test ./... -race | cargo test | mvn -q test
# end-to-end and crawl
npx playwright install --with-deps && npx playwright test
# accessibility and performance
npx @axe-core/cli <url> ; npx lighthouse <url> --output=json
# API
newman run collection.json | schemathesis run openapi.yaml
```

Run against a local or staging environment with synthetic data. Capture
screenshots, traces, console and network logs, exit codes, and coverage.
Flaky result: re-run 3 times, record the pass rate, fix or quarantine with a
tracked reason; never hide it.

## 4. Statuses and evidence

| Status | Meaning |
|---|---|
| `PASS` | Test ran and passed; evidence attached |
| `FAIL` | Test ran and failed; reproducer attached |
| `FIXED` | Was FAIL; fix applied; regression test passes; suite green |
| `BLOCKED` | Cannot fix or test yet; reason and owner stated |
| `UNVERIFIED` | Not executed (no runtime, no credentials, no data); reason stated |

No evidence, no PASS.

## 5. Fix loop rules

1. Reproduce first. A failing test or script proves the defect.
2. Find the root cause, not the symptom. Group failures by cause.
3. Smallest safe change. Match repo conventions.
4. Add or update a regression test that fails before and passes after.
5. Re-run the affected tests, then the full suite, then relevant scanners.
6. Check neighbors: same pattern elsewhere (grep), related flows, docs.
7. Never delete, skip, or loosen a test or rule to get green.
8. Max 3 attempts per item. Then mark `BLOCKED` with findings and options.
9. Risky areas (auth, crypto, payments, schema, deletion, infra) are
   proposed as reviewed patches, not silently applied.
10. Commit in small, logical steps with clear messages when the user allows.

## 6. Completeness checks

- Item count by type matches across all sources, or each gap is explained.
- Every route has a test; every handler is reached by a test; every endpoint
  has at least one authorized and one unauthorized test.
- Coverage report reviewed: uncovered lines in changed or risky code get tests
  or an explicit note.
- Re-crawl after fixes to catch new or changed elements.
- Final run on a clean checkout of the final commit (fresh install, fresh
  database) to catch "works on my machine".
- State what the inventory could not reach (auth-gated areas without
  credentials, third-party flows, hardware, payments in live mode).
