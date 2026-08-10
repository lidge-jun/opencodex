# 030 — Layer 3: native-profile harness hang and JSON race (#1061)

## The defect, two halves

**Unbounded teardown.** `tests/native-profile-crash-boundaries.test.ts:194-198`:

```ts
} finally {
  writeFileSync(p.release, "recover");
  writeFileSync(p.stop, "stop");
  expect(await restart.exited).toBe(0);
}
```

No deadline, no kill fallback. The child can stall in `server.stop(true)`
(`tests/helpers/native-profile-startup-child.ts:84`), and the run hangs until CI
kills the job — the 30-minute hang the issue reports.

**Existence-not-content race.** `waitFor()` at `:80-84` proves only that the file
exists; `:182-183` then parses it immediately. The child writes that JSON
non-atomically (`tests/helpers/native-profile-startup-child.ts:71-81`), so a
partially written file yields `Unexpected EOF`.

## Change map — reuse, do not invent

### `tests/helpers/native-profile-startup-child.ts` — MODIFY

The repository already has an atomic writer with an explicit no-half-written
guarantee (`src/config.ts:195-217`, documented at `:102-105`):

```ts
// BEFORE
import { loadConfig } from "../../src/config";
...
writeFileSync(settledPath, JSON.stringify(...));

// AFTER
import { atomicWriteFile, loadConfig } from "../../src/config";
...
atomicWriteFile(settledPath, JSON.stringify(...));
```

Both write sites (`:72-80`, success and failure) change. Marker files that are
only checked for existence stay as they are.

### `tests/native-profile-crash-boundaries.test.ts` — MODIFY

Add a parse-aware wait beside the existing `waitFor`, and use it where a parse
follows:

```ts
async function waitForJson<T>(path: string, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, "utf8")) as T; }
      catch (error) { lastError = error; }
    }
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for parseable JSON in ${path}`, { cause: lastError });
}
```

Bound the teardown following the pattern the sibling test already uses
(`tests/native-profile-startup.test.ts:259-269`), with the shared
`INTERNAL_DEADLINE_MS` from `tests/helpers/test-budget.ts:49-57`.

The audit caught two defects in the earlier sketch: it referenced an undefined
`timeoutMs`, and it left an unbounded `await child.exited` *after* the kill while
claiming no unbounded waits remained. A SIGTERM that the child ignores would hang
in exactly the same way as the bug being fixed. Both are corrected here:

```ts
import { INTERNAL_DEADLINE_MS } from "./helpers/test-budget";

const KILL_GRACE_MS = 2_000;

async function stopStartup(
  child: ReturnType<typeof spawnStartup>,
  paths: ReturnType<typeof startupPaths>,
  timeoutMs: number = INTERNAL_DEADLINE_MS,
): Promise<void> {
  writeFileSync(paths.release, "recover");
  writeFileSync(paths.stop, "stop");
  const exit = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)]);
  if (exit === null) {
    child.kill();
    // bounded here too: an ignored SIGTERM must not reproduce the original hang
    const killed = await Promise.race([
      child.exited,
      Bun.sleep(KILL_GRACE_MS).then(() => null),
    ]);
    if (killed === null) {
      child.kill("SIGKILL");
      // and observe the escalation, so the child is reaped before we throw —
      // otherwise the caller's `child.exitCode !== null` assertion races
      await Promise.race([child.exited, Bun.sleep(KILL_GRACE_MS).then(() => null)]);
    }
    throw new Error("startup child did not stop");
  }
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
}
```

Call `await stopStartup(restart, p)` from `finally`, replacing
`expect(await restart.exited).toBe(0)` at `:194-198`.

Both halves reuse mechanisms already in the tree. Neither is new machinery.

## Red-green, and where it is honest about its limits

**The JSON race is deterministically testable.** Write partial JSON (`"{"`), start
`waitForJson`, then replace it atomically; assert it returns the parsed object
instead of throwing `Unexpected EOF`. That test fails against the old
existence-only `waitFor` by construction.

**The hang needs injection to be provable.** Exact shape, since the audit asked
for it rather than a description:

- In `tests/helpers/native-profile-startup-child.ts`, immediately after the stop
  marker is observed and **before** `server.stop(true)` at `:84`:
  ```ts
  if (process.env.OCX_TEST_STALL_ON_STOP === "1") { await new Promise(() => {}); }
  ```
  Test-only, opt-in, and inert unless the variable is set. The audit judged this
  acceptable in `tests/helpers/`.
- A new case in `tests/native-profile-crash-boundaries.test.ts` spawns the child
  with that variable, calls `stopStartup(child, paths, 1_000)`, and asserts the
  rejection message is `startup child did not stop` **and** that
  `child.exitCode !== null` afterwards — proving cleanup happened, not merely that
  a timeout was detected.
  The `exitCode` assertion is only sound because the SIGKILL escalation is now
  awaited before the throw; the audit caught that race in the previous draft.
  A child that ignores SIGKILL is not testable and not a real case — the escalation
  branch itself stays unproven, and the PR should say so rather than imply otherwise.
- Deadline values: `1_000` ms in the injected test (fast), `INTERNAL_DEADLINE_MS`
  in production teardown.

Without that case the bounded wait would be present but never shown firing, and
"it no longer hangs" would be unfalsifiable in a green run.

## Accept criteria

- Teardown bounded with a kill fallback; no unbounded `await child.exited`.
- The settled-file read proves parseable JSON, not existence.
- The child publishes that file atomically.
- A deterministic test for the parse race; an injected-stall test for the timeout,
  or an explicit statement that the branch is unexercised.
- `bun test tests/native-profile-crash-boundaries.test.ts` green on macOS.
