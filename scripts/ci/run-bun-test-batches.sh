#!/usr/bin/env bash
set -euo pipefail

readonly SHARD_SPEC="${1:-}"
readonly BATCH_SIZE="${BUN_TEST_BATCH_SIZE:-12}"
readonly BATCH_TIMEOUT_SECONDS="${BUN_TEST_BATCH_TIMEOUT_SECONDS:-120}"
readonly BATCH_KILL_GRACE_SECONDS="${BUN_TEST_BATCH_KILL_GRACE_SECONDS:-15}"
readonly TEST_FILE_SCOPE="${BUN_TEST_FILE_SCOPE:-general}"
readonly TEST_PARALLEL="${BUN_TEST_PARALLEL:-}"
readonly PARALLEL_ARG="${TEST_PARALLEL:+--parallel=$TEST_PARALLEL}"
# Runtime under test. Defaults to whatever `bun` PATH resolves to; the Bun 1.4
# qualification lane sets OPENCODEX_BUN_PATH so the batches actually execute on
# the candidate binary. Without this the lane would export an override, run the
# bundled stable runtime anyway, and report a qualification it never performed.
readonly BUN_BIN="${OPENCODEX_BUN_PATH:-bun}"

# One definition of the crash classifier, shared with the Windows and macOS legs in ci.yml.
# shellcheck source=scripts/ci/bun-crash-signatures.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bun-crash-signatures.sh"

usage() {
  echo "usage: $0 <shard/total>" >&2
  exit 64
}

if [[ ! "$SHARD_SPEC" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]]; then
  usage
fi

readonly SHARD_INDEX="${BASH_REMATCH[1]}"
readonly SHARD_COUNT="${BASH_REMATCH[2]}"

if (( SHARD_INDEX > SHARD_COUNT )); then
  usage
