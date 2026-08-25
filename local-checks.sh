#!/usr/bin/env sh

fail_fast=1
failed_checks=""

usage() {
  cat <<'EOF'
Usage: local-checks.sh [OPTIONS]

Run local quality checks mirroring .github/workflows/ci.yml.

CI runs `npm ci` before these steps; install dependencies first if needed:
  npm ci

Options:
  --no-fail-fast  Continue running all checks even if one fails
  -h, --help      Show this help message
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-fail-fast)
      fail_fast=0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$(dirname "$0")" || exit 1

run_check() {
  name="$1"
  shift

  printf '==> %s\n' "$name"
  if "$@"; then
    return 0
  fi

  failed_checks="${failed_checks}  - ${name}
"
  if [ "$fail_fast" -eq 1 ]; then
    printf '\nCheck failed: %s\n' "$name" >&2
    exit 1
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Checks — mirror .github/workflows/ci.yml (quality job).
# Each line is: run_check "display name" command [args...]
# ---------------------------------------------------------------------------
run_check "typecheck library" npm run typecheck -w @dgillard/cytoscape-compound-graph
run_check "build" npm run build
run_check "test with coverage" npm run test:coverage
run_check "npm audit" npm audit --audit-level=high

if [ -n "$failed_checks" ]; then
  printf '\nThe following checks failed:\n%s' "$failed_checks" >&2
  exit 1
fi

printf '\nAll checks passed.\n'
