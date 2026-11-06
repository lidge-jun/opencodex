#!/usr/bin/env bash
# Pull-request fast lane (`test changed` in ci.yml).
#
# Runs only the test files Bun's parsed import graph reaches from this pull
# request's diff, against the merge commit's first parent (the base tip). The
# four full Ubuntu shards are skipped on such a pull request; the manual dev
# dispatch after each merged batch (MAINTAINERS.md "Batched merges") and the
# nightly schedule are the backstop for dependencies the graph cannot follow.
#
# A diff that reaches no test file is not a failure here: `gates` already
# typechecked and linted it, and scripts/test.ts reports that case as an error
# only so a local run does not mistake "nothing selected" for "tested".
set -euo pipefail

# One runner instead of four shards: allow a wide selection up to 25 minutes.
export OCX_TEST_MAIN_TIMEOUT_MS="${OCX_TEST_MAIN_TIMEOUT_MS:-1500000}"

base="$(git rev-parse --verify --quiet 'HEAD^1^{commit}' || true)"
if [ -z "$base" ]; then
  echo "::error::run-changed-tests.sh needs the merge commit's first parent; check out with fetch-depth: 2." >&2
  exit 1
fi
echo "changed selection against ${base}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# storage-policy and api-usage keep their own fresh-process jobs (see ci.yml);
# keep them out of this shared pool for the same reason the shards do.
set +e
bun scripts/test.ts "--changed=${base}" \
  --path-ignore-patterns='**/api-storage-policy*.test.ts' \
  --path-ignore-patterns='**/api-storage.test.ts' \
  --path-ignore-patterns='**/api-usage.test.ts' 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
set -e

if [ "$status" -ne 0 ] && grep -Eq 'no test files are affected|selected 0 tests across 0 files|No tests found!' "$log" \
  && ! grep -Eq '^\s*[1-9][0-9]* fail\b' "$log"; then
  echo "::notice::No test file imports a changed module. gates covered this pull request; the batched dev run is the backstop."
  status=0
fi

# Read-as-data guards the import graph never selects. The file-size ratchet is
# the one that most often goes red only after two green pull requests merge.
if ! bun scripts/test.ts ./tests/ci-workflows/file-size-ratchet.test.ts; then
  status=1
fi

exit "$status"
