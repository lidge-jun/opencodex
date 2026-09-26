#!/bin/bash
# Queue one text message using Codex's native CLI. No auth/config/app changes.
# A target is required: --thread is preferred; --latest is an explicit heuristic.
# Run with --help for usage. Requires Bash 3.2+ and standard POSIX utilities.
set -euo pipefail

# Print command usage without probing or submitting to Codex.
usage() {
  cat <<'USAGE'
Usage: codex-queue.sh (--thread <id-or-exact-name> | --latest) [options] [<message>]
  --message <text>  Explicit message (also accepts text beginning with a dash)
  --codex <path>    Pin a trusted native CLI; otherwise discover a queue-capable CLI
  --dry-run        Check selection/help without queueing; private values stay hidden
  --show-target    Reveal selection in a local terminal; requires --dry-run
  --               End options; the next argument is the entire message
  --help           Show this help
CODEX_HOME is honored. --latest is global filesystem activity, NOT the active UI chat;
use --latest --dry-run --show-target in a private terminal, then send with --thread <id>.
On-demand only: no enable/disable state, quota polling, auto-send, or routing changes.
USAGE
}

# Print a validation error to stderr and exit with status 2.
fail() { printf '%s\n' "$1" >&2; exit 2; }
THREAD=""; LATEST=0; MESSAGE=""; MESSAGE_SET=0; DRY_RUN=0; SHOW_TARGET=0
CODEX_EXE="${CODEX_EXE:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --thread|--message|--codex)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a nonempty value"
      case "$1" in
        --thread) [ -z "$THREAD" ] || fail "--thread was supplied twice"; THREAD="$2" ;;
        --message) [ "$MESSAGE_SET" -eq 0 ] || fail "message was supplied twice"; MESSAGE="$2"; MESSAGE_SET=1 ;;
        --codex) CODEX_EXE="$2" ;;
      esac
      shift 2 ;;
    --thread=*|--message=*|--codex=*)
      value="${1#*=}"
      [ -n "$value" ] || fail "option requires a nonempty value"
      case "$1" in
        --thread=*) [ -z "$THREAD" ] || fail "--thread was supplied twice"; THREAD="$value" ;;
        --message=*) [ "$MESSAGE_SET" -eq 0 ] || fail "message was supplied twice"; MESSAGE="$value"; MESSAGE_SET=1 ;;
        --codex=*) CODEX_EXE="$value" ;;
      esac
      shift ;;
    --latest) LATEST=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --show-target) SHOW_TARGET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    --)
      shift
      [ "$#" -eq 1 ] && [ "$MESSAGE_SET" -eq 0 ] || fail "supply exactly one message after --"
      MESSAGE="$1"; MESSAGE_SET=1; shift ;;
    -*) fail "unknown option (use --message or -- before a dash-prefixed message)" ;;
    *)
      [ "$MESSAGE_SET" -eq 0 ] || fail "message was supplied twice"
      MESSAGE="$1"; MESSAGE_SET=1; shift ;;
  esac
done
[ -n "$THREAD" ] || [ "$LATEST" -eq 1 ] || fail "choose --thread <id-or-exact-name> or explicitly opt in with --latest"
[ -z "$THREAD" ] || [ "$LATEST" -eq 0 ] || fail "--thread and --latest are mutually exclusive"
[ "$DRY_RUN" -eq 1 ] || [ -n "$MESSAGE" ] || fail "a nonempty message is required"
if [ "$SHOW_TARGET" -eq 1 ]; then
  [ "$DRY_RUN" -eq 1 ] || fail "--show-target requires --dry-run"
  [ -t 1 ] && [ -t 2 ] || fail "--show-target requires a local terminal, not redirected output"
fi
CODEX_HOME_DIR="${CODEX_HOME:-${HOME:?HOME is required}/.codex}"

# Read every NUL-delimited path before selecting: no ls batches, SIGPIPE, or
# partial result on a failed scan. Do not follow symlinked session directories.
# Print the first UUID from the newest recognized rollout in CODEX_HOME/sessions;
# break modification-time ties by path, and fail if the scan cannot select one.
resolve_latest_thread() (
  local sessions="$CODEX_HOME_DIR/sessions" paths candidate latest="" latest_id="" name
  local uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
  local pattern="^rollout-.+-($uuid)(_$uuid)?\\.jsonl$"
  [ -d "$sessions" ] || fail "no sessions directory under the effective CODEX_HOME"
  paths=$(mktemp 2>/dev/null) || fail "could not create temporary session listing"
  trap 'rm -f -- "$paths"' EXIT
  find "$sessions" -type f -name 'rollout-*.jsonl' -print0 > "$paths" 2>/dev/null || fail "session scan failed; refusing a partial selection"
  while IFS= read -r -d '' candidate; do
    name="${candidate##*/}"
    [[ "$name" =~ $pattern ]] || continue
    if [[ -z "$latest" || "$candidate" -nt "$latest" ]] ||
       { [[ ! "$latest" -nt "$candidate" ]] && [[ "$candidate" > "$latest" ]]; }; then
      latest="$candidate"
      latest_id="${BASH_REMATCH[1]}"
    fi
  done < "$paths"
  [ -n "$latest_id" ] || fail "no recognized rollout thread found; specify --thread explicitly"
  printf '%s\n' "$latest_id"
)

