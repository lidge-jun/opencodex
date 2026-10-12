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

### 4.1 A restart that acts is a singleton (audit B2)

Nothing in the first draft stopped two ladders from running at once, and the
interleaving is destructive rather than merely wasteful: helper A quits the app and
relaunches it, helper B re-enumerates during that window, sees the **freshly started**
root as a target, and kills it. Two `ocx sync --restart-codex` runs inside the app, or
one handoff racing an ssh-issued direct run, are enough.

So every restart attempt — direct path and handoff alike — first takes an atomic lock
at `<opencodex home>/desktop-restart.lock`, created with `wx` and holding an owner pid
and a timestamp. A caller that cannot take the lock does not queue and does not wait:
it reports `restart_in_flight` and exits. Queueing would rebuild the same race one
step later.

The lock is held **across the whole ladder including the relaunch**. Releasing after
the last kill would reopen exactly the window this closes.

**The lock is transferred to the helper, not contended for.** This is the part that
makes the handoff work at all. The obvious reading — "every restart that acts takes
the lock" — deadlocks the feature: the caller takes the lock, discovers it is inside
the tree, spawns a helper, and the helper then waits for a lock its own parent holds.

The sequence is therefore:

```
caller: take lock (owner = caller pid)
caller: ancestry check -> inside the tree
caller: spawn detached helper
caller: REWRITE the lock owner to the helper pid, atomically
caller: exit WITHOUT releasing
helper: wait for caller pid to exit (up to 20 s)
helper: assert the lock names ITS OWN pid, else exit without acting
helper: run the ladder
helper: release in finally
```

"Release in finally" means **release a lock this process owns**. A helper that finds
the lock naming a different live pid exits without touching it; deleting somebody
else's live lock would destroy the mutual exclusion this section exists for. The
release is therefore a compare-and-delete on the owner pid, never an unconditional
`unlink`.

The helper never takes the lock; it inherits one already made out to it. A concurrent
caller arriving at any point sees a lock owned by a live pid and reports
`restart_in_flight`, which is the behaviour B2 asked for.

Mechanically this is **own-pid reentrancy**, not a second code path. Step 0 of the
ladder (`010` §3.2) runs unconditionally in every process, and acquisition treats a
lock already naming *this* pid as successfully held rather than as contention. The
helper therefore executes the same step 0 as everyone else and finds the lock the
caller made out to it. A helper invoked directly, with no lock waiting for it,
acquires one normally. One acquisition rule covers all three cases, which is why
there is no "helper mode" branch to get wrong.

If the spawn fails, the caller releases the lock on the ordinary `finally` path and
reports `self_ancestry`. The rewrite happens only after a successful spawn, so a
failed handoff can never strand the lock on a pid that does not exist.

The helper asserting ownership is what keeps the hidden command honest: an
arbitrarily invoked `ocx internal desktop-restart-handoff` that was not handed a lock
finds one owned by somebody else, or none at all, and in the latter case takes it
normally like any direct caller.

A lock whose owner pid is dead, or which is older than five minutes, is stale and is
replaced atomically. That staleness rule is what recovers from a helper killed by the
`taskkill /T` race in §8: the lock is left owned by a dead pid and the next restart
reclaims it rather than being blocked until someone deletes a file.

Both the staleness check and the helper's caller-exit poll read liveness by pid, so
both inherit the same small exposure: a recycled pid inside the window reads as
"still alive". Each fails in the safe direction — a false `restart_in_flight` and a
false `caller_still_running` respectively, so the outcome is a restart that did not
happen rather than one that happened to the wrong process — and both are bounded by
the five-minute staleness rule.

### 4.3 Who may hand off

`allowHandoff` is a caller policy, not a global. It is `true` for the CLI, whose
process is short-lived and whose exit is exactly the signal the helper waits for. It
is `false` for the management service (`030` §4.2), because a long-lived proxy never
exits and the helper would spend its whole window waiting for something that cannot
happen, after the operator was already told the restart was handed off. The helper
itself also passes `false`, which is what makes recursion structurally impossible.

### 4.2 What the helper is actually spawned as (nit N11)

`spawn(process.execPath, args)` is under-specified, because `process.execPath` and the
right `args` differ between the ways `ocx` can be running: `bun run src/cli/index.ts`
from a checkout, an npm-installed `ocx` shim, and `bunx`.

Resolution order, decided at spawn time:

1. If `process.argv[1]` names an existing file, spawn `[process.execPath, argv[1], "internal", ...]`.
   This covers the checkout and the npm shim, which is how every measured host runs it.
2. Otherwise, if `process.execPath` is itself the packaged CLI (basename `ocx`), spawn
   `[process.execPath, "internal", ...]`.
3. Otherwise return `{ kind: "failed", reason: "no_executable" }` and let the caller
   report the ordinary `self_ancestry` refusal.

Failing to resolve is a refusal, never a guess. Spawning the wrong interpreter with a
path that does not exist would produce a helper that silently exits and an operator
who was told a restart was handed off.

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

**It is intentionally unauthenticated (nit N8), and that is not a finding.** Any
process running as this user can invoke it with a hand-written plan file naming any
`callerPid`. It gains nothing: the helper only does what the public `--restart-codex`
flag already does for that same user, and a same-uid process could call `kill`
directly. Adding a token here would protect nothing and would imply a boundary that
does not exist. Recording the reasoning so a later reviewer does not file it as a gap.

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
- **Concurrent ladders.** Closed by the singleton lock in §4.1.
- **Windows `taskkill /T` pid-recycle race (nit N10).** The helper escapes the kill
  set because its parent pid is dead and `/T` walks live parent links. If that dead pid
  is recycled into a live process that is itself inside the tree being killed, the
  helper is momentarily reachable through the new link and can be terminated with the
  app. The window is small and the outcome is a failed restart rather than a wrong
  kill: the app still dies, the helper dies before relaunching, and the operator gets
  no relaunch. Accepted and named rather than engineered around, because the
  alternative — an intermediate re-parenting service — costs far more than the
  failure it prevents. The handoff log records nothing in this case, which is itself
  the signal that it happened.
