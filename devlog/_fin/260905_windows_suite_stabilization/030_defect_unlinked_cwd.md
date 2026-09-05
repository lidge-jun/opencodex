# 030 — Defect 3: the test needs a state Windows cannot produce

Implementation phase. Independent of `010` and `020`. 1 of the 25 failures.

## Failure

```
error: EBUSY: resource busy or locked, rm 'C:\Users\user\AppData\Local\Temp\ocx-unlinked-cwd-3epkdD'
      at removeTreeWithRetry (tests/helpers/remove-tree.ts:28:83)
      at tests/update-notify.test.ts:143:5
(fail) cli wiring > interactiveGuardOk safely evaluates without throwing when cwd is unlinked [2611.94ms]
```

Evidence: `.tmp/win/v140-3.log`.

## Mechanism

```ts
// tests/update-notify.test.ts:139-143
const tempDir = mkdtempSync(join(tmpdir(), "ocx-unlinked-cwd-"));
process.chdir(tempDir);
removeTreeWithRetry(tempDir);      // delete the directory this process stands in
```

POSIX allows unlinking a directory that a process holds as cwd; the process keeps
a valid but nameless working directory. Windows locks the cwd — no process may
delete it. The delete cannot succeed while the test stands there, so
`removeTreeWithRetry` exhausts all 50 attempts (2.6s) and rethrows. The retry
helper is behaving correctly; the precondition is unreachable.

## What the test actually protects

`interactiveGuardOk` (`src/update/notify.ts:126-133`) does **not** call
`process.cwd()` — it reads `OCX_SERVICE` and calls `isatty(0)`/`isatty(1)`
inside a try/catch. The regression it guards is that evaluating the TTY gate
from an unlinked cwd must not throw while initializing a stream. The cwd healing
itself lives elsewhere, at `src/cli/index.ts:7-12`, which catches a throwing
`process.cwd()` and `chdir`s to `homedir()`.

So this is an integration case over a real filesystem state, not a unit test of
a catch branch.

## Fix

```ts
// Windows locks a process's cwd: it cannot be unlinked, so the state under test
// cannot exist there. src/cli/index.ts:7 heals a throwing cwd; this case covers
// the POSIX variant where the directory is gone but the cwd handle survives.
test.skipIf(process.platform === "win32")(
  "interactiveGuardOk safely evaluates without throwing when cwd is unlinked",
  () => { /* body unchanged */ },
);
```

### Rejected alternatives

- **`chdir` back before deleting.** Makes the delete succeed and destroys the
  test: `interactiveGuardOk()` would run with a valid cwd, asserting nothing.
- **Replace it with an injected `isatty` throw.** That exercises the catch
  branch, not the deleted-cwd regression — a different test, and the audit is
  right that it must not REPLACE this one. It may be added later as its own
  case; it is out of scope here.
- **Invent a Windows-reachable "bad cwd"** (revoked ACL, dropped drive mapping).
  A different failure mode dressed up to keep a green checkmark.

A skip is honest here: the platform cannot enter the state, so there is no
coverage to lose. The comment says which platform property makes it so, so it
reads as a boundary rather than a muted failure.

## Acceptance

1. Shard 3 green on Windows with the pinned runtime.
2. `bun test tests/update-notify.test.ts` on macOS → 21 pass, with this case
   still RUNNING (verified by output, not by reading the predicate).
3. `bun run typecheck` clean.
