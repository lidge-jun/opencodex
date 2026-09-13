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
- Hosted CI green at the exact final head; PR merged into `dev`.

## 8. Terminal outcomes

- **DONE** — every item in §7 has fresh evidence recorded in `040`.
- **BLOCKED** — a host required for platform proof is unreachable and no equivalent
  host of that platform exists. Record which platform lacks proof; do not claim it.
- **UNSAFE** — any design that could terminate a process outside the discovered,
  current-user, package-owned tree. Stop and redesign.
- **NEEDS_HUMAN** — CI red at the final head for a reason outside this unit's scope.
