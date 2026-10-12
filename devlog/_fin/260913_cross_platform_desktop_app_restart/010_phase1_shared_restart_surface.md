# wp2 — Cross-platform shared desktop-app restart surface

Diff-level design. Executes after `000`/`001` are locked. Depends on nothing but the
current `dev` tree.

## 1. Shape

`src/codex/desktop-app-restart.ts` stays the public entry point — it is what
`src/cli/dispatch.ts` imports and what `tests/clients/desktop-app-restart.test.ts`
drives — but its body becomes a platform-independent ladder over three adapters.

```
src/codex/desktop-app-restart.ts   MODIFY  public entry + shared ladder
src/codex/desktop-app/types.ts     NEW     adapter contract and shared result types
src/codex/desktop-app/darwin.ts    NEW     bundle discovery, Apple-event quit, open -b
src/codex/desktop-app/linux.ts     NEW     install-root discovery, SIGTERM, setsid relaunch
src/codex/desktop-app/windows.ts   NEW     the existing Appx/CIM/taskkill logic, moved verbatim
```

`src/codex/` is already claimed in `structure/manifest.json`, so the new
subdirectory inherits ownership and does not create an unclaimed `src/` area.

## 2. The adapter contract — `src/codex/desktop-app/types.ts` (NEW)

```ts
/** One discovered installation of the Codex desktop app. */
export interface DesktopAppInstall {
  /** Stable platform-specific identity, logged and used for relaunch. */
  id: string;
  /** Absolute path every member process's executable must live under. */
  root: string;
  /** Opaque relaunch descriptor the adapter understands. */
  relaunch: string;
}

export interface DesktopProcess {
  pid: number;
  parentPid: number;
  /** Platform-native start-time token. Guards against PID reuse. Never parsed. */
  createdAt: string;
}

export interface DesktopAppExecOptions {
  timeout?: number;
  windowsHide?: boolean;
}

export type DesktopExec = (
  file: string,
  args: readonly string[],
  options?: DesktopAppExecOptions,
) => string;

export interface DesktopAppAdapter {
  /** null = discovery failed. Never throws. */
  discover(exec: DesktopExec): DesktopAppInstall | null;
  /** null = the probe could not run. [] = it ran and found nothing. */
  listProcesses(exec: DesktopExec, install: DesktopAppInstall): DesktopProcess[] | null;
  /** Ancestry of the current process, innermost first. [] = unreadable. */
  ancestryPids(exec: DesktopExec): number[];
  /** Ask the app to quit. Best effort; the ladder decides what happens next. */
  requestQuit(exec: DesktopExec, install: DesktopAppInstall, root: DesktopProcess): void;
  /** Unconditional termination of one root and its tree. */
  forceStop(exec: DesktopExec, root: DesktopProcess): void;
  /**
   * Capture whatever the relaunch will need from the LIVE tree, before anything
   * is stopped. Linux needs the graphical session environment; the other two
   * return an empty record.
   */
  captureRelaunchContext(
    exec: DesktopExec,
    install: DesktopAppInstall,
    processes: readonly DesktopProcess[],
  ): Record<string, string>;
  /** Start the app again. Throws on failure; the ladder reports relaunch_failed. */
  relaunch(
    exec: DesktopExec,
    install: DesktopAppInstall,
    context: Record<string, string>,
  ): void;
}
```

`captureRelaunchContext` is on the contract rather than hidden inside the Linux
adapter because of its **ordering obligation**: it must run while the tree is still
alive. A shared ladder that called it after termination would work on macOS and
Windows and silently produce an app that cannot reach the compositor on Linux.
Putting it in the contract makes the ordering a property of the ladder, checked in
one place.

### 2.1 Membership is boundary-aware (audit B3, N2)

"Executable lives under the install root" is a **path boundary** test, not a string
test. Implemented as a raw `startsWith`, an install root of `/usr/lib/chatgpt` also
matches `/usr/lib/chatgpt-evil/ChatGPT`, and `/Applications/ChatGPT.app` matches
`/Applications/ChatGPT.app-evil/...`. Both are plantable by the same user whose
processes we are about to signal, so uid scoping does not cover it.