# Probe help only: an older CLI can print top-level help with exit 0, so require
# both queue-specific flags. This does not prove the running daemon is compatible.
# Bound the probe like the PowerShell helper's ten-second cap: a hung candidate
# must not stall discovery. No coreutils timeout dependency.
# Return failure for missing executables or failed probes.
supports_queue() {
  local help pid watcher rc
  [ -f "$1" ] && [ -x "$1" ] || return 1
  help=$( { "$1" queue --help 2>/dev/null & pid=$!
    # Detach timer descriptors from the help capture and reap it on cancellation.
    (
      timer=""
      trap 'if [ -n "$timer" ]; then kill "$timer" 2>/dev/null || :; wait "$timer" 2>/dev/null || :; fi' EXIT
      trap 'exit 0' TERM INT
      sleep 10 >/dev/null 2>&1 & timer=$!
      wait "$timer" || exit 0
      kill -KILL "$pid" 2>/dev/null || :
    ) >/dev/null 2>&1 & watcher=$!
    rc=0
    wait "$pid" || rc=$?
    kill "$watcher" 2>/dev/null || :
    wait "$watcher" 2>/dev/null || :
    exit "$rc"; } ) || return 1
  [[ "$help" == *--thread* && "$help" == *--message* ]]
}

# Prefer app bundles over a stale PATH CLI; cover both standalone package layouts.
# Explicit selection is authoritative and never silently falls back to another CLI.
# Print the selected executable path, or fail if no candidate supports queue.
resolve_codex() {
  local candidate directory remaining_path
  if [ -n "$CODEX_EXE" ]; then
    case "$CODEX_EXE" in /*) ;; *) CODEX_EXE="$PWD/$CODEX_EXE" ;; esac
    supports_queue "$CODEX_EXE" || fail "selected CLI does not support queue --thread/--message; check --codex/CODEX_EXE"
    printf '%s\n' "$CODEX_EXE"
    return
  fi
  for candidate in \
    "$HOME/Applications/Codex.app/Contents/Resources/codex" \
    "/Applications/Codex.app/Contents/Resources/codex" \
    "$CODEX_HOME_DIR/packages/standalone/current/bin/codex" \
    "$CODEX_HOME_DIR/packages/standalone/current/codex" \
    "$HOME/.codex/packages/standalone/current/bin/codex" \
    "$HOME/.codex/packages/standalone/current/codex" \
    "$HOME/.codex/bin/codex" "$HOME/.codex/bin"/*/codex; do
    if supports_queue "$candidate"; then printf '%s\n' "$candidate"; return; fi
  done
  # Probe only absolute PATH directories, skipping empty/relative entries.
  # Split only on colon: spaces/newlines stay data. Pin a local CLI explicitly.
  remaining_path="${PATH:-}"
  while :; do
    directory="${remaining_path%%:*}"
    case "$directory" in
      /*)
        candidate="$directory/codex"
        if supports_queue "$candidate"; then printf '%s\n' "$candidate"; return; fi ;;
    esac
    [[ "$remaining_path" == *:* ]] || break
    remaining_path="${remaining_path#*:}"
  done
  fail "no queue-capable Codex CLI found; install/update Codex or specify --codex /path/to/codex"
}

if [ "$LATEST" -eq 1 ]; then
  THREAD=$(resolve_latest_thread)
  printf '%s\n' 'Warning: --latest may select a different project or a subagent, not the foreground chat.' >&2
fi
CODEX_EXE=$(resolve_codex)
if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$SHOW_TARGET" -eq 1 ]; then
    # Explicit local display, never the default diagnostic/captured output.
    # Escape controls so an exact session name cannot inject terminal commands.
    printf 'Codex: %q\nThread: %q\n' "$CODEX_EXE" "$THREAD"
  else
    printf '%s\n' 'Codex: queue-capable CLI (path hidden)' 'Thread: selected (value hidden)'
  fi
  printf '%s\n' 'Dry run only; no message was queued. Daemon/provider health is not checked.'
  exit 0
fi
# Equals-form flags keep dash-prefixed names/text as values. No eval, no retry:
# a failure/timeout can be ambiguous, and a second invocation could duplicate work.
exec "$CODEX_EXE" queue "--thread=$THREAD" "--message=$MESSAGE"
