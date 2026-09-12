# Cross-platform Codex desktop-app restart, folded into `--restart-codex`

Status: OPEN. Opened 2026-09-13. Class C4 (public CLI contract change, process
termination on three operating systems, management-API contract change).

## 1. Objective

`ocx sync --restart-codex` must fully quit and relaunch the Codex desktop app on
macOS, Linux and Windows, not merely send SIGTERM to `codex app-server` children.
The Windows-only `--restart-desktop-app` capability becomes one cross-platform
shared surface that every caller reads, and `ocx system codex-restart` restarts the
desktop app through that same surface instead of being app-server-only.

The maintainer report that opened this unit: `ocx sync --restart-codex` stopped
having any observable effect. The measured cause is in §3.

## 2. Constraints

- **No local product suite.** `bun run test`, `bun run typecheck`, `bun run build:gui`
  and installs are NOT RUN for this unit. Proof is hosted CI at the exact final head.
  Focused local reads are for debugging only and are never quoted as a gate.
- Everything fails **closed**. A failed discovery, a failed enumeration, an
  unreadable process identity or an unreadable ancestry chain must never be read as
  "nothing to do" and must never authorise a kill. This is the existing doctrine in
  `src/codex/desktop-app-restart.ts` and `src/codex/app-server-processes.ts`; the
  cross-platform rewrite inherits it unchanged.
- Only the **current user's** processes are ever signalled, on every platform.
- Executables are resolved from trusted absolute system locations, never from PATH.
- The relaunch never creates a **second** instance. If anything survived
  termination, nothing is relaunched and the operator is told.
- Out of scope: the proxy's own restart (`system-restart-contract.ts`), Claude
  Desktop, Cursor, any provider or routing behaviour, and the GUI's visual design.

## 3. Measured cause of "`--restart-codex` does nothing"

Measured live on 2026-09-13; full evidence in `001_platform_topology.md`.

The macOS Codex desktop app runs its app-server as a bundle-internal child:

```
72687     1  /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
73511 72687  /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server ...
76297 73511  /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host
```

`isCodexAppServerCommandLine` **does** match pid 73511, so `--restart-codex` is not
failing to find a target. It signals the app's own child, the app immediately
respawns it, and the renderer keeps the model list it built at app start. The
result an operator sees is "the command ran and nothing changed" — the same
symptom #2292 recorded on Windows, now on macOS too, because the picker's cache
lives in the shell rather than in the app-server.

So the fix is not a better matcher. The only thing that reliably refreshes the
picker is restarting the shell that owns it, which is exactly what
`--restart-desktop-app` already does on Windows and what no platform other than
Windows can currently do at all.

## 4. The consent question, decided

`--restart-desktop-app` was deliberately kept separate from `--restart-codex`
(see the module header of `src/codex/desktop-app-restart.ts`): quitting the desktop
app ends live conversations, which is a larger consent than restarting a background
helper. That reasoning was sound and is now **superseded by an explicit maintainer
decision**: `--restart-codex` must mean "the Codex app is fully stopped and started
again". The narrow behaviour does not disappear — it moves to an explicit
`--restart-app-server-only` flag — so no caller loses the ability to ask for it.

`--restart-desktop-app` keeps working as a deprecated alias so existing scripts and
the published documentation do not break in the same release that changes the
meaning of the other flag.

## 5. Work-phase map (dependency-ordered)

| # | Work-phase | Doc | Depends on |
|---|---|---|---|
| wp1 | Docs-first roadmap (this unit) | `000`, `001` | — |
| wp2 | Cross-platform shared restart surface | `010` | wp1 |
| wp5 | Detached self-handoff restart | `020` | wp2 |
| wp3 | CLI + management contract merge, docs and generated surfaces | `030` | wp2, wp5 |
| wp4 | Live three-host verification, hosted CI, PR, merge | `040` | wp3 |

`002` records the A-phase audit findings and their dispositions. It is part of wp1's
output: the roadmap was audited by three independent reviewers before any
implementation, two returned FAIL, and six blockers were folded back into `010`,
`020` and `030` before wp2 started.

Execution order is wp1 -> wp2 -> wp5 -> wp3 -> wp4. The goalplan ids are not
chronological because wp5 was appended after the first four were registered
(LOOP-UNIT-CHAIN-01); the dependency column above is authoritative.

## 6. Why wp5 exists

The self-ancestry guard refuses to restart the desktop app when the command is
running **inside** it. On this maintainer's machine that is the normal case: the
shell that runs `ocx` is a descendant of `ChatGPT.app` through the app-server
(`10456 -> 73511 -> 72687 -> launchd`). Without wp5 the merged flag would refuse in
exactly the situation that produced the original complaint, and the feature would
still "not work".

wp5 replaces the refusal with a handoff: a fully detached helper outlives the
caller, waits for it to exit, re-enumerates, and then performs the restart from
outside the tree. The guard itself is kept — it is what decides that a handoff is
needed rather than a direct kill.

## 7. Acceptance

- `ocx sync --restart-codex` fully quits and relaunches the Codex desktop app on
  macOS, Linux and Windows, proven by a root-process identity change on a real host
  of each platform.
