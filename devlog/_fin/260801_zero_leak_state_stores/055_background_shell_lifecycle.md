# 055 — Cursor background-shell lifecycle

Date: 2026-08-01
Work phase: wp6b
Depends on: delivered 035, delivered 040, delivered 050
Binding inputs: inventory store 30, `005_impl_roadmap.md` phase 055 and regression classes.

## Outcome

Keep Cursor native local execution disabled by default. When a trusted operator opts into
`nativeLocalExec: "on"`, every background shell belongs to one transport session, live
admission is capped, idle and absolute deadlines trigger bounded termination attempts,
and registry ownership plus its admission lease survive until direct-child termination is
confirmed by `close`.

Delivered 035 supplies the contract reused here: `createAdmissionGate()`, its exact
`AdmissionLease`, scalar `AdmissionMetrics`, and aggregation through
`activeRegistryMetrics()` (`src/lib/admission.ts:12-57`,
`src/server/lifecycle.ts:85-93`). This phase does not invent a parallel count check or
lease type. Delivered 040 owns eviction of retained app-memory stores and is out of scope:
a live OS process is neither retained bytes nor an evictable cache entry. Delivered 050
owns translator/transport byte budgets and contributes only its privacy-safe observability
pattern. Shell count and lifetime are a separate OS-resource admission boundary; neither
040 eviction nor 050 byte pressure may kill or silently untrack a shell.

Defaults:

```ts
export const CURSOR_BACKGROUND_SHELL_MAX_LIVE = 8;
export const CURSOR_BACKGROUND_SHELL_IDLE_MS = 5 * 60_000;
export const CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS = 30 * 60_000;
export const CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS = 2_000;
```

Eight allows several concurrent development servers/commands without turning a remote
Cursor session into an unbounded process supervisor. Five idle minutes covers interactive
stdin pauses; 30 minutes is an escape hatch for forgotten long-lived children. These are
fixed safety constants, not new user configuration.

## Current anchors

- `src/adapters/cursor/native-exec-shell.ts:23` owns one process-wide map containing only
  `{ child, outputLength }`.
- `src/adapters/cursor/native-exec-shell.ts:215-222` enters background spawn and performs
  the ungated insertion; `:231` deletes on `close` only, while `error` is not handled.
- `src/adapters/cursor/native-exec-shell.ts:252-265` writes stdin by global numeric id,
  so a different transport can currently address another session's shell.
- `CursorNativeExecContext` is at `src/adapters/cursor/native-exec.ts:64-71` and has no
  session owner. Policy rejection starts at `:476`; the two allowed background dispatches
  at `:495-496` call spawn/stdin without an owner.
- `src/adapters/cursor/live-transport.ts:428` owns the stable transport id. Initial context
  construction is at `:440`; MCP preparation **rebuilds** the context from
  `desktopDeps` at `:469-474` rather than spreading the prior context. Both constructions
  must therefore set the owner explicitly. `close()` and `cancelCursorRun()` at `:651`
  and `:663` omit shell cleanup.
- `src/adapters/cursor/transport.ts:5-9` already permits asynchronous `close()`, and the
  retry owner awaits it through `closeOnce()` at
  `src/adapters/cursor/transport-retry.ts:80-91,121-127`.
- `src/server/lifecycle.ts:85-93` assembles registry diagnostics;
  `drainAndShutdown()` is `:150-199`, including `server.stop(true)` at `:197`.
- `BackgroundShellSpawnError` begins at
  `src/adapters/cursor/gen/agent_pb.ts:4454`; its generated
  `BackgroundShellSpawnErrorSchema` is at `:4475`. Existing policy and caught-spawn
  serialization already use that schema at
  `src/adapters/cursor/native-exec-shell.ts:206-212,238-241`.

## Registry diff

Modify `src/adapters/cursor/native-exec-shell.ts` and reuse the delivered 035 primitive:

