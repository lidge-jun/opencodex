#!/usr/bin/env bash
# Frozen installs: one witnessed deadline, a shared budget, and no PID-directed cleanup.
# GNU timeout/gtimeout bounds a fixed reader, never the install's own exit status.
# Bootstrap FIFO names disappear before install code runs; this is not a sandbox against
# arbitrary same-user process inspection. Cleanup covers descendants that remain in the group.
set -eu

own_group() {
  local stat state ppid group rest
  if [[ -r /proc/$$/stat ]]; then
    IFS= read -r stat < /proc/$$/stat || return 1
    read -r state ppid group rest <<< "${stat##*) }"
  else
    read -r group <<< "$(ps -o pgid= -p "$$")" || return 1
  fi
  [[ "$group" == "$$" ]]
}

keeper() {
  local boot="$1" timer="$2" grace="$3" dir="$4" deadline token completion rc
  shift 4
  set +m
  own_group || exit 70              # No signal 0 until this process is its group leader.
  trap ':' TERM
  # O_RDWR bootstrap avoids a blocked open if the other endpoint dies during setup.
  exec 6<>"$boot/outcome" 8>"$boot/outcome"
  exec 6>&-
  exec 6<>"$boot/lifeline" 9<"$boot/lifeline"
  exec 6>&-
  printf 'ready %s\n' "$$" >&8
  IFS=' ' read -r -t 5 token deadline <&9 || exit 70
  [[ "$token" == go && "$deadline" =~ ^[1-9][0-9]*$ ]] || exit 70

  # Only the parent owns a lifeline writer. Its death/cancellation is EOF, never a PID kill.
  ( exec 8>&-; trap '' TERM; cat <&9 >/dev/null; kill -TERM 0; sleep 0.2; kill -KILL 0 ) >/dev/null 2>&1 &
  exec 9<&-                         # Only the EOF helper needs the read endpoint now.
  if ! cd "$dir"; then printf 'fail 66\n' >&8; kill -KILL 0; fi
  exec 7>&1
  report_install() {
    local status=0
    exec 8>&-
    # The command gets neither a control descriptor nor the result pipe's writer.
    "$@" >&7 7>&- || status=$?
    printf '%s\n' "$status"
  }
  rc=0
  # The fixed reader exits only 0/70; install 124/137 are pipe data, not timer statuses.
  # Process substitution does not wait for a stalled reporter when the reader times out.
  completion=$("$timer" --foreground "${deadline}s" bash -c '
    IFS= read -r status || exit 70
    [[ "$status" =~ ^(0|[1-9][0-9]{0,2})$ && $status -le 255 ]] || exit 70
    printf "%s" "$status"
  ' < <(report_install "$@") 7>&- 8>&-) || rc=$?
  if [[ $rc -eq 0 ]]; then
    printf 'result %s\n' "$completion" >&8
  elif [[ $rc -eq 124 ]]; then
    printf 'deadline 124\n' >&8
    kill -TERM 0
    sleep "$grace"
  else
    printf 'fail 70\n' >&8
  fi
  # This live process pins the group until its last action, including ordinary success.
  kill -KILL 0
  exit 70
}

if [[ "${1:-}" == --ocx-install-keeper ]]; then shift; keeper "$@"; exit 70; fi

readonly ATTEMPT_SECONDS="${BUN_INSTALL_ATTEMPT_SECONDS:-45}"
readonly TOTAL_SECONDS="${BUN_INSTALL_TOTAL_SECONDS:-150}"
readonly MIN_ATTEMPT_SECONDS="${BUN_INSTALL_MIN_ATTEMPT_SECONDS:-5}"
readonly KILL_GRACE_SECONDS="${BUN_INSTALL_KILL_GRACE_SECONDS:-5}"
readonly MAX_ATTEMPTS="${BUN_INSTALL_MAX_ATTEMPTS:-3}"
readonly BUN_INSTALL_BIN="${BUN_INSTALL_BIN:-bun}"
readonly SCRIPT_PATH="${BASH_SOURCE[0]}"
for value in "$ATTEMPT_SECONDS" "$TOTAL_SECONDS" "$MIN_ATTEMPT_SECONDS" "$KILL_GRACE_SECONDS" "$MAX_ATTEMPTS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ && ${#value} -le 6 ]] || { echo '::error::Invalid install deadline configuration.'; exit 70; }
done
TIMEOUT_BIN=""
for candidate in timeout gtimeout; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --foreground 1s true >/dev/null 2>&1; then
    TIMEOUT_BIN=$(command -v "$candidate"); break
  fi
done
[[ -n "$TIMEOUT_BIN" ]] || { echo '::error::GNU timeout is required to bound bun install.' >&2; exit 69; }

ATTEMPT_VERDICT=fail
ATTEMPT_STATUS=70
run_attempt() {
  local dir="$1" deadline="$2" boot keeper_pid keeper_status=70 tag="" value="" extra=""
  local cancel_status=0 interrupted=no drained=no remaining started=no monitor=no
  shift 2
  boot=$(mktemp -d "${TMPDIR:-/tmp}/ocx-bun-install.XXXXXX") || return 70
  mkfifo "$boot/outcome" "$boot/lifeline" || return 70
  exec 8<>"$boot/outcome" 9<>"$boot/lifeline"
  trap 'cancel_status=143; interrupted=yes; exec 9>&-' TERM
  trap 'cancel_status=130; interrupted=yes; exec 9>&-' INT
  trap 'cancel_status=129; interrupted=yes; exec 9>&-' HUP
  [[ $- == *m* ]] && monitor=yes
  set -m
  bash "$SCRIPT_PATH" --ocx-install-keeper "$boot" "$TIMEOUT_BIN" "$KILL_GRACE_SECONDS" "$dir" "$@" 8>&- 9>&- &
  keeper_pid=$!
  [[ "$monitor" == yes ]] || set +m
  ATTEMPT_VERDICT=fail; ATTEMPT_STATUS=70
  if IFS=' ' read -r -t 5 tag value extra <&8 && [[ "$tag" == ready && "$value" == "$keeper_pid" && -z "$extra" ]]; then
    # After the handshake, unlink every IPC name before permitting any install code.
    if rm "$boot/outcome" "$boot/lifeline" 8>&- 9>&- && rmdir "$boot" 8>&- 9>&-; then
      remaining=$(( TOTAL_SECONDS - SECONDS - KILL_GRACE_SECONDS - 2 ))
      (( remaining < deadline )) && deadline=$remaining
      if (( deadline >= MIN_ATTEMPT_SECONDS && cancel_status == 0 )); then
        if printf 'go %s\n' "$deadline" >&9; then
          started=yes
          tag=""; value=""; extra=""
          if IFS=' ' read -r -t "$(( deadline + KILL_GRACE_SECONDS ))" tag value extra <&8 && [[ -z "$extra" ]]; then
            case "$tag:$value" in
              result:*)
                if [[ "$value" =~ ^(0|[1-9][0-9]{0,2})$ && $value -le 255 ]]; then
                  ATTEMPT_STATUS=$value
                  [[ $value -eq 0 ]] && ATTEMPT_VERDICT=ok
                fi ;;
              deadline:124) ATTEMPT_VERDICT=deadline; ATTEMPT_STATUS=124 ;;
              fail:66) ATTEMPT_STATUS=66 ;;
            esac
          fi
        fi
      else
        ATTEMPT_VERDICT=budget; ATTEMPT_STATUS=124
      fi
    fi
  fi
  # A valid outcome keeps the lifeline open through the keeper's own complete grace cycle.
  if [[ "$ATTEMPT_VERDICT" == fail && $ATTEMPT_STATUS -eq 70 ]] || [[ "$started" == no ]]; then exec 9>&-; fi
  while :; do
    interrupted=no
    keeper_status=0; wait "$keeper_pid" 2>/dev/null || keeper_status=$?
    [[ "$interrupted" == yes ]] || break
  done
  # EOF is not a drain proof. Reuse can cause a conservative failure, never a foreign kill.
  for value in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 -- "-$keeper_pid" 2>/dev/null; then drained=yes; break; fi
    sleep 0.1 8>&- 9>&-
  done
  exec 9>&- 8>&-
  trap - TERM INT HUP
  if [[ -d "$boot" ]]; then
    for value in outcome lifeline; do [[ ! -e "$boot/$value" ]] || rm "$boot/$value"; done
    rmdir "$boot"
  fi
  if (( cancel_status > 0 )); then
    ATTEMPT_VERDICT=cancel; ATTEMPT_STATUS=$cancel_status
  elif [[ "$drained" != yes ]]; then
    ATTEMPT_VERDICT=drain_fail; ATTEMPT_STATUS=70
  elif [[ "$started" == yes && $keeper_status -ne 137 ]]; then
    ATTEMPT_VERDICT=fail; ATTEMPT_STATUS=70
  fi
}

