// lib/review-methods.js — review techniques & software-engineering methods
// baked into the LLM prompts and the deterministic checks.
// Every finding must cite file:line + the exact evidence (the added line),
// and must never claim an API/behaviour that is not visible in the diff or
// the supplied file context. This is the checklist the judge pass enforces.
//
// Review depth (config `reviews.depth`, UI selector, API `depth`):
//   quick    -> deterministic checks only, no deep analysis, no LLM plan
//   standard -> checks + deterministic deep analysis (taint, breaking,
//               migration, deps, perf, a11y/i18n, blast radius)
//   deep     -> standard + architecture impact on every PR, docs drift,
//               test-coverage gaps, and cross-file tracing even without LLM
'use strict';

const REVIEW_DEPTHS = ['quick', 'standard', 'deep'];

const TECHNIQUES = [
  { id: 'line-by-line', name: 'Line-by-line review', what: 'Read every added/changed line, not just the shape of the diff.' },
  { id: 'cross-file', name: 'Cross-file / blast-radius tracing', what: 'Follow callers and callees of every changed function; a changed return type or signature breaks downstream code. In deep mode this runs deterministically on every PR, even without an LLM.' },
  { id: 'architecture-impact', name: 'Architecture impact', what: 'Which modules, contracts, data flows and invariants does this change affect? A change to a shared module, a public contract, or a data model has systemic consequences — say them in deep mode on every PR.' },
  { id: 'data-flow', name: 'Data-flow / taint analysis', what: 'Trace user input from entry point to sink (DB, shell, eval, HTML). Untrusted data must be validated/sanitised before use. A source and a sink in the same change is a finding even if the exact variable is not traced.' },
  { id: 'control-flow', name: 'Control-flow analysis', what: 'Check branches, loops, early returns, and error paths — including the paths that only run on failure.' },
  { id: 'security-owasp', name: 'Security — OWASP Top 10', what: 'Injection (SQL/NoSQL/command), broken auth, sensitive-data exposure, XSS, SSRF, insecure deserialisation, misconfiguration, vulnerable deps, logging failures.' },
  { id: 'security-secrets', name: 'Security — secrets & auth', what: 'Hardcoded keys/tokens/passwords, weak auth checks, missing authorisation on new endpoints, session handling.' },
  { id: 'performance', name: 'Performance', what: 'N+1 queries, loops over large collections, repeated work in hot paths, unbounded allocations, missing pagination, sync I/O in request handlers, sync calls inside loops.' },
  { id: 'correctness', name: 'Correctness', what: 'Off-by-one, null/undefined dereference, race conditions, timezones, integer/float edge cases, error handling that swallows failures.' },
  { id: 'maintainability', name: 'Maintainability — SOLID, DRY, KISS, YAGNI', what: 'Single responsibility, no duplication, simplest solution that works, no speculative generality, clear naming, low complexity.' },
  { id: 'testability', name: 'Testability — TDD & edge cases', what: 'Is the new code testable? Are edge cases (empty input, max size, failure) covered? Does the PR add or update tests? A changed function with no test touching it is a coverage gap (deep mode).' },
  { id: 'api-compat', name: 'API / backward compatibility', what: 'Renamed/removed exports, changed response shapes, changed defaults, changed function signatures — anything that breaks existing callers. A removed export with no shim is a breaking change.' },
  { id: 'db-migration', name: 'DB / migration safety', what: 'Destructive migrations (DROP, DELETE without WHERE), missing indexes on new queries, index builds that lock the table, data-loss risk, rollback plan.' },
  { id: 'deps', name: 'Dependency risk', what: 'New/changed dependencies: unpinned (latest/*) versions, known-vulnerable patterns, a dependency that duplicates one already in the tree.' },
  { id: 'a11y', name: 'Accessibility / UI', what: 'Images without alt, clickable divs/spans, inputs without labels, focus and keyboard access, colour-only meaning.' },
  { id: 'i18n', name: 'Internationalisation', what: 'Hardcoded user-facing strings, date/number/currency formatting that assumes one locale.' },
  { id: 'docs-drift', name: 'Docs drift', what: 'Public behaviour changed but no docs/comments updated in the same PR. In deep mode this is a finding, not a hint.' },
  { id: 'docs', name: 'Docs & comments', what: 'Public behaviour changes need docs; comments must explain why, not what.' },
];

// Prompt block injected into Pass A so the model reviews with these lenses.
const METHODS_PROMPT = `Review with these lenses, in order of importance:
1. Security (OWASP Top 10): injection, broken auth, secrets, XSS, SSRF, insecure deserialisation, vulnerable dependencies.
2. Correctness: off-by-one, null/undefined, race conditions, swallowed errors, edge cases.
3. Cross-file impact + architecture impact: trace every changed function to its callers; say which modules, contracts and data flows are affected. A changed return type, signature, or shared module is a systemic change.
4. Data-flow / taint: follow untrusted input to its sink (DB, shell, eval, HTML); it must be validated before use. A source and a sink in the same change is a finding.
5. Performance: N+1 queries (a query inside a loop), unbounded queries (no LIMIT), sync calls inside loops, hot loops, missing pagination.
6. Maintainability: SOLID, DRY, KISS, YAGNI, naming, complexity.
7. Testability: is it testable, are edge cases covered, are tests added? Flag a changed function with no test as a coverage gap.
8. API/backward compatibility: removed/renamed exports and changed signatures are breaking changes unless a shim exists.
9. DB/migration safety: DROP, DELETE without WHERE, index builds that lock, rollback plan.
10. Dependency risk, accessibility, i18n, and docs drift (public behaviour changed with no docs updated).
RULES: cite file and line for every finding and quote the exact evidence (the added line). Never claim an API or behaviour you cannot see in the diff or context. If you are not sure, say so with low confidence — do not guess.`;

// Deep-mode prompt block injected into Pass B (summary) in deep depth.
const DEEP_PROMPT = `In deep mode, also produce: architecture impact (modules touched, contracts broken, data flows affected, invariants at risk — 3-5 bullets, only from the diff), blast radius (every changed function and its callers, from the code graph), and any docs-drift or test-coverage gaps (changed public functions with no docs/tests in the PR). Put these in the summary JSON as "architectureImpact" (string) and "deepNotes" (array of strings).`;

function evidenceFor(finding, files) {
  const f = (files || []).find((x) => x.path === finding.file);
  if (!f) return '';
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add' && l.newLine === finding.line) return l.content;
    }
  }
  return '';
}

function normaliseDepth(v, fallback = 'standard') {
  return REVIEW_DEPTHS.includes(v) ? v : fallback;
}

module.exports = { TECHNIQUES, METHODS_PROMPT, DEEP_PROMPT, REVIEW_DEPTHS, normaliseDepth, evidenceFor };
