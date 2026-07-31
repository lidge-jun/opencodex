# Phase 4 — replay state disk snapshot (restart resilience)

## Loop-spec
- Archetype: spec-satisfaction repair. Verifier: bun test + tsc + new roundtrip test.
- Trigger: proven in-session — patch → ocx restart → expansion miss → upstream 400
  ("No tool call found ..."). Restart wipes the in-memory Map (state.ts:11).
- Goal: chains survive a proxy restart via best-effort disk snapshot.
- Non-goals: DB, multi-instance coordination, routed-adapter miss behavior.
- Stop: roundtrip test green + full gates green. Outcome: DONE.

## Previous cycle conclusions (LOOP-CONTINUITY-01)
- D(030_done.md): "State store remains in-memory (restart still loses chains); passthrough
  recording narrows the miss window but does not eliminate it." This phase closes that item.
- Orphan sanitizer means a miss now degrades context instead of 400 — snapshot upgrades
  degradation to full continuation.

## Design (diff-level)

### MODIFY src/responses/state.ts
- Imports: `readFileSync`, `existsSync`, `mkdirSync` from node:fs; `join` from node:path;
  `atomicWriteFile`, `getConfigDir` from ../config.
- `const SNAPSHOT_FILE = () => join(getConfigDir(), "responses-state.json")` (lazy — env may
  change in tests via OPENCODEX_HOME).
- `const SNAPSHOT_DEBOUNCE_MS = 2_000;` — debounced async persist:
  `let persistTimer: ReturnType<typeof setTimeout> | null = null;`
  `function schedulePersist(): void` — if timer live, return; else setTimeout(persistNow, 2s).
  Timer `.unref?.()` so it never holds the process open.
- `function persistNow(): void` — try { mkdirSync(getConfigDir(), {recursive:true, mode:0o700});
  atomicWriteFile(SNAPSHOT_FILE(), JSON.stringify({version:1, states:[...states]})) } catch {} —
  best-effort, never throws into hot path. atomicWriteFile already writes mode 0600.
- `let loaded = false;` `function ensureLoaded(): void` — on first touch: readFileSync; JSON.parse;
  validate shape (`version === 1`, Array entries `[string, StoredResponseState]` with numeric
  createdAt + array items); populate Map; pruneResponses(); corrupted/missing file → ignore.
  Called at top of expandPreviousResponseInput, previousResponseConversationId,
  rememberResponseState (before pruning/lookup).
- `rememberResponseState`: after states.set + prune → schedulePersist().
- `clearResponseStateForTests()`: also cancel timer, reset `loaded=false`, and delete the
  snapshot file if present (test isolation), guarded try/catch.
- Optional export `flushResponseStateForTests()` calling persistNow() for deterministic tests.

### src/server.ts
- No change needed: lazy ensureLoaded on first state access covers startup (no init hook).

## Tests (tests/responses-state.test.ts, new describe "snapshot persistence")
- Use `process.env.OPENCODEX_HOME = mkdtempSync(...)` per test; restore after.
- Roundtrip: remember → flush → clearResponseStateForTests KEEPING file (need a memory-only
  clear — add `clearResponseStateMemoryForTests()`) → expand hits from disk.
- TTL: write snapshot with stale createdAt → load → expand misses (pruned).
- Corrupt file: write garbage → load ignores, no throw.

## Risks / audit questions
- Multi-instance ocx sharing one home: last-writer-wins on atomic rename — acceptable
  (single-user tool, snapshot is best-effort cache).
- Payload size: 1000 entries of full conversation items can be MBs — acceptable for a local
  file, debounce caps write frequency; TTL prune on load caps growth.
- Secrets: conversation content lands on disk under 0600 in the same dir as auth.json — same
  trust boundary as existing files (codex-history-backup.json already lives there).

## D — landed (outcome: DONE)
- Audit (Boole, gpt-5.5): PASS-WITH-FIXES; all 5 fixes applied — ensureLoaded on the three
  runtime exports, OPENCODEX_HOME sandbox in tests, memory-only vs full clear helpers,
  per-entry 2MiB + total 24MiB snapshot caps (base64 input_image risk), flushResponseState
  called from drainAndShutdown.
- Implementation nuance found in C: the debounced write must capture snapshotPath() at
  SCHEDULE time — tests swap OPENCODEX_HOME between beforeEach blocks, and a late timer
  fired into the real home during the first full-suite run. Fixed; verified the suite no
  longer creates ~/.opencodex/responses-state.json.
- Evidence: bun test ./tests/ 1505 pass 0 fail (exit 0); tsc --noEmit exit 0; new tests:
  restart roundtrip (memory clear + disk load + conversationId), TTL prune on load,
  corrupt-file ignore, oversized-entry disk skip.
- LOOP-PESSIMIST-01: multi-instance ocx sharing one home is last-writer-wins (acceptable,
  documented); snapshot covers restarts but not chains older than 1h TTL; falsifier for this
  fix = a post-restart miss warn in logs for an id recorded <1h earlier.
