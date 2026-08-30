#!/usr/bin/env bash
# Canonical deterministic repository baseline (Issue #18).
#
# Humans, agents, and GitHub Actions all run this same entry point. It must
# stay free of provider credentials, model APIs, ComfyUI generation, and any
# paid or external effect.

set -uo pipefail

PYTHON_BIN=python3.12
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN=python3
fi

cd "$(dirname "$0")/.."

DETERMINISTIC_RUNNER=("$PYTHON_BIN" scripts/run_deterministic_command.py --)

failures=0

run_check() {
  local name="$1"
  shift
  echo "==> ${name}"
  if "$@"; then
    echo "==> ${name}: ok"
  else
    echo "==> ${name}: FAILED" >&2
    failures=$((failures + 1))
  fi
}

run_check "successor governance" "${DETERMINISTIC_RUNNER[@]}" "$PYTHON_BIN" scripts/validate_successor_governance.py
run_check "python unit tests" "${DETERMINISTIC_RUNNER[@]}" "$PYTHON_BIN" -m unittest discover -s tests
run_check "node tests" "${DETERMINISTIC_RUNNER[@]}" node --test tests/figma-mcp-client.test.mjs tests/figma-oauth-bootstrap.test.mjs
run_check "python compilation" "${DETERMINISTIC_RUNNER[@]}" "$PYTHON_BIN" -m compileall -q qwen_ui_pipeline tests scripts
run_check "git diff --check" "${DETERMINISTIC_RUNNER[@]}" git diff --check

if [ "$failures" -ne 0 ]; then
  echo "verification failed: ${failures} check(s) reported errors" >&2
  exit 1
fi
echo "verification passed"
