#!/usr/bin/env bash
# Runs the whole suite in Docker: stack up, seed, all specs, stack down (always).
#   e2e/run.sh            run the suite
#   e2e/run.sh --update   also rewrite the screenshot baselines (make e2e-update)
#
# One test phase: the first scan (spec 1) makes the app remember the skills repository tip, the
# manual commit (spec 4) is found by the next scan (POST /v1/trends/scan), no restart needed.
set -euo pipefail
cd "$(dirname "$0")/.."

update=()
[[ "${1:-}" == "--update" ]] && update=(--update-snapshots)

dc() { env UID="$(id -u)" GID="$(id -g)" docker compose -f compose.e2e.yaml "$@"; }
pw() { dc run --rm -T playwright "$@"; }
spec() { pw npx playwright test "$@"; }

cleanup() {
  status=$?
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  echo "e2e: finished in ${SECONDS}s (exit ${status}); traces and failure screenshots: e2e/.work/results"
  exit "${status}"
}
trap cleanup EXIT

# Created as your user: the Docker engine on Linux would create missing mount points as root.
rm -rf e2e/.work
mkdir -p e2e/.work/results e2e/.work/sources/claude/projects e2e/.work/sources/codex/sessions \
  e2e/.work/repos/skills e2e/.work/repos/projects e2e/__screenshots

dc down -v --remove-orphans >/dev/null 2>&1 || true
dc build
dc up -d --wait app

pw node_modules/.bin/tsc --noEmit
pw node seed/seed.ts /work/sources

spec "${update[@]}"
