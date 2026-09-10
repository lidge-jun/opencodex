# wp4 execution record

Terminal outcome for this unit. PR #4510 merged into `dev` as
`d7c7b493bfc8e9248b8bb98c692203d74c2ee6cc` on 2026-09-13T13:23:25Z.

## 1. Live three-host proof

All three runs were made at `c8c1c1a9cc`. Only `tests/` and `devlog/` changed between
that commit and the merged head, so the runtime proven here is byte-identical to the one
CI was green on.

| platform | host | root pid before -> after | corroboration |
|---|---|---|---|
| Linux | `lidge` | 3425189 -> 3431091 | reparented to init, so the relaunch came from the detached `setsid` spawn and not a human; a live `--type=gpu-process --ozone-platform=x11` child confirms the app reached the compositor |
| macOS | `macmini-cf` | 74114 -> 99260 | bundled app-server respawned under the new root; singleton lock released |
| Windows | `mini` | 29132 -> 23136 | `{"attempted":true,"stopped":[29132],"surviving":[],"relaunch":"started"}` matching the observed tree |

The Linux corroboration carries the most weight. `001` §2.2 measured the root zeroing its
own environment block, so the session variables must come from a child. Had that been
wrong, the pid would still have changed and the command would still have reported
success, while the user got no visible app. The GPU process is what separates those two
outcomes, and a pid table alone cannot.

## 2. What running it found that ten audit rounds did not

Five work phases and ten audit rounds found eighteen blockers by reading code. Windows
held two more, and both surfaced within seconds of a real host.

**A false success.** The ladder returned
`{"stopped":[27788],"surviving":[],"relaunch":"started"}` while the app kept its original
pid **and** start time throughout. Two causes in one helper: a stop was claimed on
pid-liveness alone, and `stillSameProcess` returned a boolean over three distinct
situations, so a re-probe that merely **failed** was read as "already exited". Reporting a
restart that did not happen is worse than the stale picker this unit exists to fix.

**Then its mirror image.** Requiring the enumeration to confirm exposed the opposite
defect: `Win32_Process` lags after a kill, so the single confirming query still listed a
process that was already dead. The ladder declared `targets_survived`, skipped the
relaunch, and left the host with the app killed and never restarted. It was restored
immediately.

Both came from treating one weak reading as proof. Confirmation now polls until the
platform's own process list agrees, with a final look after the deadline, and a probe that
cannot run keeps the loop going rather than deciding either way. The kill and relaunch
primitives were correct on Windows the whole time; only the confirmation was wrong, in
both directions.

The lesson generalises past this unit: a design that says "fails closed" is not evidence
that the code does, and neither is a green focused test whose double models the world
more simply than the world behaves. The doubles here modelled exit purely through
`isAlive` and kept listing terminated processes, which is precisely why no amount of
review could surface either defect. They now drop a process from the enumeration once
liveness reports it dead.

## 3. What hosted CI found that local runs could not

- The macOS cases pointed at `/Applications/ChatGPT.app`, and discovery resolves the
  bundle through `realpathSync`, which touches the real filesystem and cannot be
  intercepted by the exec seam. They passed locally only because that machine has Codex
  installed. They now build a real bundle under a temp directory, realpathed there so the
  fixture and the adapter agree across the `/var` symlink.
- `privacy:scan` found a second user's home path in two files of this unit.

Neither was visible locally: the first because of what the machine happened to have
installed, the second because the scan was never run there.

## 4. Gate status at the merged head

- Hosted CI at `156e10776b`: 24 pass, 0 fail, 2 skipping.
- Local product suite, build and typecheck: **NOT RUN**, per `000` §2.
- Focused desktop-restart files: 50 pass / 0 fail.

## 5. Carried forward

- **Windows app-server exclusion is a no-op.** The probe enumerates `ChatGPT.exe` while
  Windows app-servers run as `codex.exe` / `codex-code-mode-host`, so they still receive
  SIGTERM before the app quits. The restart is correct; the cost is one extra interrupted
  turn. Widening that query changes what may be killed, so it needs its own verification.
  Documented at the decision point in `src/cli/restart-scope.ts`.
- **`ocx system codex-restart` refuses rather than handing off** when the proxy itself runs
  inside the Codex app, because a proxy never exits and the handoff waits for the caller.
- **The local-macOS handoff path is unproven on a live host.** It is implemented and
  unit-tested, and proving it ends the session that issues it, so it is deliberately the
  last action rather than an omission.
