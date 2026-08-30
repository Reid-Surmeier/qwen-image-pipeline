#!/bin/bash
# Canonical deterministic repository baseline (Issue #18).
#
# Humans, agents, and GitHub Actions all run this same entry point. It must
# stay free of provider credentials, model APIs, ComfyUI generation, and any
# paid or external effect.

set -uo pipefail
if [ "${QWEN_BASELINE_CLEAN_BOOTSTRAP:-}" != "1" ]; then
  exec /usr/bin/env -i QWEN_BASELINE_CLEAN_BOOTSTRAP=1 /bin/bash --noprofile --norc "$0"
fi
export PATH=/usr/bin:/bin

PYTHON_BIN=/usr/bin/python3.12

cd "${0%/*}/.."

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

run_check "module map" "${DETERMINISTIC_RUNNER[@]}" @python scripts/generate_module_map.py --check
run_check "successor governance" "${DETERMINISTIC_RUNNER[@]}" @python scripts/validate_successor_governance.py
run_check "python unit tests" "${DETERMINISTIC_RUNNER[@]}" @python -m unittest discover -s tests
run_check "node tests" "${DETERMINISTIC_RUNNER[@]}" @node --test tests/figma-mcp-client.test.mjs tests/figma-oauth-bootstrap.test.mjs
run_check "control-plane typecheck" "${DETERMINISTIC_RUNNER[@]}" @node node_modules/typescript/bin/tsc -p tsconfig.json
run_check "module seam lint" "${DETERMINISTIC_RUNNER[@]}" @node node_modules/dependency-cruiser/bin/dependency-cruise.mjs --config .dependency-cruiser.cjs modules
run_check "control-plane acceptance" "${DETERMINISTIC_RUNNER[@]}" @node --import tsx --test modules/conductor/conductor.test.ts modules/reference-planning/reference-planning.test.ts modules/run-contract/run-contract.test.ts
run_check "vendored source pins" "${DETERMINISTIC_RUNNER[@]}" @node scripts/vendored-check.mjs
run_check "python compilation" "${DETERMINISTIC_RUNNER[@]}" @python -m compileall -q qwen_ui_pipeline tests scripts
run_check "git diff --check" "${DETERMINISTIC_RUNNER[@]}" @git diff --check

if [ "$failures" -ne 0 ]; then
  echo "verification failed: ${failures} check(s) reported errors" >&2
  exit 1
fi
echo "verification passed"
