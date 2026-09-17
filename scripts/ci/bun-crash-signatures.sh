#!/usr/bin/env bash
# The single definition of "this was a Bun runtime crash, not a test result".
#
# There were four copies of this list: one in the Linux batch runner and three inline in ci.yml
# (platform-windows, platform-macos, macos-control). ci-workflows.test.ts pinned them in sync
# rather than removing the duplication, because #2152 had already broken one copy by anchoring on
# `panic(thread 2852)` when Bun also emits `panic(main thread)` for the same class, and half the
# crashes stopped matching. Pinning four copies in sync only detects the drift it was written to
# expect; one definition cannot drift at all.
#
# Source it from the repository root:  source scripts/ci/bun-crash-signatures.sh

# shellcheck shell=bash

# Sourced by nested shells in the same job, so a second source must be a no-op rather than a
# readonly-reassignment error.
if [[ -n "${OCX_BUN_CRASH_SIGNATURES_LOADED:-}" ]]; then
  return 0
fi
OCX_BUN_CRASH_SIGNATURES_LOADED=1

# Never anchor on the thread-numbered form. `Internal assertion failure` is the stable fingerprint
# recorded in devlog/_fin/260731_pr_issue_triage_round/050_windows_ci_flake_rca.md.
OCX_BUN_CRASH_SIGNATURE_PATTERN='oh no: Bun has crashed|Internal assertion failure|Segmentation fault at address|Illegal instruction|Bus error|Aborted \(core dumped\)'

# True when the process output carries a Bun panic banner.
bun_log_has_crash_signature() {
  grep -Eqi "$OCX_BUN_CRASH_SIGNATURE_PATTERN" "$1"
}

# True for a status that can only be a fatal signal.
#
# 128+N for SIGILL/SIGABRT/SIGBUS/SIGKILL/SIGSEGV and neighbours. Windows exit 3 is deliberately
# NOT in this list: it is the status a Windows Bun returns alongside a SIGSEGV panic, but unlike
# 132-139 it is an ordinary small exit code any process may return for its own reasons. Trusting
# it bare would reclassify a real test failure as a crash and hide it, which is the exact mistake
# this file exists to stop. Exit 3 is still covered, through the signature arm below, which is
# corroborated by the panic banner Bun actually printed -- that is how the Windows shard 5/6
# crashes of runs 35087572377, 35093667426 and 35098735960 are recognised.
bun_status_is_crash_code() {
  case "$1" in
    132|133|134|135|136|137|139) return 0 ;;
  esac
  return 1
}

# The shared predicate: is_bun_runtime_crash <exit-status> <log-file>
is_bun_runtime_crash() {
  local status="$1"
  local log_file="$2"

  if bun_status_is_crash_code "$status"; then
    return 0
  fi

  # Bun 1.3.14 can surface a Linux epoll registration failure as exit 1, even though the failure
  # comes from Bun's internal WriteStream setup rather than a test assertion. Treat only that
  # narrow runtime signature as a crash.
  if [[ "$status" == "1" ]] \
    && grep -Fq '# Unhandled error between tests' "$log_file" \
    && grep -Fq 'error: EEXIST: file already exists, epoll_ctl' "$log_file" \
    && grep -Fq 'at new WriteStream (internal:fs/streams:' "$log_file"; then
    return 0
  fi

  bun_log_has_crash_signature "$log_file"
}
