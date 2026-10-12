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

# Every batch runs under a process deadline. GNU timeout provides it on Linux and in Git for
# Windows; the probe runs the exact option shape used below, so a BSD or busybox `timeout` that
# rejects it falls through to the portable deadline instead of failing each batch.
if command -v timeout >/dev/null 2>&1 && timeout --signal=TERM --kill-after=1s 1s true >/dev/null 2>&1; then
  BATCH_DEADLINE=gnu
elif command -v perl >/dev/null 2>&1; then
  BATCH_DEADLINE=portable
  echo "::notice::GNU timeout is unavailable; each batch keeps its ${BATCH_TIMEOUT_SECONDS}s deadline through the portable process-group fallback."
else
  echo "GNU timeout, or perl for the portable fallback, is required to bound Bun test batches." >&2
  exit 69
fi
readonly BATCH_DEADLINE

# Stand-in for `timeout --signal=TERM --kill-after=GRACE SECONDS cmd...` where GNU timeout is
# unavailable (macOS ships none). It keeps the contract the disposition below reads: the command
# leads its own process group, the whole group gets TERM at the deadline and KILL after the grace
# period, and a timed-out run reports 124 -- or 137 when the command itself needed KILL, which is
# what GNU timeout reports because it signals its own group. Unlike GNU it also KILLs group members
# still alive after the command exits on TERM, so a hung batch cannot leave children behind.
run_with_batch_deadline() {
  local seconds="$1"
  local grace="$2"
  shift 2
  local marker child watchdog status=0

  marker="$(mktemp -t ocx-bun-test-deadline.XXXXXX)"
  perl -e 'setpgrp(0, 0) or die "setpgrp: $!\n"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n";' -- "$@" &
  child=$!

  # Output goes to /dev/null so the watchdog never holds the caller's tee pipe open.
  (
    nap=""
    trap '[[ -z "$nap" ]] || kill "$nap" 2>/dev/null; exit 0' TERM
    sleep "$seconds" & nap=$!
    wait "$nap" || exit 0
    nap=""
    kill -0 -- "-$child" 2>/dev/null || exit 0
    echo timeout > "$marker"
    kill -TERM -- "-$child" 2>/dev/null || true
    kill -CONT -- "-$child" 2>/dev/null || true
    waited=0
    while (( waited < grace )) && kill -0 -- "-$child" 2>/dev/null; do
      sleep 1
      waited=$(( waited + 1 ))
    done
    kill -KILL -- "-$child" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  watchdog=$!

  trap 'kill -TERM -- "-$child" 2>/dev/null || true' INT TERM HUP
  # A trapped signal interrupts wait with a status above 128 while the command still runs (or is
  # an unreaped zombie, which kill -0 still sees); wait again for its real status.
  while :; do
    wait "$child" && status=0 || status=$?
    kill -0 "$child" 2>/dev/null || break
  done
  trap - INT TERM HUP

  if [[ -s "$marker" ]]; then
    wait "$watchdog" 2>/dev/null || true
    if (( status == 137 )); then status=137; else status=124; fi
  else
    kill -TERM "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
  rm -f -- "$marker"
  return "$status"
}

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
  if [[ "$BATCH_DEADLINE" == "gnu" ]]; then
    timeout --signal=TERM --kill-after="${BATCH_KILL_GRACE_SECONDS}s" \
      "${BATCH_TIMEOUT_SECONDS}s" \
      "$BUN_BIN" test --isolate ${PARALLEL_ARG:+"$PARALLEL_ARG"} --timeout 60000 "${files[@]}" 2>&1 | tee "$log_file"
  else
    run_with_batch_deadline "$BATCH_TIMEOUT_SECONDS" "$BATCH_KILL_GRACE_SECONDS" \
      "$BUN_BIN" test --isolate ${PARALLEL_ARG:+"$PARALLEL_ARG"} --timeout 60000 "${files[@]}" 2>&1 | tee "$log_file"
  fi
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

# Shard ownership by recorded duration.
#
# Sorted round-robin split the suite evenly by COUNT, while file durations differ by three orders
# of magnitude: one Linux shard carried 394 s of tests and another 248 s (run 35816902207). Each
# file now weighs the milliseconds recorded for it in scripts/ci/test-durations.tsv, and the
# heaviest file goes first to the least-loaded shard, lowest index on a tie. A file the table does
# not know weighs the table's median, so with no usable table every file weighs the same and the
# result is exactly the old sorted round-robin. Every shard computes the whole assignment and
# refuses to run unless it covers every general file exactly once, because a shard that silently
# drops files is the one failure here that stays green. Each shard still runs its files in sorted
# order. Refresh the table with scripts/ci/test-durations.ts from hosted job logs.
batch_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DURATIONS_FILE="${BUN_TEST_DURATIONS_FILE:-$batch_script_dir/test-durations.tsv}"
durations_source="/dev/null"
if [[ -f "$DURATIONS_FILE" ]]; then
  durations_source="$DURATIONS_FILE"
fi

GENERAL_FILES=()
for path in "${ALL_TEST_FILES[@]}"; do
  if is_general_test_file "$path"; then
    GENERAL_FILES+=("$path")
  fi
done
if (( ${#GENERAL_FILES[@]} == 0 )); then
  echo "No tests selected for shard ${SHARD_SPEC}." >&2
  exit 1
fi

# The median of the recorded milliseconds; any constant would do for an empty table.
fallback_ms="$(
  awk -F '\t' '{ sub(/\r$/, "") } !/^#/ && NF == 2 && $1 ~ /^[0-9]+$/ { print $1 }' "$durations_source" \
    | LC_ALL=C sort -n \
    | awk '{ values[NR] = $1 } END { value = (NR > 0 ? values[int((NR + 1) / 2)] : 1000); print (value > 0 ? value : 1) }'
)"
readonly FALLBACK_MS="$fallback_ms"

assignment_file="$(mktemp -t ocx-bun-test-shards.XXXXXX)"
printf '%s\n' "${GENERAL_FILES[@]}" \
  | awk -F '\t' -v table="$durations_source" -v fallback="$FALLBACK_MS" '
      BEGIN {
        while ((getline line < table) > 0) {
          sub(/\r$/, "", line)
          if (line ~ /^#/ || split(line, field, "\t") != 2 || field[1] !~ /^[0-9]+$/) continue
          weight[field[2]] = (field[1] > 0 ? field[1] : 1)
        }
        close(table)
      }
      { print (($0 in weight) ? weight[$0] : fallback) "\t" $0 }
    ' \
  | LC_ALL=C sort -t $'\t' -k1,1nr -k2,2 \
  | awk -F '\t' -v shards="$SHARD_COUNT" '
      BEGIN { for (shard = 1; shard <= shards; shard += 1) load[shard] = 0 }
      {
        best = 1
        for (shard = 2; shard <= shards; shard += 1) if (load[shard] < load[best]) best = shard
        load[best] += $1
        print best "\t" $1 "\t" $2
      }
    ' > "$assignment_file"
assigned_count="$(awk 'END { print NR }' "$assignment_file")"
if (( assigned_count != ${#GENERAL_FILES[@]} )); then
  rm -f -- "$assignment_file"
  echo "Shard assignment covered ${assigned_count} of ${#GENERAL_FILES[@]} test files; refusing to run a partial suite." >&2
  exit 1
fi

SELECTED_FILES=()
SELECTED_WEIGHTS=()
predicted_ms=0
while IFS=$'\t' read -r owner weight path; do
  if [[ "$owner" == "$SHARD_INDEX" ]]; then
    SELECTED_FILES+=("$path")
    SELECTED_WEIGHTS+=("$weight")
    predicted_ms=$((predicted_ms + weight))
  fi
done < <(LC_ALL=C sort -t $'\t' -k3,3 "$assignment_file")
rm -f -- "$assignment_file"

if (( ${#SELECTED_FILES[@]} == 0 )); then
  echo "No tests selected for shard ${SHARD_SPEC}." >&2
  exit 1
fi

# Keep shard ownership and sorted execution order; split only the process boundary. A batch also
# closes before its predicted duration would pass half the process timeout: balancing by duration
# changes which files share a process, and without this bound one twelve-file batch was predicted
# at 89 of its 120 seconds. A file heavier than the budget still runs, alone.
readonly BATCH_BUDGET_MS=$(( BATCH_TIMEOUT_SECONDS * 1000 / 2 ))
BATCH_STARTS=()
BATCH_LENGTHS=()
pending_start=0
pending_count=0
pending_ms=0
for ((index = 0; index < ${#SELECTED_FILES[@]}; index += 1)); do
  if is_serial_test_file "${SELECTED_FILES[$index]}"; then
    if (( pending_count > 0 )); then
      BATCH_STARTS+=("$pending_start"); BATCH_LENGTHS+=("$pending_count")
      pending_count=0
    fi
    BATCH_STARTS+=("$index"); BATCH_LENGTHS+=(1)
  else
    weight="${SELECTED_WEIGHTS[$index]}"
    if (( pending_count > 0 && pending_ms + weight > BATCH_BUDGET_MS )); then
      BATCH_STARTS+=("$pending_start"); BATCH_LENGTHS+=("$pending_count")
      pending_count=0
    fi
    if (( pending_count == 0 )); then pending_start=$index; pending_ms=0; fi
    pending_count=$((pending_count + 1))
    pending_ms=$((pending_ms + weight))
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
echo "Predicted shard time from recorded durations: $((predicted_ms / 1000))s; a file without a record weighs ${FALLBACK_MS}ms and a batch closes before ${BATCH_BUDGET_MS}ms."
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
