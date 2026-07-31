# Graceful shutdown — `ocx start` Ctrl-C must not orphan the proxy

Goal ID: 7b2c754f-54d · Branch: `feat/kiro-on-dev` · Class: C3 (process lifecycle + npm `bin` launcher / release surface → C4-level care)

## Part 1 — Plain explanation

When you run `ocx start` and press Ctrl-C, the proxy is supposed to shut down
gracefully: stop accepting work, finish/abort in-flight turns, free the port,
remove its pid/runtime-port files, and restore the Codex config. Today that does
**not** reliably happen. The `ocx` command is a thin Node launcher (`bin/ocx.mjs`)
that runs the real proxy on the bundled Bun runtime via a **blocking** `spawnSync`.
`spawnSync` can't run JS signal handlers and does **not** forward signals to the
Bun child. So when the launcher gets the signal but the Bun child does not (Codex
app, IDE terminal, service wrapper, or `kill -INT <launcherPid>`), the launcher
dies and the Bun proxy is **orphaned** — port stays bound, files linger, Codex
config never restored.

The fix: the launcher forwards termination signals to the Bun child and waits for
the child's graceful shutdown before exiting; and the Bun side makes shutdown
re-entrant (first signal = graceful drain, an intentional second = force-exit),
de-duping the near-simultaneous "group + forwarded" double-delivery.

## Reproduction (verified live)

`ocx start &` → `kill -INT <launcherPid>` → for 8s+: `launcher=dead bun=alive
port=bound`; `ocx.pid` + `runtime-port.json` remained; Codex config NOT restored
(opencodex entries grew to 5). Confirms the orphan.

## Part 2 — Diff-level plan

### MODIFY `bin/ocx.mjs` (launcher: forward signals + wait for child)
Replace the blocking `spawnSync` tail with async `spawn` + signal forwarding.

Before (tail):
```js
const bun = resolveBun();
const res = spawnSync(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.error) {
  console.error(`opencodex: failed to launch Bun runtime: ${res.error.message}`);
  process.exit(1);
}
if (res.signal) {
  process.kill(process.pid, res.signal);
}
process.exit(res.status ?? 1);
```

After (tail):
```js
const bun = resolveBun();
const child = spawn(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });

// Forward termination signals to the Bun child and WAIT for its graceful
// shutdown. spawnSync used to block the event loop and never forwarded signals,
// so a signal delivered only to this launcher orphaned the Bun proxy.
const FORWARDED = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = sig => { try { child.kill(sig); } catch { /* child already exited */ } };
const handlers = FORWARDED.map(sig => { const h = () => forward(sig); process.on(sig, h); return [sig, h]; });
const clearHandlers = () => { for (const [sig, h] of handlers) process.removeListener(sig, h); };

child.on("error", err => {
  clearHandlers();
  console.error(`opencodex: failed to launch Bun runtime: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  clearHandlers();
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(code ?? 1);
});
```

Import change: add `spawn` to the existing `node:child_process` import
(`import { spawn, spawnSync } from "node:child_process";`). `spawnSync` stays
(used by `resolveBun`/update paths).

### MODIFY `src/cli.ts` (re-entrant graceful shutdown in `handleStart`)
Before:
```js
const shutdown = () => {
  console.log("\n🛑 Shutting down opencodex proxy...");
  void (async () => {
    await drainAndShutdown(server, config.shutdownTimeoutMs ?? 5000);
    syncCleanup();
    process.exit(0);
  })();
};
```
After:
```js
let shuttingDown = false;
let shutdownStartedAt = 0;
const FORCE_AFTER_MS = 500; // dedupe the group+forwarded double-delivery; allow a genuine 2nd Ctrl-C to force
const shutdown = () => {
  const now = Date.now();
  if (shuttingDown) {
    if (now - shutdownStartedAt < FORCE_AFTER_MS) return; // near-simultaneous duplicate — ignore
    console.log("\n⏹  Force shutdown (second signal).");
    try { syncCleanup(); } catch { /* best-effort */ }
    process.exit(130);
  }
  shuttingDown = true;
  shutdownStartedAt = now;
  console.log("\n🛑 Shutting down opencodex proxy...");
  void (async () => {
    try {
      await drainAndShutdown(server, config.shutdownTimeoutMs ?? 5000);
    } finally {
      syncCleanup(); // idempotent (cleaned-guard); also re-run by process.on("exit")
      process.exit(0);
    }
  })();
};
```
Rationale: launcher forwarding + OS group delivery can hand the child two signals
within milliseconds; the 500ms window treats that as one Ctrl-C (graceful drain),
while a deliberate later press escalates to immediate exit ("gradual kill").

### NEW `tests/shutdown-launcher.test.ts` (regression, POSIX-gated)
Integration test isolated from the real environment:
- `skipIf(process.platform === "win32")` and skip if `node` is not on PATH.
- temp dir → set child env `OPENCODEX_HOME` + `CODEX_HOME` to it (no real config touched).
- pick a free port; `spawn("node", [binOcx, "start", "--port", String(port)], {env})`.
- wait for `GET /healthz` 200.
- send `SIGINT` to the **launcher PID only** (the bug's trigger).
- assert within ~10s: launcher process exits, AND `/healthz` no longer responds
  (Bun child gone / port freed), AND `<home>/ocx.pid` was removed.
- `afterAll`: best-effort kill any survivor.

Existing `tests/shutdown-drain.test.ts` (turn tracking + stream lifetime) is
unchanged and continues to cover the drain unit.

## Verification
- `bun x tsc --noEmit`
- `bun test tests/shutdown-launcher.test.ts tests/shutdown-drain.test.ts`
- Full suite `bun test tests` (C-phase)
- Manual: `node bin/ocx.mjs start &` → `kill -INT <launcher>` → confirm child dies,
  port freed, pid removed, Codex config restored.

## Risk / blast radius
- `bin/ocx.mjs` is the published npm entrypoint (every `ocx` invocation) → release
  surface; the change keeps the same exit-code/signal-mirroring contract for
  non-`start` commands (they exit normally; handlers simply detach on child exit).
- Windows has no real POSIX signals; forwarding is best-effort and try/caught.
- No public API/schema change; no new dependency.
