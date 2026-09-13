# wp5 — Detached self-handoff restart

Diff-level design. Depends on wp2 (`010`). Runs before wp3.

## 1. The problem this solves

The self-ancestry guard refuses to restart the desktop app when the calling process
is inside it. That refusal is correct — terminating your own tree kills the command
mid-flight and leaves the operator with neither a restarted app nor an explanation.

But `001` §1.3 measured the maintainer's actual shell:

```
31497 (zsh) -> 16733 (bundled codex app-server) -> 15901 (ChatGPT) -> 1 (launchd)
```

Anything run from a Codex terminal, a Codex agent session, or the app's own shell is
inside the tree. Without this phase, the merged `--restart-codex` would refuse in
precisely the situation that produced the original "it doesn't work" report, and the
unit would ship a flag that fails for its primary user.

## 2. Design

Keep the guard. Change what happens when it fires: instead of refusing, hand the
work to a process that will still be alive after the app dies.

```
ocx (inside the tree)
  |-- writes a handoff plan to a private temp file
  |-- spawns a DETACHED helper, unref()s it, and returns immediately
  |-- prints "handed off" and exits
       |
       helper (outside the session, orphaned once ocx exits)
         |-- waits for the caller pid to exit (bounded)
         |-- re-runs the wp2 ladder from scratch
         |-- appends the outcome to a log the operator can read
```

### 2.1 Why waiting for the caller matters

The helper is spawned from inside the app tree, so at spawn time it is still a
descendant. Two things make it safe:

- It **waits for the calling `ocx` process to exit** before doing anything. At that
  moment it is orphaned and reparented (`launchd`/`init`/`systemd --user`), so it is
  no longer reachable by a tree walk from the app root.
- It **re-enumerates and re-runs the ancestry check itself**. It does not trust the
  caller's finding. If it somehow still sits inside the tree, it refuses exactly as
  the direct path would, and records that refusal.

On Windows the ordering matters more than on Unix, because `taskkill /T` walks live
parent-child links: an orphan whose parent pid is dead is not traversed. On Unix the
ladder only signals pids it enumerated as package members, and the helper's
executable is `ocx`/`bun`, never under the app root, so it is never a member.

### 2.2 Spawn primitives

| Platform | Spawn | Detach |
|---|---|---|
| darwin / linux | `spawn(execPath, args, { detached: true, stdio: "ignore" })` then `unref()` | `detached: true` creates a new process group; the parent exits immediately |
| win32 | `spawn` with `detached: true`, `windowsHide: true`, `stdio: "ignore"`, then `unref()` | the helper is orphaned as soon as `ocx` exits |

No shell is involved on any platform, so no quoting surface exists.

## 3. Files

```
src/codex/desktop-app/handoff.ts     NEW  plan file, spawn, and the helper's run loop
src/cli/internal-command.ts          NEW  hidden "ocx internal desktop-restart-handoff"
src/cli/dispatch.ts                  MODIFY  route the hidden command
src/codex/desktop-app-restart.ts     MODIFY  self_ancestry -> attempt handoff
```

## 4. `src/codex/desktop-app/handoff.ts` (NEW)

```ts
export interface DesktopRestartHandoffPlan {
  schemaVersion: 1;
  /** Pid the helper waits on before acting. */
  callerPid: number;
  /** Advisory only; the helper re-discovers and re-enumerates. */
  expectedInstallId: string;
  createdAtMs: number;
}

export type HandoffOutcome =
  | { kind: "started"; helperPid: number; logPath: string }
  | { kind: "failed"; reason: "spawn_failed" | "plan_write_failed" | "no_executable" };

export function startDesktopRestartHandoff(io?: HandoffIo): HandoffOutcome;
export function runDesktopRestartHandoff(planPath: string, io?: HandoffIo): Promise<number>;
```

**Plan file.** Written under the opencodex home with mode `0600`, named
`desktop-restart-handoff-<pid>-<random>.json`. It holds no secret — pids and a
timestamp — but it is a file whose path is passed to a spawned process, so it is
created with `wx` (exclusive) and deleted by the helper after it reads it.

**Helper wait.** Poll `isProcessAlive(callerPid)` every 100 ms up to 20 s. When the
caller is gone, proceed. If the caller is still alive at the deadline, **refuse** and
record `caller_still_running`: a caller that outlives the window is not the
short-lived `ocx sync` this was designed for, and killing the app out from under an
unknown long-running process is not something to guess about.

There is also a guard for a plan that is not ours to run: if `createdAtMs` is more
than five minutes old, the helper exits without acting. A stale plan file that
survived a crash must not restart the app hours later.

**Log.** Appended to `<opencodex home>/desktop-restart-handoff.log`, one JSON line
per run: timestamp, outcome, reason, stopped/surviving counts. Counts, not command
lines — the same projection `CodexRestartResponse` already applies, for the same
reason.

## 5. `src/cli/internal-command.ts` (NEW)

One hidden command, not registered in `src/cli/registry.ts` and therefore absent
from help, from `src/cli/capabilities.ts`, and from the generated skill surface:

```
ocx internal desktop-restart-handoff --plan <path>
```

It is not a user-facing capability and must not become one. It exists so the helper
is the same audited binary running the same audited ladder, rather than a second
implementation in a shell script. `tests/ci-workflows/skill-ocx.test.ts` asserts the
documented pages name only registry commands, so keeping this out of the registry is
what keeps that gate green.

Unknown `internal` subcommands exit non-zero with a one-line usage string on stderr.

## 6. `src/codex/desktop-app-restart.ts` (MODIFY)

```ts
  if (processes.some(p => ancestry.has(p.pid))) {
-   return skipped("self_ancestry");
+   if (io.allowHandoff === false) return skipped("self_ancestry");
+   const handoff = (io.startHandoff ?? startDesktopRestartHandoff)();
+   if (handoff.kind === "failed") return skipped("self_ancestry");
+   return {
+     attempted: false, stopped: [], surviving: [],
+     relaunch: "skipped", reason: "handoff_started",
+     handoff: { helperPid: handoff.helperPid, logPath: handoff.logPath },
+   };
  }
```

`handoff_started` joins the reason union. `allowHandoff: false` is what the helper
itself passes, which is what makes recursion structurally impossible rather than
merely unlikely: the helper can only ever take the direct path or refuse.

## 7. CLI reporting

`handleDesktopAppRestart` gains one case:

```
case "handoff_started":
  log.log(
    "This command is running inside the Codex app, so the restart was handed off to a "
    + `detached helper (pid ${result.handoff.helperPid}). The app will quit and relaunch `
    + `in a moment; this session will end with it. Outcome: ${result.handoff.logPath}`,
  );
```

Saying "this session will end with it" is the point. The operator is about to lose
the terminal they typed into, and a message that does not say so reads as a hang.

## 8. Risks

- **Orphan helper never runs.** Bounded: 20 s caller wait, 5 min plan expiry, then exit.
- **Helper killed with the app.** Addressed by §2.1 (wait for caller exit, re-enumerate).
- **Recursion.** Structurally prevented by `allowHandoff: false` in the helper.
- **Surprise for scripted callers.** A CI script calling `ocx sync --restart-codex`
  from outside the app is unaffected: the guard does not fire, and the direct path runs.