```ts
import {
  createAdmissionGate,
  type AdmissionLease,
  type AdmissionMetrics,
} from "../../lib/admission";

interface BackgroundShellEntry {
  shellId: number;
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  admissionLease: AdmissionLease;
  outputLength: number;
  startedAt: number;
  lastActivityAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  absoluteTimer?: ReturnType<typeof setTimeout>;
  terminating: Promise<BackgroundShellTerminationReport> | null;
}

export interface BackgroundShellTerminationReport {
  attempted: number;
  closed: number;
  unresolved: number;
  killFailures: number;
}

let backgroundShellGate = createAdmissionGate(
  "cursor_background_shells",
  CURSOR_BACKGROUND_SHELL_MAX_LIVE,
);
const backgroundShells = new Map<number, BackgroundShellEntry>();

export function backgroundShellSpawnExec(
  execMsg: ExecServerMessage,
  sessionId: string,
): Uint8Array;
export function writeShellStdinExec(
  execMsg: ExecServerMessage,
  sessionId: string,
): Uint8Array;
export function terminateBackgroundShellsForSession(
  sessionId: string,
): Promise<BackgroundShellTerminationReport>;
export function terminateAllBackgroundShells(): Promise<BackgroundShellTerminationReport>;
export function backgroundShellAdmissionMetrics(): Readonly<AdmissionMetrics>;
export function backgroundShellLifecycleMetrics(): {
  idleTerminations: number;
  absoluteTerminations: number;
  unresolvedKills: number;
  killFailures: number;
};
```

There is no `CursorBackgroundShellBusyError`. Every spawn rejection—missing owner,
admission exhaustion, or synchronous spawn/setup failure—returns the protobuf
`BackgroundShellSpawnResult` error variant created with
`BackgroundShellSpawnErrorSchema`, matching the serialization already at
`native-exec-shell.ts:206-212,238-241`. No thrown internal busy class crosses this wire
boundary.

Admission at `backgroundShellSpawnExec()` is exact:

1. Require a non-empty session id and return the typed spawn error before admission or
   `spawn()` when absent.
2. Call `backgroundShellGate.tryAcquire()` **before** `spawn()`. A null lease returns
   `BackgroundShellSpawnError{error:"background shell limit reached"}` before `spawn()`;
   there is no `backgroundShells.size >= 8` check.
3. If `spawn()` throws synchronously, release the lease because no OS child ownership was
   created, then return the same typed spawn error.
4. Once `spawn()` returns a child, retain the exact lease in `BackgroundShellEntry`.
   Install the minimal `close`/`error` ownership listeners, insert the entry, then attach
   stdout/stderr activity listeners and arm both unrefed timers. If later setup fails,
   return the typed spawn error and start controlled termination; do not delete or release
   merely because setup failed.
5. Numeric ids remain process-monotonic, but authorization always compares the supplied
   session id with the entry owner.

`writeShellStdinExec()` returns the existing typed `WriteShellStdinErrorSchema` unknown-
shell result when absent and a typed `shell belongs to another session` result on owner
mismatch. It never reveals the owner id. A successful stdin write updates
`lastActivityAt` and re-arms only the idle timer. Any stdout/stderr data also increments
`outputLength`, updates activity, and re-arms idle.

`backgroundShellAdmissionMetrics()` returns the gate's scalar snapshot. Add it as
`cursorBackgroundShells` in `activeRegistryMetrics()` at
`src/server/lifecycle.ts:85-93`. Lifecycle counters and termination reports contain
numbers only—never commands, working directories, PIDs, shell ids, session/owner ids, or
error text.

## Controlled termination

Add one idempotent owner:

```ts
async function terminateBackgroundShell(
  entry: BackgroundShellEntry,
  reason: "session_close" | "idle" | "absolute" | "shutdown",
): Promise<BackgroundShellTerminationReport>;
```

The sequence is fixed:

1. Set/reuse `entry.terminating`; clear both timers.
2. Call `stdin.end()` best-effort, keep stdout/stderr listeners attached, and call
   `resume()` so kernel pipes continue draining.
3. Send ordinary direct-child termination with `child.kill()` and wait up to
   `CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS` for `close`.
4. If still open, send direct-child `SIGKILL` best-effort and wait one additional
   `CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS` for `close`.
5. Only the exact-entry `close` handler may call
   `backgroundShells.delete(shellId)` and `entry.admissionLease.release()`. It first checks
   `backgroundShells.get(shellId) === entry`, clears timers, then deletes and releases.
   Natural exit uses that same helper. Lease release is idempotent but is never used as a
   substitute for close confirmation.
6. A `kill()` throw/false return, a child `error` event, or exhaustion of both bounded
   waits does **not** prove termination. Retain the entry and lease in the live registry,
   settle the terminating promise with `unresolved: 1`, and increment scalar
   `killFailures`/`unresolvedKills` as applicable. A later genuine `close` performs the
   authoritative delete/release. Clear `entry.terminating` after an unresolved attempt
   settles while the exact entry is still registered, so a later session/global cleanup
   may re-attempt it; concurrent callers still share the one in-flight promise.