Each adapter therefore resolves its root through `realpath` **once, at discovery**,
stores the resolved form, and compares candidates against `resolvedRoot + sep`. A
candidate equal to the root itself is also a member. Nothing compares unresolved
paths, so a symlinked sibling cannot smuggle itself in.

**Residual, stated rather than hidden:** macOS `lstart` has one-second granularity.
If a member pid is recycled into *another member of the same tree* within the same
second, `createdAt` equality passes on a different process. The victim is still
inside the package tree, so the `§8` UNSAFE boundary holds and nothing outside the app
is ever signalled — but the guard's promise is "same process", and at one-second
resolution it is really "same process, or a same-second replacement inside the same
app". Linux (`starttime` jiffies) and Windows (`CreationDate`) do not have this gap.

## 3. The shared ladder — `src/codex/desktop-app-restart.ts` (MODIFY)

Exports that must not change, because callers and tests bind to them:
`restartCodexDesktopApp`, `DesktopAppRestartIo`, `DesktopAppRestartResult`,
`DesktopAppRestartReason`, `DesktopAppExecOptions`.

### 3.1 Reason codes

```ts
export type DesktopAppRestartReason =
  | "unsupported_platform"   // RENAMED from "windows_only"
  | "package_discovery_failed"
  | "process_probe_failed"
  | "no_targets"
  | "self_ancestry"          // retained; wp5 turns this into a handoff
  | "targets_survived"
  | "restart_in_flight"      // another restart holds the singleton lock (020 §4.1)
  | "relaunch_failed";       // NEW
```

`relaunch_failed` is new because the current code is dishonest about it: a failed
`Start-Process` returns `reason: "targets_survived"` with an empty `surviving` array
(`src/codex/desktop-app-restart.ts:349-351`), which tells the operator that
processes would not die when in fact everything died and the relaunch is what
failed. Those are different problems with different manual recoveries.

`windows_only` is renamed rather than kept as an alias. It is a closed union
consumed by one `switch` in `src/cli/dispatch.ts`; keeping a value that can no
longer occur would leave dead prose in the CLI telling users about a restriction
that no longer exists.

wp5 extends this union with `handoff_started` (`020` §6). Treat it as open until that
phase lands, and make the `switch` in `src/cli/dispatch.ts` exhaustive against the
final union, not this one.

`restart_in_flight` is declared here rather than in wp5 even though the lock is a wp5
concern, because a reason code the design *guarantees* will occur cannot live outside
the union its only `switch` is checked against. The lock is taken by
`restartCodexDesktopApp` itself — step 0 below — and not by any caller, so every
entry point (the CLI, the handoff helper, the management service) gets the same
mutual exclusion and the same reason code without each having to remember it.

### 3.2 Ladder

```
 0. take the singleton lock (020 §4.1)            -> restart_in_flight
 1. adapter = ADAPTERS[platform] ?? null            -> unsupported_platform
 2. install = adapter.discover(exec)                -> package_discovery_failed
 3. processes = adapter.listProcesses(exec, install)
      null  -> process_probe_failed      (could not look != nothing there)
 4. roots = rootProcesses(processes)                -> no_targets when empty
 5. ancestry = io.ancestryPids?.() ?? adapter.ancestryPids(exec)
      []                       -> self_ancestry     (unreadable fails closed)
      intersects processes     -> self_ancestry     (wp5: handoff instead)
 6. context = adapter.captureRelaunchContext(exec, install, processes)   <-- tree alive
 7. for each root:
      re-verify identity (listProcesses, match pid AND createdAt)
        unverifiable -> treat as already stopped, do not signal
      adapter.requestQuit(...)
      waitForExit(GRACEFUL_EXIT_TIMEOUT_MS)  -> stopped
      re-verify identity again                <-- the wait window allows PID reuse
      adapter.forceStop(...)
      waitForExit(FORCED_EXIT_TIMEOUT_MS)     -> stopped | surviving
 8. surviving.length > 0 -> { relaunch: "skipped", reason: "targets_survived" }
 9. adapter.relaunch(exec, install, context)
      throws -> { relaunch: "skipped", reason: "relaunch_failed" }
10. { attempted: true, stopped, surviving: [], relaunch: "started" }
```

Step 0 is held until step 10 returns, released in a `finally` — except on the wp5
handoff path, where ownership is transferred to the helper instead of released
(`020` §4.1).

