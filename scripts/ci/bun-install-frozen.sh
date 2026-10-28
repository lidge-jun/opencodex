#!/usr/bin/env bash
# Frozen-lockfile install with a per-attempt deadline.
#
# A registry or runner stall can leave `bun install` printing only its banner until the job's
# timeout cancels the run, which reads as a failed check unrelated to the change under test.
# Each attempt therefore runs under a process deadline, and only an attempt that the deadline
# killed is retried. Any other failure, such as a lockfile that no longer matches, fails at once.
#
# Usage: bash scripts/ci/bun-install-frozen.sh [dir ...]   (default: the current directory)
set -euo pipefail

readonly ATTEMPT_SECONDS="${BUN_INSTALL_ATTEMPT_SECONDS:-60}"
readonly KILL_GRACE_SECONDS="${BUN_INSTALL_KILL_GRACE_SECONDS:-5}"
readonly MAX_ATTEMPTS="${BUN_INSTALL_MAX_ATTEMPTS:-3}"
readonly BUN_INSTALL_BIN="${BUN_INSTALL_BIN:-bun}"

if ! command -v timeout >/dev/null 2>&1 || ! timeout --signal=TERM --kill-after=1s 1s true >/dev/null 2>&1; then
  echo "::error::GNU timeout is required to bound bun install." >&2
  exit 69
fi

install_dir() {
  local dir="$1" attempt status
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    status=0
    (cd "$dir" && timeout --signal=TERM --kill-after="${KILL_GRACE_SECONDS}s" "${ATTEMPT_SECONDS}s" \
      "$BUN_INSTALL_BIN" install --frozen-lockfile) || status=$?
    if [[ $status -eq 0 ]]; then return 0; fi
    # 124: the deadline fired and the install exited on TERM; 137: it needed the KILL.
    if [[ $status -ne 124 && $status -ne 137 ]]; then
      echo "::error::bun install --frozen-lockfile failed in ${dir} (exit ${status}); not retrying."
      return "$status"
    fi
    echo "::warning::bun install --frozen-lockfile in ${dir} exceeded ${ATTEMPT_SECONDS}s (attempt ${attempt}/${MAX_ATTEMPTS})."
  done
  echo "::error::bun install --frozen-lockfile in ${dir} exceeded its deadline ${MAX_ATTEMPTS} times."
  return 124
}

if [[ $# -eq 0 ]]; then set -- .; fi
for dir in "$@"; do install_dir "$dir"; done