The implementation guarantee is deliberately **direct-child only**. Because
`spawn(..., { shell: true })` may create descendants and Bun/Node's portable
`ChildProcess` contract confirms only the direct child's `close`, this phase does not
claim process-tree termination. It must not report a shell resolved based on an `error`
event or guessed descendant state. Platform-aware process-group/job-object termination is
a separate expansion requiring explicit Windows/POSIX design and tests; no `taskkill`,
negative-PID signal, or detached-process behavior is added implicitly here.

No stdout/stderr text is retained. “Drain output” means continue consuming pipe bytes
until confirmed direct-child close so that child pipes cannot block; only the existing
byte count is kept. Idle timeout calls the helper with `idle`; absolute timeout is never
refreshed. Session close snapshots only exact `sessionId` matches and awaits all controlled
terminations. Global drain snapshots all entries. Neither path kills a foreign entry by
numeric id alone.

## Transport ownership wiring

Modify `CursorNativeExecContext` at `src/adapters/cursor/native-exec.ts:64-71`:

```ts
sessionId?: string;
```

Pass `deps.sessionId` through **both** allowed dispatches at
`src/adapters/cursor/native-exec.ts:495-496`:

```ts
if (execCase === "backgroundShellSpawnArgs") {
  return [backgroundShellSpawnExec(execMsg, deps.sessionId ?? "")];
}
if (execCase === "writeShellStdinArgs") {
  return [writeShellStdinExec(execMsg, deps.sessionId ?? "")];
}
```

At `src/adapters/cursor/live-transport.ts:440`, include
`sessionId: this.sessionId` in the initial context. Include it again in the replacement
object at `:469-474`; that MCP path rebuilds from `desktopDeps` and does not preserve the
old context by spread. Missing owner returns the appropriate typed spawn/stdin error and
never spawns or writes.

Make `LiveCursorTransport.close()` at `src/adapters/cursor/live-transport.ts:651`
`async` and retain one idempotent promise:

```ts
private shellCleanup?: Promise<BackgroundShellTerminationReport>;

private startShellCleanup(): Promise<BackgroundShellTerminationReport> {
  return this.shellCleanup ??= terminateBackgroundShellsForSession(this.sessionId);
}

async close(): Promise<void> {
  // existing transport/MCP teardown
  await this.startShellCleanup();
}
```

This is contract-compatible with `CursorTransport.close(): void | Promise<void>` at
`src/adapters/cursor/transport.ts:5-9`; retry already awaits close at
`transport-retry.ts:80-91,121-127`. There is no fire-and-forget shell cleanup in
`close()`. `cancelCursorRun()` at `live-transport.ts:663` may start the same promise
without awaiting in its synchronous cancellation path, but the eventual `close()` awaits
that exact promise. Repeated close/cancel calls cannot launch competing cleanup passes.

## Global shutdown ownership

Export `terminateAllBackgroundShells(): Promise<BackgroundShellTerminationReport>` from
`native-exec-shell.ts` and wire it into `drainAndShutdown()` at
`src/server/lifecycle.ts:150-199`. Waiting for or aborting admitted turns is NOT a
sufficient fence: forced abort releases turn leases without awaiting handler completion
(`lifecycle.ts:95`), already-decoded Cursor frames survive in an independent promise
chain (`live-transport.ts:864`) and can reach native exec later (`live-transport.ts:976`),
and an existing WebSocket can acquire a new turn lease without checking `isDraining()`
(`src/server/index.ts:947`). Therefore shutdown installs a SYNCHRONOUS shell-admission
fence first: `beginBackgroundShellShutdown()` (exported from `native-exec-shell.ts`,
idempotent, sets a module flag) is called at the top of `drainAndShutdown()` alongside
`draining = true`. `backgroundShellSpawnExec()` checks the fence BEFORE gate acquisition
and before `spawn()`, returning the protobuf `BackgroundShellSpawnErrorSchema` typed
error when fenced. Only after the fence is set does shutdown wait/abort turns and then
snapshot/await the global shell drain — a post-snapshot spawn is impossible because the
fence precedes the snapshot, not because turns quiesced. Catch/report
only privacy-safe scalar totals. A rejected shell cleanup or unresolved report must not
skip response-state/storage cleanup and must never skip `s?.stop(true)`; structure the
tail with independent `try`/`Promise.allSettled` handling and a `finally` that performs
`server.stop` and clears `draining`.

Add `cursorBackgroundShells: backgroundShellAdmissionMetrics()` to
`activeRegistryMetrics()` at `src/server/lifecycle.ts:85-93`. The shutdown report and
lifecycle diagnostic remain scalar-only. Shutdown bounded-wait exhaustion can therefore
finish server shutdown while the still-unconfirmed entry remains owned and visible in
metrics; it must not falsify active ownership by deleting the entry or releasing its
lease.