Steps 4, 7 and 8 are lifted unchanged from the current Windows implementation —
`rootProcesses`, `stillSameProcess`, `waitForExit` and the two timeout constants move
into the ladder as-is. This is deliberate: that code already survived a review round
about PID reuse across the graceful-close window, and re-deriving it per platform is
how that lesson gets lost.

### 3.3 Root selection, corrected for macOS

`rootProcesses` currently returns members whose parent is not itself a member. On
macOS that is not sufficient: `001` §1.1 measured crashpad handlers at ppid 1 that
outlived an app instance that had already exited. Under the current rule a stale
crashpad handler is a "root" and therefore a termination target and, worse, a
potential `surviving` entry that blocks the relaunch forever.

The rule becomes: a root is a member whose parent is not a member **and** whose
executable is the app shell itself, not a helper. Each adapter supplies the shell
predicate, because "the shell" is `Contents/MacOS/ChatGPT`, `/usr/lib/chatgpt/ChatGPT`
without a `--type=` argument, and `ChatGPT.exe` respectively. Helpers are still
enumerated — they are what `captureRelaunchContext` reads on Linux — but they are
not signalled directly; terminating the shell takes them.

Helpers are also never counted as `surviving`. Measured on this machine: the live app
(root 15901) owns crashpad handlers 15903 and 15905 at **ppid 1**, and an app instance
that had already exited had left 72689 and 72691 behind, also at ppid 1. Crashpad
handlers are launchd children by design and can outlive the shell. If a surviving
helper blocked the relaunch, the very first restart on any macOS machine would leave
the user with no app at all.

### 3.4 Ancestry-walk semantics (audit B1, primitives N1)

Two opposite mistakes are possible here, and each breaks the feature in a different
direction, so both are pinned:

- **A parent pid that names no live process is a clean end of chain**, not a read
  failure. Windows never reparents orphans, so the wp5 handoff helper *always* has a
  dead parent link once its caller exits. An implementation that read that as
  "unreadable" would fail closed into `self_ancestry` forever and the helper could
  never do the one job it exists for. The same applies to `ps -o ppid= -p <dead>` on
  macOS returning empty output.
- **Hitting the 16-hop bound returns `[]`**, identical to an unreadable hop. A
  truncated chain silently defeats the self-ancestry intersection, and the direct
  path would then terminate the caller's own tree. Sixteen hops is not a generous
  margin in this environment — agent shell, app-server, nested `ocx`, tmux, a login
  shell — so the bound being reached is a real state, and the safe reading of it is
  "I could not establish that I am outside the tree".

Fail-closed here means a handoff, not a refusal, once wp5 lands. That is what makes
the conservative reading cheap enough to always take.

## 4. macOS adapter — `src/codex/desktop-app/darwin.ts` (NEW)

**discover.** Ask LaunchServices first, fall back to the conventional path:

```
/usr/bin/mdfind "kMDItemCFBundleIdentifier == 'com.openai.codex'"   -> first line
fallback: /Applications/ChatGPT.app
```

Either way the candidate is confirmed by reading
`Contents/Info.plist:CFBundleIdentifier` with `/usr/libexec/PlistBuddy` and requiring
`com.openai.codex`. `001` §1 is why the check is on the identifier and not the name:
the bundle is called `ChatGPT.app` and shares that name with a different product.

`install = { id: "com.openai.codex", root: "<bundle>", relaunch: "com.openai.codex" }`.

**Multi-install ambiguity (N5).** Membership is path-scoped while `osascript` quit and
`open -b` are bundle-id-scoped. If two bundles claim `com.openai.codex`, the ladder
could enumerate one and quit the other. Discovery therefore prefers the bundle that
the **running root process** is executing out of, and only falls back to `mdfind` and
then `/Applications/ChatGPT.app` when nothing is running. Whatever is quit is then
the thing that was enumerated.

**listProcesses.** `/bin/ps -Ao pid=,ppid=,lstart=,uid=,comm=`, keep rows whose
`comm` starts with `<bundle>/` and whose uid equals `process.getuid()`.
`createdAt` is the raw `lstart` string, compared verbatim and never parsed.

**ancestryPids.** Walk `/bin/ps -o ppid= -p <pid>` from `process.pid` to 1, bounded at
16 hops, breaking on a repeat. An unreadable hop returns `[]`, which the ladder
fails closed on.

