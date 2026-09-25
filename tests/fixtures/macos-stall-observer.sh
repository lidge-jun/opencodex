#!/usr/bin/env bash
set -euo pipefail
task_root=${1:?fixture directory required}
observer_script=${2:?observer script required}
mkdir -p "$task_root/bin"
cat > "$task_root/bin/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' Darwin
EOF
cat > "$task_root/bin/sleep" <<'EOF'
#!/usr/bin/env bash
if [ "${MODE:-}" = stop ]; then
  printf '%s' "$$" > "$CHILD_FILE"
  exec /bin/sleep 15
fi
if [ "${MODE:-}" = progress ]; then printf '.' >> "$SUITE_LOG"; fi
/bin/sleep 0.02
EOF
cat > "$task_root/bin/ps" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -axo ]; then
  if [ "$MODE" = absent ]; then exit 0; fi
  printf '%s %s %s/bin/bun\n' "$CHILD" "$OWNER" "$GITHUB_WORKSPACE"
  printf '888888 %s %s/helpers/worker\n' "$CHILD" "$HOME"
  if [ "$MODE" = ambiguous ]; then printf '999999 %s /usr/local/bin/bun\n' "$OWNER"; fi
elif [ "$4" = ppid= ]; then
  printf '%s\n' "$OWNER"
else
  n=0
  [ ! -f "$COUNTER" ] || n=$(cat "$COUNTER")
  n=$((n+1)); printf '%s' "$n" > "$COUNTER"
  if [ "$MODE" = progress ] && [ "$n" -gt 8 ]; then printf changed; else printf stable; fi
fi
EOF
cat > "$task_root/bin/sample" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$SAMPLED"
if [ "${MODE:-}" = stop-sample ]; then
  printf '%s' "$$" > "$SAMPLE_CHILD_FILE"
  printf 'partial report %s\n' "$GITHUB_WORKSPACE" > "$4"
  exec /bin/sleep 15
fi
printf 'stdout workspace %s/source/file.ts symbol_name + 42\n' "$GITHUB_WORKSPACE"
printf 'stderr home %s/Library/cache symbol_error + 84\n' "$HOME" >&2
{
  printf 'report workspace %s/build/object.o UUID ABCD symbol_report + 126\n' "$GITHUB_WORKSPACE"
  printf 'report home %s/.cache/object.o\n' "$HOME"
  if [ "${MODE:-}" = oversize ]; then
    prefix_file="$SUITE_LOG.prefix"
    : > "$prefix_file"
    # The observer emits these exact sections before this marker. Derive padding
    # from that content instead of relying on a fixed approximation.
    printf '%s\n' 'sample command output:' >> "$prefix_file"
    printf 'stdout workspace %s/source/file.ts symbol_name + 42\n' '${GITHUB_WORKSPACE}' >> "$prefix_file"
    printf 'stderr home %s/Library/cache symbol_error + 84\n' '${HOME}' >> "$prefix_file"
    printf '%s\n' 'sample report:' >> "$prefix_file"
    printf 'report workspace %s/build/object.o UUID ABCD symbol_report + 126\n' '${GITHUB_WORKSPACE}' >> "$prefix_file"
    printf 'report home %s/.cache/object.o\n' '${HOME}' >> "$prefix_file"
    prefix_bytes=$(wc -c < "$prefix_file")
    padding=$((262144 - prefix_bytes - 8))
    test "$padding" -gt 0
    awk -v count="$padding" 'BEGIN { for (i=0; i<count; i++) printf "x" }'
    printf '%s/private-boundary-tail\n' "$GITHUB_WORKSPACE"
    awk 'BEGIN { for (i=0; i<9000; i++) printf "y" }'
  fi
} > "$4"
EOF
chmod +x "$task_root/bin/"*
export PATH="$task_root/bin:$PATH"
export OWNER=$$ CHILD=$$
export HOME="$task_root/home [literal].*"
export GITHUB_WORKSPACE="$HOME/work space & source"
mkdir -p "$GITHUB_WORKSPACE"
for MODE in silent absent ambiguous progress; do
  export MODE SUITE_LOG="$task_root/$MODE.log" COUNTER="$task_root/$MODE.counter" SAMPLED="$task_root/$MODE.sampled"
  printf start > "$SUITE_LOG"
  bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/$MODE.out" 2>&1
  if [ "$MODE" = silent ]; then
    test "$(cat "$SAMPLED")" = "$CHILD"
    grep -q 'sample command output:' "$task_root/$MODE.out"
    grep -q 'sample report:' "$task_root/$MODE.out"
    grep -q '${GITHUB_WORKSPACE}/source/file.ts symbol_name + 42' "$task_root/$MODE.out"
    grep -q '${HOME}/Library/cache symbol_error + 84' "$task_root/$MODE.out"
    grep -q 'UUID ABCD symbol_report + 126' "$task_root/$MODE.out"
    grep -q "^$CHILD $OWNER bun$" "$task_root/$MODE.out"
    grep -q '^888888 .* worker$' "$task_root/$MODE.out"
    ! grep -Fq "$GITHUB_WORKSPACE" "$task_root/$MODE.out"
    ! grep -Fq "$HOME" "$task_root/$MODE.out"
    test ! -e "$SUITE_LOG.sample"
    test ! -e "$SUITE_LOG.sample-output"
    test ! -e "$SUITE_LOG.sample-redacted"
  else
    test ! -e "$SAMPLED"
  fi
  kill -0 "$OWNER"
  printf 'PASS %s\n' "$MODE"
