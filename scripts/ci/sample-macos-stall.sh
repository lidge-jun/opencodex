#!/usr/bin/env bash
# Observe a silent suite; never signal it, retry it, or change its exit status.
set -u
owner=${1:?owning shell pid required}
suite_log=${2:?suite log required}
case "$owner" in ''|*[!0-9]*) exit 64 ;; esac
[ "$(uname -s)" = Darwin ] || exit 0
owner_started=$(ps -p "$owner" -o lstart= 2>/dev/null) || exit 0
[ -n "$owner_started" ] || exit 0
observer_child=
stop_requested=0
sample_path=
group_open=0
stop_observer() {
  # Only the observer's current sleep/sample child is owned here; never the suite.
  if [ -n "$observer_child" ] && jobs -pr | grep -qx "$observer_child"; then
    # The shell's still-running child job is the ownership handle. Unlike comm,
    # that handle does not change when the forked child execs sleep or sample.
    kill "$observer_child" 2>/dev/null || true
    wait "$observer_child" 2>/dev/null || true
  fi
  [ -z "$sample_path" ] || [ ! -f "$sample_path" ] || rm "$sample_path"
  [ "$group_open" -eq 0 ] || echo "::endgroup::"
  exit 0
}
# A trap only records intent: cleanup occurs after the child job PID is captured,
# never in the spawn/assignment gap or with a reaped PID left over from an old child.
trap 'stop_requested=1' TERM INT
run_observer_child() {
  "$@" &
  observer_child=$!
  [ "$stop_requested" -eq 0 ] || stop_observer
  wait "$observer_child" || true
  [ "$stop_requested" -eq 0 ] || stop_observer
  observer_child=
}
last_bytes=$(wc -c < "$suite_log") || exit 0
quiet=0
while kill -0 "$owner" 2>/dev/null; do
  run_observer_child sleep 15
  [ "$stop_requested" -eq 0 ] || stop_observer
  [ "$(ps -p "$owner" -o lstart= 2>/dev/null)" = "$owner_started" ] || exit 0
  [ -f "$suite_log" ] || continue
  bytes=$(wc -c < "$suite_log") || exit 0
  if [ "$bytes" != "$last_bytes" ]; then
    last_bytes=$bytes
    quiet=0
    continue
  fi
  quiet=$((quiet + 15))
  [ "$quiet" -ge 60 ] || continue

  # Identify only the direct Bun child of the owning step shell. comm excludes
  # argv/environment, which could contain fixture credentials or request bodies.
  processes=$(ps -axo pid=,ppid=,comm=) || exit 0
  candidates=$(printf '%s\n' "$processes" | awk -v owner="$owner" '$2 == owner && $NF ~ /(^|\/)bun$/ { print $1 }')
  count=$(printf '%s\n' "$candidates" | awk 'NF { n++ } END { print n+0 }')
  if [ "$count" -ne 1 ]; then
    echo "::warning::macOS suite silent for ${quiet}s; direct Bun owner ambiguous (${count} candidates); no sampling"
    exit 0
  fi
  suite_pid=$candidates
  suite_started=$(ps -p "$suite_pid" -o lstart= 2>/dev/null) || exit 0
  [ -n "$suite_started" ] || exit 0
  echo "::group::macOS silent-suite diagnostics (${quiet}s without output)"
  group_open=1
  printf '%s\n' "$processes" | awk -v root="$suite_pid" '
    { pid[NR]=$1; parent[NR]=$2; row[NR]=$0 }
    END {
      owned[root]=1
      for (pass=0; pass<16; pass++) for (i=1; i<=NR; i++) if (owned[parent[i]]) owned[pid[i]]=1
      for (i=1; i<=NR; i++) if (owned[pid[i]]) print row[i]
    }'
  # Request one three-second read-only sample while the suite is still stuck.
  # A successful later run cannot replace this evidence.
  if [ "$(ps -p "$suite_pid" -o ppid= 2>/dev/null | tr -d ' ')" = "$owner" ] &&
     [ "$(ps -p "$suite_pid" -o lstart= 2>/dev/null)" = "$suite_started" ]; then
    sample_path="${suite_log}.sample"
    run_observer_child sample "$suite_pid" 3 -file "$sample_path"
    if [ -f "$sample_path" ]; then
      head -c 262144 "$sample_path"
      rm "$sample_path"
      sample_path=
    fi
  fi
  echo "::endgroup::"
  group_open=0
  exit 0
done
