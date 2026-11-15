<!-- AxoReview: copy of methods/security-privacy-audit.md — source of truth is methods/, edit there, not here. -->

# Security and privacy audit

Contents: 1 Authorization and scope · 2 Threat model · 3 Scanner stack ·
4 Web/app checklist · 5 Privacy audit · 6 Hardening · 7 Verification ·
8 What this cannot cover

Use only on systems the user owns or is authorized to test. Prefer staging.
Never attack third-party services. Use synthetic data and redact secrets in
all output.

## 1. Authorization and scope

Before active testing, confirm in writing (in chat is fine): target
environment, whether live or staging, allowed tools, off-limits systems,
and test accounts. Passive code review and local scanning need no network.
DAST (dynamic scanning) runs only against targets the user confirms.

## 2. Threat model (short, per app)

List assets (accounts, payments, personal data, secrets, uptime, IP), actors
(anonymous, user, admin, insider, compromised dependency, automated bot),
entry points (inventory from `functional-qa.md`), trust boundaries, and top
abuse cases. Apply STRIDE per boundary. Rank by impact and likelihood. Use it
to decide where to go deepest.

## 3. Scanner stack (run what exists, report what did not run)

| Area | Tools |
|---|---|
| SAST | Semgrep, CodeQL, Bandit, gosec, Brakeman, SpotBugs, ESLint security plugins |
| Secrets | Gitleaks, TruffleHog (include git history) |
| Dependencies / SCA | OSV-Scanner, `npm audit`, `pip-audit`, `cargo audit`, Trivy, Dependabot data |
| Licenses | license-checker, ScanCode, `pip-licenses` |
| IaC / containers | Checkov, tfsec/Trivy, Hadolint, kube-linter, `trivy image` |
| CI | actionlint, zizmor |
| DAST (authorized) | OWASP ZAP baseline/full scan, Nuclei (safe templates), Nikto |
| TLS / headers | testssl.sh, securityheaders-style checks, `curl -I` |
| API | Schemathesis, ZAP API scan, authz test matrix |
| Mobile | MobSF (if applicable) |
| SBOM | Syft/CycloneDX, signed provenance if available |

Triage scanner output by reading flagged code: confirm reachability and
exploitability, then label true positive, false positive (with reason), or
accepted risk (with owner and expiry). Do not suppress without a reason.

## 4. Web and app security checklist (verify, do not assume)

**Authentication:** strong password hashing (Argon2id/bcrypt/scrypt), no
plaintext or reversible storage; MFA support; rate limiting and lockout; secure
reset flow (single-use, short-lived tokens, no enumeration); session IDs
rotated on login; logout invalidates server-side; token expiry and refresh
handling; no secrets in URLs.

**Authorization:** server-side checks on every request; per-object checks
(prevent IDOR); role checks cannot be bypassed by client changes; default
deny; admin routes protected; multi-tenant isolation; mass-assignment
protection.

**Input and output:** validation on the server; parameterized queries; output
encoding per context; safe file handling; SSRF protections (allowlists, no
internal address access); safe deserialization; request size limits; ReDoS-safe
patterns.

**Session and browser:** cookies `HttpOnly`, `Secure`, `SameSite`; CSRF
protection; CORS restricted; CSP strict (no broad `unsafe-inline`/`unsafe-eval`
where avoidable); HSTS; `X-Content-Type-Options`; frame protections
(`frame-ancestors`); Referrer-Policy; Permissions-Policy; no sensitive data in
`localStorage` when avoidable; Subresource Integrity for third-party scripts.

**Transport and crypto:** TLS 1.2+ only, valid certificates, no mixed content;
modern ciphers; secrets generated with CSPRNG; no hard-coded keys; key
rotation plan; encryption at rest for sensitive data; secrets in a secrets
manager, not in repo, images, client bundles, or logs.

**Errors, logging, monitoring:** generic errors to users, details in logs; no
stack traces or secrets in responses; audit logging for auth and sensitive
actions; no PII or secrets in logs; alerting on anomalies; rate limits and
abuse controls on expensive or sensitive endpoints.

