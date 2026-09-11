# 030 — wp4: cursor fixes from probe evidence (stacked)

Branch: codex/cursor-empty-result-trace (stack root: dev, or wp2 branch only
if run-turn-queue files overlap — expected NOT to overlap).

## PR B1: correlated empty-result instrumentation (+ zero-stdout marker,
## conditional on wp3 N3 evidence — A-gate blocker 9)

### 1. MODIFY src/adapters/cursor/native-exec-shell.ts (CONDITIONAL: build
### only if wp3 N3 proves the model sees an unexplained blank)

- shellExec success with stdout === "" and stderr === "" -> stdout becomes
  "(command completed with no output; exit 0)" — mirrors the bridge-side
  empty-result explanation (tool-result-normalize.ts:108) so the model never
  sees an unexplained blank on the native channel. Guard: only when exit
  code 0 and both streams empty; non-zero exits keep real streams.
- shellStreamExec: when no stdout frame was emitted, emit one synthetic
  stdout frame with the same marker before exit/shellResult/streamClose.

### 2. ADD debug trace (env-gated OCX_CURSOR_TRACE_TOOL_RESULTS=1)

Env-gate convention (A-gate blocker 10): no OCX_* env reads exist under
src/adapters/cursor today; follow the repo's central pattern used by
OCX_EMPTY_COMPLETION_RETRY (rg it in src/server/responses/core.ts /
src/config) — read once at module or call-site with an explicit
disable/enable contract, documented in the PR. Digests: sha256 hex
truncated to 12 chars, computed over result bytes only (no content logged).

- tool-result-normalize.ts: log requestId, tool name, pre/post byte counts,
  changed, isError (no content bodies — privacy:scan constraint).
- protobuf-request.ts suffix path: continuationMode, coveredCount,
  suffixStart, per-blob byte count + sha256 prefix.
- native-exec.ts getBlobArgs: served byte count + integrity result already
  exists — extend log line with digest prefix.

### 3. Tests

- MODIFY tests/cursor-native-exec-shell.test.ts (existing file, A-gate
  blocker 8): zero-stdout marker on both exec paths; non-zero exit
  untouched; marker absent when stdout nonempty. (Only if marker ships.)
- Trace lines: focused test asserting no content bytes are logged (privacy).

## PR B2 (conditional): the boundary fix probe evidence proves

Written after wp3; candidates per 002 #1: checkpoint reserialization of
inherited empty results / alias coverage / replay fidelity. Diff spec added
here as 031 before build (P-phase amendment of the next cycle).

## Accept criteria

bun test <each focused file> exit 0; macmini-cf re-probe shows marker
arriving upstream (N3 re-run); privacy scan of touched files via focused
check; PR template complete.
