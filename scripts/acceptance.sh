#!/usr/bin/env bash
# Round-15 acceptance gate — run from repo root.
# Every command's exit code is printed; any failure aborts with non-zero.
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
FAIL=0

run() {
  local name="$1"; shift
  echo "==> $name"
  "$@"
  local code=$?
  echo "    exit=$code"
  if [ "$code" -ne 0 ]; then FAIL=1; fi
}

run "build"                     npm run build
run "typecheck (all workspaces)" npm run typecheck
run "unit tests (akp-codec)"    npm run test -w packages/akp-codec
run "unit tests (core)"         npm run test -w packages/core
run "acceptance + e2e (simulator)" npm run test -w packages/simulator
run "app tests (DOM + HID)"     npm run test -w app
run "firmware static check"     node scripts/firmware-static-check.mjs
run "generic unknown Raw HID zero-write test" npx tsx scripts/unknown-rawhid-readonly-test.ts
run "dev smoke"                 bash -c 'cd app && ../node_modules/.bin/electron . --smoke-test'
run "dev UI smoke"              bash -c 'cd app && ../node_modules/.bin/electron . --ui-smoke-test'
run "dual-launch (dev)"         bash scripts/dual-launch-test.sh dev

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ACCEPTANCE ALL PASS"
else
  echo "ACCEPTANCE FAILED"
  exit 1
fi
