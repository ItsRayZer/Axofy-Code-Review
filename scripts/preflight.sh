#!/usr/bin/env bash
# AxoReview preflight: detect available tools and the project stack.
# Read-only. No network calls, no installs. Run from the project root.
# Output: JSON on stdout. Tell the user which capability level (L0-L3) applies.

have() { command -v "$1" >/dev/null 2>&1 && echo true || echo false; }
exists() { [ -e "$1" ] && echo true || echo false; }
json_list() { local out="" x; for x in "$@"; do out="${out}\"${x}\","; done; echo "[${out%,}]"; }

stack=()
[ -f package.json ] && stack+=(node)
{ [ -f requirements.txt ] || [ -f pyproject.toml ] || [ -f Pipfile ]; } && stack+=(python)
[ -f go.mod ] && stack+=(go)
[ -f Cargo.toml ] && stack+=(rust)
{ [ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ]; } && stack+=(jvm)
[ -f Gemfile ] && stack+=(ruby)
[ -f composer.json ] && stack+=(php)
ls ./*.csproj >/dev/null 2>&1 && stack+=(dotnet)
{ [ -f Dockerfile ] || [ -f docker-compose.yml ] || [ -f compose.yaml ]; } && stack+=(docker)
ls ./*.tf >/dev/null 2>&1 && stack+=(terraform)

frameworks=()
if [ -f package.json ]; then
  for fw in next react vue svelte angular express fastify nestjs nuxt astro vite remix; do
    grep -q "\"$fw\"" package.json 2>/dev/null && frameworks+=("$fw")
  done
fi
for fw in django flask fastapi; do
  grep -qis "$fw" requirements.txt pyproject.toml 2>/dev/null && frameworks+=("$fw")
done

scripts=""
[ -f package.json ] && scripts=$(grep -E '"(test|build|dev|start|lint|typecheck|e2e)"[[:space:]]*:' package.json | tr -d '\n' | sed 's/"/\\"/g')

tests_dir=false
for d in test tests __tests__ spec e2e cypress playwright; do [ -d "$d" ] && tests_dir=true; done

playwright_ready=false
if [ -d node_modules/playwright ] || [ -d node_modules/@playwright ]; then playwright_ready=true; fi

level="L0"
if [ "$(have bash)" = true ] && [ "$(have git)" = true ]; then level="L1"; fi
if [ "$level" = "L1" ] && { [ "$(have npx)" = true ] || [ "$(have python3)" = true ]; } && [ "$playwright_ready" = true ]; then level="L2"; fi

cat <<EOF
{
  "git_repo": $(git rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo true || echo false),
  "branch": "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)",
  "dirty": $([ -n "$(git status --porcelain 2>/dev/null)" ] && echo true || echo false),
  "stack": $(json_list "${stack[@]}"),
  "frameworks": $(json_list "${frameworks[@]}"),
  "package_scripts": "$scripts",
  "has_tests_dir": $tests_dir,
  "tools": {
    "git": $(have git), "node": $(have node), "npm": $(have npm), "pnpm": $(have pnpm),
    "yarn": $(have yarn), "npx": $(have npx), "python3": $(have python3), "pip": $(have pip),
    "go": $(have go), "cargo": $(have cargo), "java": $(have java), "mvn": $(have mvn),
    "gradle": $(have gradle), "docker": $(have docker), "curl": $(have curl), "jq": $(have jq)
  },
  "scanners": {
    "semgrep": $(have semgrep), "gitleaks": $(have gitleaks), "trufflehog": $(have trufflehog),
    "trivy": $(have trivy), "osv-scanner": $(have osv-scanner), "checkov": $(have checkov),
    "hadolint": $(have hadolint), "shellcheck": $(have shellcheck), "bandit": $(have bandit),
    "actionlint": $(have actionlint), "zap-baseline": $(have zap-baseline.py)
  },
  "browser_testing": { "playwright_installed": $playwright_ready, "cypress_config": $(exists cypress.config.js) },
  "capability_level": "$level",
  "level_meaning": {
    "L0": "read-only: no shell, review by reading code, runtime items UNVERIFIED",
    "L1": "shell + git: can run tests, linters, scanners; no browser clicks",
    "L2": "L1 + browser automation: can crawl and click the running app",
    "L3": "L2 + staging URL and test accounts (set manually after asking the user)"
  }
}
EOF