fi
if [[ ! "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_BATCH_SIZE must be a positive integer, got: $BATCH_SIZE" >&2
  exit 64
fi
if [[ ! "$BATCH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_BATCH_TIMEOUT_SECONDS must be a positive integer, got: $BATCH_TIMEOUT_SECONDS" >&2
  exit 64
fi
if [[ ! "$BATCH_KILL_GRACE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_BATCH_KILL_GRACE_SECONDS must be a positive integer, got: $BATCH_KILL_GRACE_SECONDS" >&2
  exit 64
fi
if [[ "$TEST_FILE_SCOPE" != "general" && "$TEST_FILE_SCOPE" != "all" ]]; then
  echo "BUN_TEST_FILE_SCOPE must be general or all, got: $TEST_FILE_SCOPE" >&2
  exit 64
fi
if [[ -n "$TEST_PARALLEL" && ! "$TEST_PARALLEL" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUN_TEST_PARALLEL must be a positive integer" >&2
  exit 64
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "GNU timeout is required to bound Bun test batches." >&2
  exit 69
fi

is_general_test_file() {
  local path="$1"

  if [[ "$TEST_FILE_SCOPE" == "general" ]]; then
    case "$path" in
      # Dedicated Linux CI jobs run these in their own Bun process (ci.yml storage-policy /
      # api-usage). Windows sets scope=all because its manual platform leg has always covered
      # the full suite and batching must not silently shrink that platform contract.
      # Match by basename at any depth so the exclusion survives the tests/ domain layout.
      */api-storage-policy*.test.ts|*/api-storage.test.ts|*/api-usage.test.ts)
        return 1
        ;;
    esac
  fi

  case "$path" in
    *.test.js|*.test.jsx|*.test.ts|*.test.tsx|*_test.js|*_test.jsx|*_test.ts|*_test.tsx|*.spec.js|*.spec.jsx|*.spec.ts|*.spec.tsx|*_spec.js|*_spec.jsx|*_spec.ts|*_spec.tsx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

LAST_FAILURE_KIND=""

run_test_once() {
  local batch_number="$1"
  local phase="$2"
  shift 2
  local -a files=("$@")
  local log_file
  local status
  local label="shard ${SHARD_SPEC} batch ${batch_number}/${TOTAL_BATCHES}"

  if [[ -n "$phase" ]]; then
    label+=" ${phase}"
  fi

  log_file="$(mktemp -t ocx-bun-test-batch.XXXXXX)"

  echo "::group::${label} (${#files[@]} files)"
  printf '  %s\n' "${files[@]}"

  set +e
  timeout --signal=TERM --kill-after="${BATCH_KILL_GRACE_SECONDS}s" \
    "${BATCH_TIMEOUT_SECONDS}s" \
    "$BUN_BIN" test --isolate ${PARALLEL_ARG:+"$PARALLEL_ARG"} --timeout 60000 "${files[@]}" 2>&1 | tee "$log_file"
  status="${PIPESTATUS[0]}"
  set -e

  echo "::endgroup::"

  if (( status == 0 )); then
    LAST_FAILURE_KIND=""
    rm -f -- "$log_file"
    return 0
  fi

  if (( status == 124 )); then
    LAST_FAILURE_KIND="timeout"
    echo "::warning::Bun test process timed out after ${BATCH_TIMEOUT_SECONDS}s in ${label}."
    rm -f -- "$log_file"
    return "$status"
  fi

  if is_bun_runtime_crash "$status" "$log_file"; then
    LAST_FAILURE_KIND="runtime"
    echo "::warning::Bun runtime crash in ${label} (exit ${status})."
    rm -f -- "$log_file"
    return "$status"
  fi

  LAST_FAILURE_KIND="test"
  echo "::error::Test failure in ${label} (exit ${status}); not retrying assertion/test failures."
  rm -f -- "$log_file"
  return "$status"
}

# Attribution, never disposition.
#
# This runs only after the shard has already failed, and nothing it prints can change that.
# One file per process removes precisely the conditions that produce a batch failure of this
# class -- batch concurrency, shared process state, resource pressure -- so a clean sweep was
# always going to be clean and was always going to report nothing. Reading that as a recovery
# is how twelve to fourteen Linux segfaults per run were reported green from 2026-09-08.
#
# It is kept because the half that IS informative survives: a human reading the log learns
# whether any single file reproduces the failure alone. The function returns success in every
# case on purpose; its caller has already decided to fail.
attribute_batch_file_by_file() {
  local batch_number="$1"
  local batch_failure_kind="$2"
  shift 2
  local -a files=("$@")
  local file
  local file_index=0
  local reproduced=""

  echo "::warning::Shard ${SHARD_SPEC} batch ${batch_number} hit a ${batch_failure_kind} and has already failed this shard; rerunning its ${#files[@]} files one at a time for attribution only."

  for file in "${files[@]}"; do
    ((file_index += 1))
    if run_test_once "$batch_number" "attribution ${file_index}/${#files[@]}" "$file"; then
      continue
    fi

    echo "::error::Attribution: ${file} reproduces alone (${LAST_FAILURE_KIND})."
    reproduced+="${file} (${LAST_FAILURE_KIND}) "
  done

  if [[ -n "$reproduced" ]]; then
    echo "::error::Shard ${SHARD_SPEC} batch ${batch_number}: file(s) that reproduce alone: ${reproduced% }"
  else
    echo "::error::Shard ${SHARD_SPEC} batch ${batch_number}: every file passed alone, so the ${batch_failure_kind} lives in multi-file process state, not in any single test."
  fi
}

serial_manifest="$("$BUN_BIN" -e 'import { SERIAL_FULL_SUITE_FILES } from "./scripts/test.ts"; console.log(SERIAL_FULL_SUITE_FILES.join("\n"));')"
[[ -n "$serial_manifest" ]] || { echo 'Empty isolated test manifest' >&2; exit 1; }
SERIAL_FILES=()
while IFS= read -r file; do
  if [[ ! "$file" =~ ^[[:alnum:]_./-]+$ || "$file" == /* || "/$file/" == *"/../"* || "/$file/" == *"/./"* || ! -f "tests/$file" ]]; then
    echo 'Invalid or missing isolated test path' >&2; exit 1
  fi
  for ((entry_index = 0; entry_index < ${#SERIAL_FILES[@]}; entry_index += 1)); do
    [[ "${SERIAL_FILES[$entry_index]}" != "$file" ]] || { echo 'Duplicate isolated test path' >&2; exit 1; }
  done
  SERIAL_FILES+=("$file")
done <<< "$serial_manifest"

is_serial_test_file() {
  local entry
  # Dedicated worker-heavy families remain isolated when an unsharded platform
  # control selects all files rather than delegating them to Linux-only jobs.
  case "$1" in
    */api-storage-policy*.test.ts|*/api-storage.test.ts|*/api-usage.test.ts) return 0 ;;
  esac
  for entry in "${SERIAL_FILES[@]}"; do
    [[ "$1" != "tests/$entry" ]] || return 0
  done
  return 1
}

ALL_TEST_FILES=()
while IFS= read -r -d '' path; do
  ALL_TEST_FILES+=("$path")
done < <(
  find tests -type f -print0 \
    | LC_ALL=C sort -z
)

SELECTED_FILES=()
general_index=0
for path in "${ALL_TEST_FILES[@]}"; do
  if ! is_general_test_file "$path"; then
    continue
  fi

  if (( general_index % SHARD_COUNT == SHARD_INDEX - 1 )); then
    SELECTED_FILES+=("$path")
  fi
  ((general_index += 1))
done

if (( ${#SELECTED_FILES[@]} == 0 )); then
  echo "No tests selected for shard ${SHARD_SPEC}." >&2
  exit 1
fi

# Keep shard ownership and sorted execution order; split only the process boundary.
BATCH_STARTS=()
BATCH_LENGTHS=()
pending_start=0
pending_count=0
for ((index = 0; index < ${#SELECTED_FILES[@]}; index += 1)); do
  if is_serial_test_file "${SELECTED_FILES[$index]}"; then
    if (( pending_count > 0 )); then
      BATCH_STARTS+=("$pending_start"); BATCH_LENGTHS+=("$pending_count")
      pending_count=0
    fi
    BATCH_STARTS+=("$index"); BATCH_LENGTHS+=(1)
  else
    if (( pending_count == 0 )); then pending_start=$index; fi
    ((pending_count += 1))
    if (( pending_count == BATCH_SIZE )); then
      BATCH_STARTS+=("$pending_start"); BATCH_LENGTHS+=("$pending_count")
      pending_count=0
    fi
  fi
done
if (( pending_count > 0 )); then
  BATCH_STARTS+=("$pending_start"); BATCH_LENGTHS+=("$pending_count")
fi
readonly TOTAL_BATCHES=${#BATCH_STARTS[@]}
echo "Shard ${SHARD_SPEC}: ${#SELECTED_FILES[@]} files in ${TOTAL_BATCHES} primary Bun processes (scope ${TEST_FILE_SCOPE}, batch size <= ${BATCH_SIZE}, timeout ${BATCH_TIMEOUT_SECONDS}s)."
echo "Nothing here is retried. A test failure, a process timeout and a Bun runtime crash each fail this shard on their first occurrence."
echo "A timeout or a crash is additionally swept one file per process for attribution, after the shard has already failed; that sweep cannot turn it green."

for ((batch_index = 0; batch_index < TOTAL_BATCHES; batch_index += 1)); do
  start=${BATCH_STARTS[$batch_index]}
  length=${BATCH_LENGTHS[$batch_index]}
  batch=("${SELECTED_FILES[@]:start:length}")
  batch_number=$(( batch_index + 1 ))

  if run_test_once "$batch_number" "" "${batch[@]}"; then
    continue
  else
    status=$?
  fi

  failure_kind="$LAST_FAILURE_KIND"
  # A test failure is already attributed by Bun's own output; there is nothing to sweep.
  if [[ "$failure_kind" != "runtime" && "$failure_kind" != "timeout" ]]; then
    exit "$status"
  fi

  # The shard is red from this line onwards. A process timeout is a batch that never
  # finished, and a Bun panic is process death a user would have seen; running the same
  # files again in a configuration that cannot reproduce either one is not evidence that
  # they did not happen. Sweep for attribution, then fail with the original status.
  echo "::error::Shard ${SHARD_SPEC} batch ${batch_number} ${failure_kind} failure (exit ${status}). This shard has failed; the sweep below only attributes it."
  attribute_batch_file_by_file "$batch_number" "$failure_kind" "${batch[@]}"
  exit "$status"
done
