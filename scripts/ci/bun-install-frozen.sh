#!/usr/bin/env bash
# Frozen-lockfile install with a per-attempt deadline and one total budget.
#
# A registry or runner stall can leave `bun install` printing only its banner until the job's
# timeout cancels the run, which reads as a failed check unrelated to the change under test.
# Each attempt therefore runs under a process deadline, and only an attempt that the deadline
# killed is retried. Any other failure, such as a lockfile that no longer matches, fails at once.
# All directories share one total budget, so retries end well inside the shortest job timeout
# that calls this (5 minutes) and leave time for setup, the GUI build and the tests.
#
# Usage: bash scripts/ci/bun-install-frozen.sh [dir ...]   (default: the current directory)
set -euo pipefail

readonly ATTEMPT_SECONDS="${BUN_INSTALL_ATTEMPT_SECONDS:-45}"
readonly TOTAL_SECONDS="${BUN_INSTALL_TOTAL_SECONDS:-150}"
readonly MIN_ATTEMPT_SECONDS="${BUN_INSTALL_MIN_ATTEMPT_SECONDS:-5}"
readonly KILL_GRACE_SECONDS="${BUN_INSTALL_KILL_GRACE_SECONDS:-5}"
readonly MAX_ATTEMPTS="${BUN_INSTALL_MAX_ATTEMPTS:-3}"
readonly BUN_INSTALL_BIN="${BUN_INSTALL_BIN:-bun}"

if ! command -v timeout >/dev/null 2>&1 || ! timeout --signal=TERM --kill-after=1s 1s true >/dev/null 2>&1; then
  echo "::error::GNU timeout is required to bound bun install." >&2
  exit 69
fi

install_dir() {
  local dir="$1" attempt status remaining deadline
  # Never empty: macOS ships bash 3.2, where expanding an empty array under `set -u` aborts
  # with "unbound variable".
  local -a install_cmd=("$BUN_INSTALL_BIN" install --frozen-lockfile)
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    # The kill grace counts against the budget too, so the worst case stays at TOTAL_SECONDS.
    remaining=$(( TOTAL_SECONDS - SECONDS - KILL_GRACE_SECONDS ))
    if (( remaining < MIN_ATTEMPT_SECONDS )); then
      echo "::error::bun install --frozen-lockfile in ${dir} has no time left in its ${TOTAL_SECONDS}s budget."
      return 124
    fi
    deadline=$(( remaining < ATTEMPT_SECONDS ? remaining : ATTEMPT_SECONDS ))
    status=0
    (cd "$dir" && timeout --signal=TERM --kill-after="${KILL_GRACE_SECONDS}s" "${deadline}s" \
      "${install_cmd[@]}") || status=$?
    if [[ $status -eq 0 ]]; then return 0; fi
    # 124: the deadline fired and the install exited on TERM; 137: it needed the KILL.
    if [[ $status -ne 124 && $status -ne 137 ]]; then
      echo "::error::bun install --frozen-lockfile failed in ${dir} (exit ${status}); not retrying."
      return "$status"
    fi
    echo "::warning::bun install --frozen-lockfile in ${dir} exceeded ${deadline}s (attempt ${attempt}/${MAX_ATTEMPTS})."
    # A killed install may have extracted bun but not finished its trusted postinstall.
    # Plain install can then report success while leaving bin/bun.exe a placeholder.
    install_cmd=("$BUN_INSTALL_BIN" install --frozen-lockfile --force)
  done
  echo "::error::bun install --frozen-lockfile in ${dir} exceeded its deadline ${MAX_ATTEMPTS} times."
  return 124
}

if [[ $# -eq 0 ]]; then set -- .; fi
for dir in "$@"; do install_dir "$dir"; done
