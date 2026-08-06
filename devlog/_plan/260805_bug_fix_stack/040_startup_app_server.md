# 040 — Layer 4: startup catalog write leaves stale app-servers unhandled (#1046)

## The defect

Service startup rewrites the Codex catalog and `models_cache.json`, then does
nothing about app-servers already running against the old catalog.
`afterCatalogWriteHandleAppServers()` is called only from the explicit CLI `sync`
and `sync-cache` paths (`src/cli/index.ts:858-880`).

The reporter's two-host comparison pinned it precisely: *"Host A's catalog was
rewritten 4m27s after its app-server booted, so the app-server serves an in-memory
list that no longer exists on disk. Every check we ran reads the file; the picker
renders memory."*

That is confirmed upstream. For a configured catalog, Codex builds a
`StaticModelsManager` holding an in-process `Vec<ModelInfo>`; its list operations
clone that vector and its refresh is a no-op. Rewriting either disk file cannot
move it. The gap appears twice on the startup path:
`src/server/index.ts:403-412` (cache invalidation) and
`src/cli/index.ts:319-320` → `src/codex/desired-state.ts:148-160` (catalog sync).

## The obvious fix is unsafe, and this is the important part

`afterCatalogWriteHandleAppServers()` has two branches
(`src/codex/app-server-processes.ts:725-756`):

- `restart: false` — logs a warning. No signal, no prompt, no wait.
- `restart: true` — **SIGTERMs matching app-servers**
  (`:738-742` → `:656-710`), with its own log line admitting active turns may be
  interrupted. It does not drain, and it never escalates to SIGKILL.

Wiring the `restart` branch into unattended startup would kill a user's in-flight
turn every time the service starts on login, repair, or update. A human typing
`ocx sync --restart-codex` is consenting to that; a boot is not.

There is a second trap. The existing handler warns whenever *any* matching
app-server exists — it does not check staleness. The repository already has an
mtime-based classifier that does (`:538-642`, `stale` iff
`startedAtMs <= catalogMtimeMs`). Using the blunt handler at startup would warn on
every boot with Codex open, including the common case where the app-server is
newer than the catalog and perfectly correct.

## Change map — warn only, stale only

### `src/codex/app-server-processes.ts` — ADD

A startup-safe helper beside the existing handler:

```ts
export function warnIfStaleCodexAppServersAfterStartupWrite(
  opts: {
    log?: Pick<Console, "error">;
    io?: CodexAppServerProcessIo;   // the real seam, src/codex/app-server-processes.ts:79-89
  } = {},
): { warned: boolean } {
  try {
    // Pass `io` through: tests inject listSnapshots/readStartMs/catalogMtimeMs/now,
    // and supplying any field also bypasses the 5s memo (`fullyDefault` at :580),
    // which is what stops a pre-write `fresh` reading from masking this check.
    const status = collectCodexAppServerCatalogState(opts.io ?? {});
    if (status.state !== "stale") return { warned: false };
    (opts.log ?? console).error(formatStaleCodexAppServerWarning(status.processes));
    return { warned: true };
  } catch {
    return { warned: false };   // startup sync is best-effort; never fail boot
  }
}
```

Three corrections the audit forced, all verified against the real source:

- `CodexAppServerProcessIo` (`:79-89`) already carries `listSnapshots`,
  `readStartMs`, `catalogMtimeMs`, `now`, **and `kill`** — every seam the test list
  below needs. The earlier draft promised injection while showing a helper with
  nothing to inject into.
- `collectCodexAppServerCatalogState` is **synchronous** and takes the io object
  positionally; the earlier draft `await`ed a no-arg call.
- Supplying any io field makes `fullyDefault` false, so the 5 s memo is skipped.
  The cache bypass therefore needs no new mechanism — but production must pass a
  non-empty io (or an explicit invalidation) after a confirmed write, or it
  inherits the stale-masking bug.

`CodexAppServerCatalogStatus` (`:540-544`) is
`{ state: CodexAppServerCatalogState; processes: Array<{ pid: number; startedAtMs: number | null }>; catalogMtimeMs: number | null }`.
The discriminant field is `state`, and `processes` is already a PID-bearing shape,
so `formatStaleCodexAppServerWarning` needs only its parameter widened from the
full `CodexAppServerProcess` to that shape — it reads `.pid` alone (`:410-417`).

It never reaches `restartCodexAppServers()`. That is the whole point.

`formatStaleCodexAppServerWarning` currently takes full `CodexAppServerProcess`
objects but reads only `.pid` (`:410-417`); widening its parameter to a
PID-bearing shape avoids a needless cast.

### `src/codex/desired-state.ts:148-160` — MODIFY (two problems, both found at audit)

**The sync result is currently thrown away.** `defaultStartupSync` returns
`syncModelsToCodex(port)` as `Promise<unknown>`, and `syncCodexOnStartIfEnabled`
does `await sync(port).catch(() => {})` then returns a bare `boolean` meaning
"the integration was enabled", not "a write happened". So the `catalogWritten ||
cacheSynced` gate this layer depends on **cannot be evaluated** as the code
stands.

