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
  printf '%s %s /usr/local/bin/bun\n' "$CHILD" "$OWNER"
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
printf 'fixture stack sample\n' > "$4"
EOF
chmod +x "$task_root/bin/"*
export PATH="$task_root/bin:$PATH"
export OWNER=$$ CHILD=$$
for MODE in silent absent ambiguous progress; do
  export MODE SUITE_LOG="$task_root/$MODE.log" COUNTER="$task_root/$MODE.counter" SAMPLED="$task_root/$MODE.sampled"
  printf start > "$SUITE_LOG"
  bash "$observer_script" "$OWNER" "$SUITE_LOG" > "$task_root/$MODE.out" 2>&1
  if [ "$MODE" = silent ]; then
    test "$(cat "$SAMPLED")" = "$CHILD"
    grep -q 'fixture stack sample' "$task_root/$MODE.out"
  else
    test ! -e "$SAMPLED"
  fi
  kill -0 "$OWNER"
  printf 'PASS %s\n' "$MODE"
done

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
printf 'PASS stop\n'