install_dir() {
  local dir="$1" attempt deadline remaining
  # Keep this array nonempty for Bash 3.2 with nounset.
  local -a install_cmd=("$BUN_INSTALL_BIN" install --frozen-lockfile)
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    remaining=$(( TOTAL_SECONDS - SECONDS - KILL_GRACE_SECONDS - 2 ))
    if (( remaining < MIN_ATTEMPT_SECONDS )); then
      echo "::error::bun install --frozen-lockfile in ${dir} has no time left in its ${TOTAL_SECONDS}s budget."
      return 124
    fi
    deadline=$(( remaining < ATTEMPT_SECONDS ? remaining : ATTEMPT_SECONDS ))
    run_attempt "$dir" "$deadline" "${install_cmd[@]}"
    case "$ATTEMPT_VERDICT" in
      ok) return 0 ;;
      cancel) return "$ATTEMPT_STATUS" ;;
      budget) echo "::error::bun install --frozen-lockfile in ${dir} has no time left in its ${TOTAL_SECONDS}s budget."; return 124 ;;
      deadline) echo "::warning::bun install --frozen-lockfile in ${dir} exceeded ${deadline}s (attempt ${attempt}/${MAX_ATTEMPTS})." ;;
      *) echo "::error::bun install --frozen-lockfile failed in ${dir} (exit ${ATTEMPT_STATUS}, ${ATTEMPT_VERDICT}); not retrying."; return "$ATTEMPT_STATUS" ;;
    esac
    install_cmd=("$BUN_INSTALL_BIN" install --frozen-lockfile --force)
  done
  echo "::error::bun install --frozen-lockfile in ${dir} exceeded its deadline ${MAX_ATTEMPTS} times."
  return 124
}
if [[ $# -eq 0 ]]; then set -- .; fi
for dir in "$@"; do install_dir "$dir"; done