**requestQuit.** `/usr/bin/osascript -e 'quit app id "com.openai.codex"'`. This is the
Apple event, so the app runs its own termination path. Delivery is synchronous and
termination is not, which is why the ladder always waits and re-verifies. If
`osascript` throws, the ladder proceeds to `forceStop`.

**forceStop.** `process.kill(pid, "SIGKILL")`.

**captureRelaunchContext.** `{}` — LaunchServices supplies the session.

**relaunch.** `/usr/bin/open -b com.openai.codex`. Not `open -n`: `001` §1.2 records
that it does not reliably produce a second instance, and a second instance is not
wanted regardless. Deliberately **without** `-g`: the operator asked for a restart and
expects the app back in front of them, so foregrounding is the intended behaviour
rather than an oversight. An unknown bundle id makes `open` exit non-zero with
`LSCopyApplicationURLsForBundleIdentifier() failed`, which the ladder reports as
`relaunch_failed`.


## 5. Linux adapter — `src/codex/desktop-app/linux.ts` (NEW)

**discover.** Resolve `/usr/bin/chatgpt` (then `/usr/local/bin/chatgpt`) through
`realpath`; `001` §2 measured it as a symlink to `/usr/lib/chatgpt/codex-launcher`,
a two-line `sh` script that execs `/usr/lib/chatgpt/ChatGPT`. The directory holding
that launcher is the install root, and the shell binary must exist inside it.

**The resolved root must be trusted (N1).** `dirname(realpath(launcher))` alone is not
enough: `/usr/local/bin` is group-writable on some systems, so a planted
`chatgpt -> ~/x/codex-launcher` beside a `~/x/ChatGPT` would make an attacker-chosen,
user-writable directory the membership boundary and the relaunch target. Discovery
therefore requires the resolved root and the shell binary to be owned by uid 0 and
not group- or world-writable. A root that fails that check is `package_discovery_failed`,
not a fallback. Same-uid scoping limits the blast radius to the attacker's own
processes, but the relaunch would execute an attacker-chosen binary, which is the
part worth closing.

`install = { id: "chatgpt", root: "/usr/lib/chatgpt", relaunch: "/usr/bin/chatgpt" }`.

No PATH lookup: the launcher path is checked as an absolute candidate, so a
`chatgpt` earlier on PATH cannot redirect a kill or a launch.

**listProcesses.** Read `/proc`: for each numeric entry, `readlink /proc/<pid>/exe`,
keep it when the target is under `<root>/`, and require `/proc/<pid>/status` `Uid:`
real uid to equal `process.getuid()`. `parentPid` comes from `PPid:`. `createdAt` is
field 22 of `/proc/<pid>/stat` (`starttime`) as a raw string — the same field
`readLinuxProcStartMs` already reads in `src/codex/app-server-processes.ts:573-589`,
but kept as an opaque token here because the ladder only ever compares it. Reuse that
function's parsing rather than re-deriving it: field 22 must be located **after the
last `)`** in the line, because `comm` can itself contain spaces and parentheses —
and this app's helpers are literally named `Codex (Service)` (N3).

A `/proc` that cannot be read throws, and the adapter returns `null` so the ladder
reports `process_probe_failed`. This mirrors `listUnixProcSnapshots`, which already
treats a missing `/proc` as an enumeration failure rather than an empty result
(`src/codex/app-server-processes.ts:342-345`).

**Shell predicate.** The shell is `<root>/ChatGPT` with no `--type=` argument in
`/proc/<pid>/cmdline`. `001` §2.1 shows every helper carries `--type=zygote`,
`--type=gpu-process`, `--type=utility` and so on.

**ancestryPids.** `PPid:` from `/proc/<pid>/status`, walked to 1, bounded at 16.

**requestQuit.** `process.kill(pid, "SIGTERM")`.

> Honest note for the implementation and the docs: `001` §2.2 read
> `/proc/3284901/status` and found SIGTERM in neither `SigCgt` nor `SigIgn`, so the
> Linux shell has the **default** SIGTERM disposition. SIGTERM there is termination,
> not a graceful shutdown request. There is no better primitive available — the app
> registers no DBus quit method and has no systemd unit — so this is the honest
> ceiling on Linux, and the operator-facing text must not claim a graceful quit it
> does not perform.