- `ocx system codex-restart --yes` does the same through the same module.
- One module owns discovery, stop and relaunch; no caller carries a per-platform
  branch.
- `--restart-desktop-app` still works and says it is deprecated.
- `--restart-app-server-only` reproduces the old `--restart-codex` behaviour.
- `ocx catalog pull --restart-codex` means the same thing as `ocx sync --restart-codex`,
  so the flag has one meaning across the CLI (`002` §B4).
- The remote `POST /api/machine/sync` `restartCodex` field does **not** gain desktop
  scope (`002` §B5).
- Hosted CI green at the exact final head; PR merged into `dev`.

## 8. Terminal outcomes

- **DONE** — every item in §7 has fresh evidence recorded in `040`.
- **BLOCKED** — a host required for platform proof is unreachable and no equivalent
  host of that platform exists. Record which platform lacks proof; do not claim it.
- **UNSAFE** — any design that could terminate a process outside the discovered,
  current-user, package-owned tree. Stop and redesign.
- **NEEDS_HUMAN** — CI red at the final head for a reason outside this unit's scope.

## 9. Resume state

Kept current so a later cycle, or a reader after a context loss, resumes from this
file rather than from a transcript.

| Work-phase | State | Artifact |
|---|---|---|
| wp1 roadmap | **done** | `000`, `001`, `002`, `010`, `020`, `030`, `040` on `codex/260913-cross-platform-desktop-restart` |
| wp2 shared surface | **done** | `010`; commits de44e6a6..49e36f1d |
| wp5 self-handoff | **built, cycle not yet closed** | `020`; commits d1efbebd, 75722903 |
| wp3 contract merge | **done** | `030`; commits 8ebbdc5c..7ac03181 |
| wp4 verification and delivery | not started | `040` |

**What wp1 concluded.** The inert `--restart-codex` is not a matcher defect — the
matcher finds the app-server correctly, and the app respawns it while the picker
keeps the roster the shell built at launch. Only restarting the shell fixes it, which
is why the Windows-only capability has to become cross-platform rather than the
matcher being widened. Three audit rounds moved the design from "quit the app" to
"quit the app, safely, from a process that will survive doing it", which is where the
handoff and the singleton lock came from.

**What wp2 concluded.** `010` was built as written. Two independent code audits found
three fail-open defects that the plan had specified correctly and the code had not
implemented: Linux ancestry returned a non-empty chain for an unreadable hop, so a
probe failure would have quit the shell hosting the caller's own session; macOS
classified every dead parent as unreadable, which would have made the wp5 helper
refuse forever; and the lock was not exclusive at all, because `wx` on a uniquely
named staging file always succeeds. All folded and re-audited to PASS.

The lesson for the remaining phases: a plan section saying "fails closed" is not
evidence that the code does. Each of the three defects reads as correct until the
error shape is checked against what the runtime actually throws.

**FSM note for whoever resumes.** The cycle currently open is bound to **wp3**, not
wp5: both became ready when wp2 closed and the orchestrator activated wp3. The wp5
code is built, audited and committed regardless; the open cycle should now deliver
wp3 and close, and wp5's record lives in the goalplan task ledger.

**Direction for wp5.** Build `020` as written. The lock it depends on already exists
and is verified, including the transfer that lets the helper inherit ownership, so
wp5 adds `handoff.ts`, the hidden `internal` command, and the `startHandoff` seam the
ladder already accepts. `handoff_started` is in the union and confirmed unreachable
until that seam is supplied.

**What wp3 concluded.** The merged contract shipped across `sync`, `sync-cache`,
`catalog pull` and `ocx system codex-restart`, with docs in English and seven
locales. Three audit rounds were needed. The recurring failure was not the design
but the seams between the pieces: `excludePids` was passed to an option that did not
exist, `desktopAppRestarted` was computed and dropped, `restartIncomplete` was
assigned where it should only ever be set, and three source-oracle tests still
pinned the contract the change reverses.

**Two residuals accepted, both reviewed and recorded rather than hidden:**

- **Windows `excludePids` is a no-op for app-servers.** The CIM probe enumerates
  `ChatGPT.exe` while Windows app-servers run as `codex.exe` / `codex-code-mode-host`,
  so they still receive SIGTERM before the app quits. The restart is correct; the cost
  is one extra interrupted turn on the platform that already had this feature. Closing
  it means widening the query that decides what may be killed, which needs its own
  verification. Documented at the decision point in `src/cli/restart-scope.ts`.
- **`desktopAppRestarted` appears on an unchanged-catalog pull.** Presence means the
  restart was requested and `true` means it relaunched; a failed relaunch is
  `ok: false` with `code: "restart_incomplete"`, so no caller can confuse them.

**Direction for wp4.** Execute `040` as written. The local macOS host cannot prove its
own direct restart and is reserved for the handoff proof, after the merge.

**Standing constraint.** No local product suite, build, typecheck or install at any
point in this unit (§2). Every completion claim rests on live host evidence plus
hosted CI at the exact final head.
