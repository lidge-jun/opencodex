#!/usr/bin/env bash
# Decide whether a pull request needs the nine Windows suite shards.
#
# The Windows leg costs nine runners for up to thirty minutes, so ordinary pull
# requests skip it. Before this selector it ran only on a manual lane=all
# dispatch, and #6639, #6556, #6605 and #6606 each landed green while breaking
# Windows; the breakage surfaced days later on a dispatch. A pull request is now
# Windows-sensitive when either:
#   - the changes job's 'windows' path filter matched (PATH_SELECTED=true), or
#   - an ADDED line under src/ or tests/ names a Windows marker (see markers below).
#
# The diff is pull-request content and is treated strictly as data: it goes to a
# file, awk keeps added lines, and grep -F matches fixed strings. Nothing from the
# diff is interpolated into a command, evaluated, or echoed.
#
# Inputs (environment): EVENT_NAME, PATH_SELECTED (true|false), GITHUB_OUTPUT.
# Output: windows=true|false appended to GITHUB_OUTPUT.
# Failure contract: an invalid PATH_SELECTED, a failing git diff, or a grep error
# fails the job. A missing base parent cannot be scanned, so it selects Windows.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
event="${EVENT_NAME:-}"
selected="${PATH_SELECTED:-}"

emit() {
  printf 'windows=%s\n' "$1" >> "$GITHUB_OUTPUT"
  printf 'windows-sensitive: %s (%s)\n' "$1" "$2"
}

case "$selected" in
  true|false) ;;
  *)
    printf '::error::windows path filter output was %q, expected true or false\n' "$selected"
    exit 1
    ;;
esac

if [ "$event" != "pull_request" ]; then
  # Schedule and lane=all dispatch request Windows through the job condition;
  # push never does. The value is informational outside pull requests.
  emit "$selected" "path filter, ${event:-unknown} event"
  exit 0
fi

if [ "$selected" = "true" ]; then
  emit true "path filter"
  exit 0
fi

# actions/checkout puts the pull request's merge commit at HEAD; with
# fetch-depth: 2 its first parent is the base tip, so HEAD^1..HEAD is exactly
# what this pull request changes on top of its base.
if ! git rev-parse --verify --quiet 'HEAD^1^{commit}' >/dev/null; then
  printf '::warning::cannot read the base parent of the merge commit; selecting the Windows leg\n'
  emit true "base parent unavailable"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if ! git -c core.quotepath=off diff --no-ext-diff --no-textconv --no-color --unified=0 \
  'HEAD^1' HEAD -- src tests > "$work/diff"; then
  printf '::error::git diff of the pull request failed\n'
  exit 1
fi
awk 'substr($0, 1, 1) == "+" && substr($0, 1, 3) != "+++" { print substr($0, 2) }' \
  "$work/diff" > "$work/added"

# Fixed strings, matched case-insensitively against added lines only.
cat > "$work/markers" <<'MARKERS'
win32
powershell
pwsh
icacls
schtasks
get-acl
get-ciminstance
process.platform
localappdata
userprofile
MARKERS

status=0
grep -F -i -q -f "$work/markers" "$work/added" || status=$?
case "$status" in
  0) emit true "added line names a Windows marker" ;;
  1) emit false "no Windows path or marker" ;;
  *)
    printf '::error::marker scan failed with status %s\n' "$status"
    exit 1
    ;;
esac