## Disabled-by-default contract

Behavior remains unchanged at all current policy/config anchors:

- `cursorUnsafeNativeLocalExecEnabled()` at
  `src/adapters/cursor/native-exec.ts:73-75` remains explicit-true only.
- `resolveCursorNativeExecMode()` at `src/adapters/cursor/exec-policy.ts:17-20` keeps
  unset/default as `"off"`; `effectiveCursorNativeExecAllow()` at `:41-44` keeps only
  `"on"` enabled.
- `src/types.ts:1133-1152` keeps the unsafe opt-in warning and
  `"off" | "codex-sandbox" | "on"` contract.
- `docs-site/src/content/docs/reference/configuration.md:435-446` keeps native tools
  disabled by default and `"codex-sandbox"` fail-closed.
- Policy dispatch at `src/adapters/cursor/native-exec.ts:476-487` still rejects before
  reaching allowed spawn/stdin dispatch.

No new config field enables shells. The legacy unsafe boolean remains compatibility only;
docs keep warning that the opt-in bypasses Codex approvals/sandboxing.

## Regression cases

Provide deterministic seams in `src/adapters/cursor/native-exec-shell.ts`: a narrow
background-shell runtime object with injectable `spawn`, monotonic `now`, timer
set/clear, and direct-child kill operations, or an equivalent fake-child harness. Expose
test-only `setBackgroundShellRuntimeForTests(...)` and
`resetBackgroundShellStateForTests(): Promise<void>`. Reset performs the global drain,
requires `unresolved === 0`, verifies the registry/gate is inactive, then restores hooks,
counters, shell-id state, and a fresh test gate; it never force-clears a production entry
whose close was not confirmed.

Extend `tests/cursor-native-exec-shell.test.ts`:

- `eight leases are admitted and the ninth returns BackgroundShellSpawnError before spawn`
- `spawn throw releases the pre-spawn lease and serializes BackgroundShellSpawnError`
- `close releases the exact child and lease only after output pipes drain`
- `idle lifetime terminates after five minutes and stdin activity rearms idle`
- `absolute lifetime terminates after thirty minutes despite activity`
- `controlled termination sends graceful kill before forced kill`
- `kill failure without close retains registry ownership and admission lease`
- `bounded wait exhaustion without close retains ownership and increments scalar unresolvedKills`
- `later confirmed close releases the lease after an unresolved termination`
- `session cleanup terminates only shells owned by that session`
- `global shutdown drain awaits all confirmed shell closes`
- `shutdown fence rejects a queued post-fence spawn with the protobuf typed error before gate acquisition`
- `cross-session stdin write is rejected without revealing owner identity`
- `error event alone never deletes or releases; close/error races affect only the exact map owner`
- `metrics contain scalar counts only and reset deterministically`

Extend `tests/cursor-native-exec.test.ts:354-375`:

- `background shell spawn and stdin receive the same native exec session owner`
- `missing session owner returns typed errors and never spawns or writes`

Extend `tests/cursor-native-exec-policy.test.ts:250-285` with an injected spawn spy:

- `default off and explicit off reject background spawn before the spawn spy`
- `codex-sandbox rejects background spawn before the spawn spy`
- `only explicit nativeLocalExec on reaches bounded shell admission`

Extend `tests/cursor-live-transport.test.ts` and
`tests/cursor-transport-retry.test.ts`:

- `async LiveCursorTransport.close waits for session shell cleanup`
- `cancel and close share one idempotent session cleanup promise`
- `retry does not open the next transport until asynchronous close cleanup settles`

Extend `tests/shutdown-drain.test.ts`:

- `drainAndShutdown awaits the global background-shell drain`
- `shell drain rejection or unresolved termination still calls server.stop`
- `activeRegistryMetrics exposes cursor background-shell admission scalars`

Verification:

```bash
bun test tests/cursor-native-exec-shell.test.ts tests/cursor-native-exec.test.ts \
  tests/cursor-native-exec-policy.test.ts tests/cursor-live-transport.test.ts \
  tests/cursor-transport-retry.test.ts tests/shutdown-drain.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`fix(cursor): bound background shell ownership and lifetime`

## Explicitly not changed

- No default enablement, daemonization, output-text retention, shell-id persistence, or
  cross-session control.
- No 040/LRU eviction of a live child, no 050 byte-budget coupling, and no process kill
  before exact owner resolution.
- No process-tree termination guarantee: this phase owns the `shell:true` direct child
  only and reports unresolved ownership honestly.
- No change to foreground shell semantics, MCP/desktop executors, Cursor protobuf schema,
  or native-exec policy modes.
