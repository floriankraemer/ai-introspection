#!/usr/bin/env bash
# Runs the whole suite in Docker: stack up, seed, three phases of specs, stack down (always).
#   e2e/run.sh            run the suite
#   e2e/run.sh --update   also rewrite the screenshot baselines (make e2e-update)
#
# The phases exist because the app only looks for manual edits of the skills repository at start
# and every 15 minutes: it remembers the repository tip when it first sees it, then records later
# commits. So: wizard -> restart (tip remembered) -> grading and proposals -> manual commit ->
# restart (commit recorded) -> trends, settings, visual.
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

spec 01-first-run
dc restart app && dc up -d --wait app

spec 02-grading 03-improve

# A person edits a skill in the skills repository, outside Introspect.
dc exec -T app sh -c '
  set -e
  cd /repos/skills
  mkdir -p skills/e2e-testing
  printf "# E2E testing\n\nRun the suite before you finish.\n" > skills/e2e-testing/SKILL.md
  git add skills
  git commit -q -m "Add an e2e-testing skill (manual edit)"
'
dc restart app && dc up -d --wait app

spec 04-trends 05-settings 06-visual "${update[@]}"