done

# Empty workspace must never become an empty-string replacement; HOME still redacts.
export MODE=silent GITHUB_WORKSPACE= SUITE_LOG="$task_root/empty.log" COUNTER="$task_root/empty.counter" SAMPLED="$task_root/empty.sampled"
printf start > "$SUITE_LOG"
bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/empty.out" 2>&1
grep -q '${HOME}/Library/cache symbol_error + 84' "$task_root/empty.out"
! grep -q '${GITHUB_WORKSPACE}' "$task_root/empty.out"
printf 'PASS empty-prefix\n'

# The longer known prefix is redacted first when HOME is nested below workspace.
export GITHUB_WORKSPACE="$task_root/reverse root"
export HOME="$GITHUB_WORKSPACE/private home [literal].*"
export MODE=silent SUITE_LOG="$task_root/reverse.log" COUNTER="$task_root/reverse.counter" SAMPLED="$task_root/reverse.sampled"
mkdir -p "$HOME"
printf start > "$SUITE_LOG"
bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/reverse.out" 2>&1
grep -q '${GITHUB_WORKSPACE}/source/file.ts symbol_name + 42' "$task_root/reverse.out"
grep -q '${HOME}/Library/cache symbol_error + 84' "$task_root/reverse.out"
! grep -Fq "$GITHUB_WORKSPACE" "$task_root/reverse.out"
! grep -Fq "$HOME" "$task_root/reverse.out"
printf 'PASS reverse-nesting\n'

# The cap applies after stdout, stderr and report are combined and redacted.
export HOME="$task_root/home [literal].*" GITHUB_WORKSPACE="$task_root/home [literal].*/work space & source"
export MODE=oversize SUITE_LOG="$task_root/oversize.log" COUNTER="$task_root/oversize.counter" SAMPLED="$task_root/oversize.sampled"
printf start > "$SUITE_LOG"
bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/oversize.out" 2>&1
test "$(wc -c < "$task_root/oversize.out")" -le 262300
! grep -Fq "$GITHUB_WORKSPACE" "$task_root/oversize.out"
! grep -Fq "$HOME" "$task_root/oversize.out"
grep -q '\${GITHUB$' "$task_root/oversize.out"
! grep -q 'private-boundary-tail' "$task_root/oversize.out"
printf 'PASS capped-redaction\n'

# TERM during a live diagnostic sleep must reap that child immediately without
# touching the suite/owner. This uses the real shell job table, not fake ps.
export MODE=stop SUITE_LOG="$task_root/stop.log" COUNTER="$task_root/stop.counter" CHILD_FILE="$task_root/stop.child"
printf start > "$SUITE_LOG"
bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/stop.out" 2>&1 &
watcher=$!
for attempt in $(seq 1 200); do
  [ ! -f "$CHILD_FILE" ] || break
  /bin/sleep 0.01
done
test -f "$CHILD_FILE"
diagnostic_child=$(cat "$CHILD_FILE")
kill -TERM "$watcher"
wait "$watcher"
! kill -0 "$diagnostic_child" 2>/dev/null
kill -0 "$OWNER"
test ! -e "$SUITE_LOG.sample"
test ! -e "$SUITE_LOG.sample-output"
test ! -e "$SUITE_LOG.sample-redacted"
printf 'PASS stop\n'

# TERM during the real exec sleep inside sample must still close the Actions
# group on observer stdout and remove both observer-owned diagnostic files.
export MODE=stop-sample SUITE_LOG="$task_root/stop-sample.log" COUNTER="$task_root/stop-sample.counter" \
  SAMPLED="$task_root/stop-sample.sampled" SAMPLE_CHILD_FILE="$task_root/stop-sample.child"
printf start > "$SUITE_LOG"
bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/stop-sample.out" 2>&1 &
watcher=$!
for attempt in $(seq 1 400); do
  [ ! -f "$SAMPLE_CHILD_FILE" ] || break
  /bin/sleep 0.01
done
test -f "$SAMPLE_CHILD_FILE"
diagnostic_child=$(cat "$SAMPLE_CHILD_FILE")
kill -TERM "$watcher"
wait "$watcher"
! kill -0 "$diagnostic_child" 2>/dev/null
kill -0 "$OWNER"
grep -q '^::group::macOS silent-suite diagnostics' "$task_root/stop-sample.out"
grep -q '^::endgroup::$' "$task_root/stop-sample.out"
test ! -e "$SUITE_LOG.sample"
test ! -e "$SUITE_LOG.sample-output"
test ! -e "$SUITE_LOG.sample-redacted"
printf 'PASS stop-sample\n'
