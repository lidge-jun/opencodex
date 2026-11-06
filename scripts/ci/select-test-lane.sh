#!/usr/bin/env bash
# Choose a pull request's test lane (changes.outputs.fast in ci.yml).
#
# fast=true: the pull request runs `gates` plus `test changed` (the tests Bun's
# import graph reaches from the diff) instead of the four full Ubuntu shards.
# Merged batches are verified by a manual dev dispatch (MAINTAINERS.md
# "Batched merges"). fast=false keeps the four shards. It is false on every
# event other than pull_request, on an out-of-scope pull request, when the
# pull request carries the `ci:full` label, and when the diff touches an input
# the import graph cannot follow (the harness itself, golden fixtures read as
# data, the toolchain or the dependency set).
#
# Inputs (environment): EVENT_NAME, CI_SCOPE (true|false), FULL_LABEL
# (true|false), GITHUB_OUTPUT. The diff is treated strictly as data.
# Failure contract: invalid inputs or a failing git diff fail the job; a
# missing base parent cannot be scanned, so it selects the full lane.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
event="${EVENT_NAME:-}"

emit() {
  printf 'fast=%s\n' "$1" >> "$GITHUB_OUTPUT"
  printf 'test lane: %s (%s)\n' "$([ "$1" = true ] && echo fast || echo full)" "$2"
  if [ "$event" = "pull_request" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    if [ "$1" = "true" ]; then
      printf '**Fast test lane**: gates + `test changed`. Add the `ci:full` label and push to run the four full shards.\n' >> "$GITHUB_STEP_SUMMARY"
    else
      printf '**Full test lane** (%s).\n' "$2" >> "$GITHUB_STEP_SUMMARY"
    fi
  fi
}

if [ "$event" != "pull_request" ]; then
  emit false "event ${event:-unset} keeps the full suite"
  exit 0
fi

for pair in "CI_SCOPE=${CI_SCOPE:-}" "FULL_LABEL=${FULL_LABEL:-}"; do
  case "${pair#*=}" in
    true|false) ;;
    *)
      printf '::error::%s was %q, expected true or false\n' "${pair%%=*}" "${pair#*=}"
      exit 1
      ;;
  esac
done

if [ "$CI_SCOPE" != "true" ]; then
  emit false "out of the ci scope"
  exit 0
fi
if [ "$FULL_LABEL" = "true" ]; then
  emit false "ci:full label"
  exit 0
fi
if ! git rev-parse --verify --quiet 'HEAD^1^{commit}' >/dev/null; then
  emit false "no base parent to diff"
  exit 0
fi

changed="$(mktemp)"
trap 'rm -f "$changed"' EXIT
git diff --name-only 'HEAD^1' HEAD -- > "$changed"

# Anchored extended regexes over repository-relative paths.
full_lane_paths='^(\.github/(workflows|actions|scripts)/|scripts/ci/|scripts/test(\.ts$|-[^/]*\.ts$)|tests/preload\.ts$|tests/fixtures/|bunfig\.toml$|tsconfig\.json$|package\.json$|bun\.lock$|gui/package\.json$|gui/bun\.lock$)'
status=0
grep -Eq "$full_lane_paths" "$changed" || status=$?
case "$status" in
  0)
    emit false "harness, fixture, toolchain or dependency change"
    exit 0
    ;;
  1) ;;
  *)
    echo "::error::grep failed while selecting the test lane (exit $status)" >&2
    exit 1
    ;;
esac

emit true "import-graph selection"