**forceStop.** `process.kill(pid, "SIGKILL")`.

**captureRelaunchContext.** The one genuinely novel piece.

`001` §2.2 measured that `/proc/<root>/environ` is **1902 bytes of NUL**: Chromium
scrubs its environment block after startup. Reading the root is therefore useless.
The values survive in children that inherited them before the scrub — the embedded
app-server was the one that still had them.

So: iterate the enumerated members, oldest-first, reading `/proc/<pid>/environ` until
one yields a non-empty `XDG_RUNTIME_DIR`. "Oldest-first" sorts `starttime`
**numerically** — it is a jiffies integer in a string, and a lexical sort misorders it
(N4). Copy forward exactly five keys and nothing else:

```
DISPLAY  WAYLAND_DISPLAY  XDG_RUNTIME_DIR  XDG_SESSION_TYPE  DBUS_SESSION_BUS_ADDRESS
```

The measured values on `lidge` were `DISPLAY=:1`, `XDG_SESSION_TYPE=x11`,
`XDG_RUNTIME_DIR=/run/user/1000`,
`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`.

The allowlist is not tidiness. `/proc/<pid>/environ` is another process's full
environment and routinely carries API keys and session tokens; copying it wholesale
into a spawn would move credentials between security contexts for no benefit.

**relaunch.** `setsid <relaunch>` with `detached: true`, `stdio: "ignore"`, the
captured five variables merged over a minimal environment, followed by `unref()`.

That minimal environment is not empty (N6): it carries `HOME`, `USER`, `LOGNAME`,
`LANG` and a fixed `PATH` of `/usr/local/bin:/usr/bin:/bin` from this process's own
environment. The launcher is a `sh` script and Electron resolves its user-data
directory from `HOME`; starting it with only the five session variables would produce
an app that launches and then behaves as a different user profile.

`detached: true` and the `setsid` binary overlap — `detached` already calls
`setsid(2)`, and the `setsid` binary then auto-forks because it finds itself a group
leader. The audit confirmed this is redundant but harmless, and no `--fork` is
needed. Both are kept because the redundant one is the cheap insurance against a
runtime that changes `detached` semantics.
`setsid` is required so the relaunched app is not in the ssh session's process group
and does not die when that session ends — `001` §2 confirmed `/usr/bin/setsid` is
present. If `XDG_RUNTIME_DIR` was not recovered, `relaunch` throws rather than
starting an app that cannot reach the compositor, and the ladder reports
`relaunch_failed` with a message naming the missing session.

## 6. Windows adapter — `src/codex/desktop-app/windows.ts` (NEW, moved)

Everything currently in `src/codex/desktop-app-restart.ts` lines 76-262 moves here
unchanged in behaviour: `discoverPackage` (`Get-AppxPackage -Name OpenAI.Codex` then
`OpenAI.CodexBeta`, runtime discovery never a literal AUMID), `listPackageProcesses`
(`ChatGPT.exe` under `InstallLocation`, `GetOwner` scoped to the current user, the
newline-joined script that #2557 fixed), `windowsAncestryPids` (CIM parent walk),
`CloseMainWindow()`, `taskkill /PID <pid> /T /F`, and
`Start-Process 'shell:AppsFolder\<family>!App'`.

The only change is shape: these become the adapter's methods, `createdAt` is the
existing `CreationDate` ISO string, and `captureRelaunchContext` returns `{}`.

Comments that explain *why* each guard exists — the newline-vs-space PowerShell bug,
the shared-`WindowsApps` multi-user reason for `GetOwner`, the PID-reuse window —
move with the code. They are the reason the code is shaped the way it is.

## 7. Focused verification for this phase

No product suite (`000` §2). The evidence this phase produces is the live
three-host behaviour recorded in `040`, plus hosted CI at the final head.

## 8. Risks

- **Terminating something outside the tree.** Mitigated by requiring the executable
  to live under the discovered root, requiring the current uid/owner, and
  re-verifying `pid`+`createdAt` immediately before each signal.
- **Stale macOS crashpad handlers blocking relaunch forever.** Mitigated by §3.3.
- **Linux relaunch into no session.** Mitigated by failing `relaunch_failed` instead
  of starting a headless app that the user cannot see and that holds the single-instance lock.