Fix the seam first: type `CodexStartupSync` to return the sync result, keep the
`.catch` (startup must stay best-effort), and let the caller distinguish
*skipped* / *ran and wrote* / *ran and failed*. Only then is the write gate real.

**The catalog-state cache can mask the very staleness we are checking for.**
`collectCodexAppServerCatalogState` memoizes for 5 s
(`src/codex/app-server-processes.ts:557-585`, `CATALOG_STATE_TTL_MS`). Startup
plausibly calls it before the write — some other guidance path already does — gets
`fresh`, and the post-write call inside that window returns the cached `fresh`
and stays silent. The helper must bypass or invalidate the cache after a
confirmed write. The function already accepts a `CodexAppServerProcessIo` seam
and only uses the cache when every field is defaulted, so an explicit bypass is
available without new machinery.

### `src/server/index.ts:403-412` — MODIFY (no longer out of scope)

An earlier draft excluded this as "a different write with a different lifecycle".
The audit rejected that, correctly: this path invalidates `models_cache.json` on
**every** server startup, independently of the later optional sync. With Codex
integration disabled, or when the sync writes nothing, startup still leaves a
running app-server stale and this layer would have shipped silence.

### Who owns the warning, and how it warns once

The audit's last blocker: "both writes route through one decision" is a
requirement, not a design. Two independent helper calls would warn twice.

The two write sites are ordered and both live in the same process on the CLI
start path:

1. `src/server/index.ts:406-412` — `invalidateCodexModelsCacheWithPermit`, inside
   `startServer()`, wrapped in `try/catch` because `getCodexHome()` throws when
   there is no Codex home.
2. `src/cli/index.ts:320` — `await syncCodexOnStartIfEnabled(port, config)`, after
   the server is already bound.

**`handleStart` owns the single warning.** Neither write site warns on its own:

- `startServer()` returns whether its cache invalidation actually wrote
  (currently the `try` block discards that). It stays silent.
- `syncCodexOnStartIfEnabled` returns the typed sync result (the seam fix above).
  It stays silent.
- `handleStart` ORs the two write flags and calls
  `warnIfStaleCodexAppServersAfterStartupWrite()` at most once, after both.

That ordering matters for correctness, not just tidiness: warning after the
*first* write would read a catalog mtime that the *second* write is about to
move, so the one call has to come last.

`startServer()` is also reachable without `handleStart` (tests, embedded use). In
that path nothing warns — deliberate. A caller that does not own a startup
lifecycle should not emit lifecycle diagnostics, and the alternative is a module
global that a test can leak across cases.

**Test:** `tests/codex-desired-state.test.ts` — a startup where both the cache
invalidation and the sync report a write emits exactly one warning; asserted on
the injected `log.error` call count, not on the message.

## Tests

No test currently combines startup sync with app-server handling — verified by an
exhaustive read-only scan across `origin/dev`'s `tests/` for files mentioning both
`syncCodexOnStartIfEnabled|handleStart` and
`afterCatalogWriteHandleAppServers|collectCodexAppServerCatalogState`. Result:
empty.

**Add**, faking both boundaries through the existing `CodexAppServerProcessIo`
seam (`io.listSnapshots`, `io.readStartMs`, `io.catalogMtimeMs`, `io.now`) so no
new injection point is invented:

1. the warning runs only when the sync reports a write — requires the typed
   result from the seam fix above;
2. stale warns; `fresh`, `not_running`, and `unknown` do not;
3. **pre-write `fresh` then post-write `stale` still warns** — this is the
   cache-masking regression, and it is the test that would have caught the bug the
   audit found;
4. **an injected `kill` that fails the test if called**, proving no startup path
   can reach `restartCodexAppServers()`;
5. discovery throwing still resolves startup successfully;
6. a startup hitting both write paths warns exactly once.
   Asserted through `handleStart`'s injected log, per the ownership rule above.

For (4), inject `io.kill` and fail the test if it is ever called. The seam exists
at `src/codex/app-server-processes.ts:84`.

Existing coverage to leave intact: `tests/codex-app-server-processes.test.ts:19-106`
(classification), `:309-338` (warn vs SIGTERM), `tests/codex-desired-state.test.ts:167-205`
(startup enable/disable).

## Red-green

Test 2 fails on the pre-fix tree: startup emits no warning at all for a stale
app-server. Test 3 fails against a naive implementation that reuses the cached
state — it is the specific regression proof for this layer. Test 4 passes before
and after by construction; it is a guard against future refactors, not a
regression proof, and is not counted as one.

## Accept criteria

- Startup warns only when the classifier says `stale`.
- The startup sync seam returns a typed result, so "a write happened" is observable.
- A pre-write `fresh` reading cannot suppress the post-write warning.
- Both startup write paths are covered, warning once.
- No code path from startup can reach `restartCodexAppServers()`, proven by an
  injected `kill` that fails the test if invoked.
- Discovery failure never fails boot.
- `bun run typecheck` clean; both app-server test files pass.
