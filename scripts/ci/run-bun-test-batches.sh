#!/usr/bin/env bash
set -euo pipefail

readonly SHARD_SPEC="${1:-}"
readonly BATCH_SIZE="${BUN_TEST_BATCH_SIZE:-12}"
readonly BATCH_TIMEOUT_SECONDS="${BUN_TEST_BATCH_TIMEOUT_SECONDS:-120}"
readonly BATCH_KILL_GRACE_SECONDS="${BUN_TEST_BATCH_KILL_GRACE_SECONDS:-15}"
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
if ! command -v timeout >/dev/null 2>&1; then
  echo "GNU timeout is required to bound Bun test batches." >&2
  exit 69
fi

is_general_test_file() {
  local path="$1"

  case "$path" in
    # Dedicated CI jobs run these in their own Bun process (ci.yml storage-policy / api-usage).
    # Match by basename at any depth so the exclusion survives the tests/ domain layout.
    */api-storage-policy*.test.ts|*/api-storage.test.ts|*/api-usage.test.ts)
      return 1
      ;;
  esac

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
  local attempt="$3"
  shift 3
  local -a files=("$@")
  local log_file
  local status
  local label="shard ${SHARD_SPEC} batch ${batch_number}/${TOTAL_BATCHES}"

  if [[ -n "$phase" ]]; then
    label+=" ${phase}"
  fi

  log_file="$(mktemp -t ocx-bun-test-batch.XXXXXX)"

  echo "::group::${label} attempt ${attempt} (${#files[@]} files)"
  printf '  %s\n' "${files[@]}"

  set +e
  timeout --signal=TERM --kill-after="${BATCH_KILL_GRACE_SECONDS}s" \
    "${BATCH_TIMEOUT_SECONDS}s" \
    "$BUN_BIN" test --isolate --timeout 60000 "${files[@]}" 2>&1 | tee "$log_file"
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
    echo "::warning::Bun test process timed out after ${BATCH_TIMEOUT_SECONDS}s in ${label} (attempt ${attempt})."
    rm -f -- "$log_file"
    return "$status"
  fi

  if is_bun_runtime_crash "$status" "$log_file"; then
    LAST_FAILURE_KIND="runtime"
    echo "::warning::Bun runtime crash in ${label} (exit ${status}, attempt ${attempt})."
    rm -f -- "$log_file"
    return "$status"
  fi

  LAST_FAILURE_KIND="test"
  echo "::error::Test failure in ${label} (exit ${status}); not retrying assertion/test failures."
  rm -f -- "$log_file"
  return "$status"
}

recover_batch_file_by_file() {
  local batch_number="$1"
  local batch_failure_kind="$2"
  shift 2
  local -a files=("$@")
  local file
  local file_index=0
  local status
  local retry_kind

  echo "::warning::Shard ${SHARD_SPEC} batch ${batch_number} hit a ${batch_failure_kind}; rerunning its ${#files[@]} files one at a time in fresh Bun processes."

  for file in "${files[@]}"; do
    ((file_index += 1))
    if run_test_once "$batch_number" "singleton ${file_index}/${#files[@]}" 1 "$file"; then
      continue
    else
      status=$?
    fi

    if [[ "$LAST_FAILURE_KIND" != "runtime" && "$LAST_FAILURE_KIND" != "timeout" ]]; then
      echo "::error::Singleton isolation identified ${file} as a failing test file."
      return "$status"
    fi

    retry_kind="$LAST_FAILURE_KIND"
    echo "Retrying ${file} once in another fresh Bun process after ${retry_kind} failure..."
    if run_test_once "$batch_number" "singleton ${file_index}/${#files[@]}" 2 "$file"; then
      echo "::warning::${file} passed on its single ${retry_kind} retry."
      continue
    else
      status=$?
    fi

    if [[ "$LAST_FAILURE_KIND" == "timeout" ]]; then
      echo "::error::${file} timed out twice under singleton isolation; failing after one retry."
    elif [[ "$LAST_FAILURE_KIND" == "runtime" ]]; then
      echo "::error::Bun runtime crash repeated for ${file} under singleton isolation; failing after one retry."
    else
      echo "::error::${file} failed during singleton retry."
    fi
    return "$status"
  done

  if [[ "$batch_failure_kind" == "runtime" ]]; then
    # Not "recovered". One file per process is a configuration in which this class of defect
    # cannot occur, so the sweep was always going to pass and always going to report nothing.
    # What it does prove is that the files themselves are sound, which is the half worth keeping.
    echo "::error::Shard ${SHARD_SPEC} batch ${batch_number} crashed the Bun runtime. Every file in it then passed alone, so the defect is in multi-file process state, not in any test."
  else
    echo "::warning::Shard ${SHARD_SPEC} batch ${batch_number} passed under singleton isolation after the original ${batch_failure_kind}; continuing."
  fi
  return 0
}

mapfile -d '' -t ALL_TEST_FILES < <(
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

readonly TOTAL_BATCHES=$(( (${#SELECTED_FILES[@]} + BATCH_SIZE - 1) / BATCH_SIZE ))
echo "Shard ${SHARD_SPEC}: ${#SELECTED_FILES[@]} files in ${TOTAL_BATCHES} primary Bun processes (batch size <= ${BATCH_SIZE}, timeout ${BATCH_TIMEOUT_SECONDS}s)."
echo "Timeouts fall back to one-file-per-process isolation and may recover; assertion/test failures do not retry."
echo "A Bun runtime crash is swept one-file-per-process for attribution and then FAILS this shard: it is a defect in the interpreter, and a green report would be a lie."

# Every batch that crashed the runtime, so one run attributes all of them instead of only the
# first. Linux was producing twelve to fourteen of these per run while reporting success.
CRASHED_BATCHES=()

for ((batch_index = 0; batch_index < TOTAL_BATCHES; batch_index += 1)); do
  start=$(( batch_index * BATCH_SIZE ))
  batch=("${SELECTED_FILES[@]:start:BATCH_SIZE}")
  batch_number=$(( batch_index + 1 ))

  if run_test_once "$batch_number" "" 1 "${batch[@]}"; then
    continue
  else
    status=$?
  fi

  if [[ "$LAST_FAILURE_KIND" != "runtime" && "$LAST_FAILURE_KIND" != "timeout" ]]; then
    exit "$status"
  fi

  failure_kind="$LAST_FAILURE_KIND"
  if recover_batch_file_by_file "$batch_number" "$failure_kind" "${batch[@]}"; then
    recovery_status=0
  else
    recovery_status=$?
  fi

  if [[ "$failure_kind" == "runtime" ]]; then
    CRASHED_BATCHES+=("$batch_number")
  fi

  # A sweep that found a real failing file still reports that file, and immediately.
  if (( recovery_status != 0 )); then
    exit "$recovery_status"
  fi
done

if (( ${#CRASHED_BATCHES[@]} > 0 )); then
  echo "::error::Shard ${SHARD_SPEC} crashed the Bun runtime in batch(es): ${CRASHED_BATCHES[*]}. Each batch was re-run one file per process and every file passed, so no test is at fault -- the interpreter is. Failing rather than reporting green."
  exit 1
fi