**Dependencies and supply chain:** lockfiles committed; pinned versions;
known-vulnerable packages upgraded; unused packages removed; install scripts
reviewed; CI actions pinned to SHAs; least-privilege CI tokens; reproducible
builds where feasible; signed artifacts if available.

**Infrastructure:** least-privilege IAM; no public buckets/DBs; network
segmentation; security groups minimal; default credentials removed; patched
base images; non-root containers; resource limits; backups and restore tested.

**Business logic:** price/quantity tampering, coupon and referral abuse, race
conditions on balances and inventory, workflow step skipping, replay of
requests, trust of client-supplied totals or roles, email/SMS bombing, scraping
and enumeration.

**LLM/AI features (if present):** prompt injection from any untrusted content;
tool permissions minimized; human approval for destructive actions; output
validated before use or render; no secrets in prompts; data sent to model
providers is documented and minimized; rate and cost limits.

## 5. Privacy audit

1. **Data inventory:** every personal or sensitive field collected (name,
   email, phone, address, IP, device IDs, location, payment, health,
   credentials, biometrics, children's data), where it is collected, stored,
   logged, cached, backed up, and exported.
2. **Data-flow map:** source -> processing -> storage -> third parties
   (analytics, ads, error tracking, email, payments, CDNs, LLM providers,
   support tools). Flag any flow to a party not disclosed in the privacy
   policy.
3. **Minimization and retention:** collect only what is needed; documented
   retention; deletion and anonymization actually implemented, including
   backups, logs, and third-party copies.
4. **Consent and controls:** cookie/consent banner behavior matches code
   (no non-essential trackers before consent); opt-out and withdrawal work;
   user data export and deletion paths exist and are tested.
5. **Protection:** encryption in transit and at rest; access limited by role;
   pseudonymization where possible; no PII in URLs, analytics events, logs,
   error reports, or screenshots.
6. **Third-party and client exposure:** inspect the built bundle and network
   traffic for secrets, tokens, and PII sent to third parties; verify SDK
   defaults (many collect more than intended).
7. **Policy consistency:** compare code reality against the privacy policy and
   terms; list mismatches.

State clearly that legal compliance (GDPR, CCPA, HIPAA, PCI DSS, COPPA) needs
qualified legal and compliance review. Provide a gap list, not a legal opinion.

## 6. Hardening workflow (`harden`)

1. Rank open findings by exploitability and impact.
2. Fix at the root cause: central validation, authorization middleware,
   safe-by-default helpers, secure config; avoid one-off patches.
3. Add regression tests that reproduce the attack and assert it fails.
4. Add defense in depth: headers, CSP, rate limits, input limits, least
   privilege, secrets management, dependency pinning, CI scanning gates.
5. Secrets found in code or history: rotate first, then remove; history
   rewrite only with user approval; add a pre-commit secret scan.
6. Add continuous guardrails: CI jobs for SAST, SCA, secrets, IaC, container,
   and DAST on staging; automated dependency updates; `SECURITY.md` with a
   disclosure path.

## 7. Verification

- Re-run every scanner and confirm findings are closed (not just hidden).
- Re-run the attack reproducers and confirm they now fail.
- Run the full functional suite to catch regressions.
- Diff the final inventory and dependency tree against the start.
- Produce the assurance report with: tools run and versions, findings by
  severity (open, fixed, accepted), evidence links, residual risk, and what
  was out of scope.

## 8. What this cannot cover

Say this in every report. Automated review and scanning cannot prove the
absence of vulnerabilities. Out of reach without human experts or other
processes: novel zero-days, complex business-logic abuse, social engineering,
physical and insider threats, third-party and cloud provider flaws, runtime
misconfiguration you cannot observe, regulatory compliance sign-off, and
production behavior under real attack. For high-stakes systems (payments,
health, identity, infrastructure), recommend an independent penetration test
and a formal security and privacy review before launch.
