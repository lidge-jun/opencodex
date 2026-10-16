# wp2 — #6649 restart admission with a full service-record fingerprint

## Problem

`ocx restart` on the update path (newer CLI, standalone proxy) refuses whenever a service install record exists, even if no supervisor runs it, for example a launchd plist that is installed but not loaded. #6649 relaxed that to supervisor liveness. Maintainer triage (2026-10-08) held it: the snapshot in `src/cli/update-restart-home.ts:22-31` records home identity and the ownership revision, not the service record. A record replaced without a revision bump therefore passes `assertUpdateRestartHome()`. The precondition is a full service-record fingerprint, revalidated through stop and replacement admission. The journal half of #6649 already landed via #6686 (7f3f3689a3) and is excluded.

## Decisions (architect proposal → main disposition)

- **D1 record boundary — ACCEPT.** New `src/cli/update-restart-service-record.ts` captures every `serviceStatePaths()` candidate (`src/service/state.ts:178`), including absent ones, with the authoritative position. On POSIX it also captures the applicable platform definition (launchd plist `state.ts:142`, systemd unit `systemd.ts:47`). Service state and ownership derive from the captured bytes, not from independent reads.
- **D2 fingerprint — ACCEPT.** Per candidate: absence (only confirmed ENOENT), or SHA-256 of the bytes plus bigint `dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`, mode, uid, and gid, read without following symlinks, with stat before and after the read. One SHA-256 digest over a canonical ordered encoding goes into `UpdateRestartHome.serviceRecord = { schema: 1, digest }`. A symlinked record, inconsistent read, parse failure, or EACCES refuses. An identical-byte rewrite is deliberately refused; the user retries. Lock and runtime-publication files are excluded because the transaction itself writes them.
- **D3 supervisor evidence — ACCEPT, scoped.** New `src/cli/update-restart-supervision.ts` returns `inactive | active | unknown`. launchd checks both domains with a bounded runner and blocks on `unknown`. systemd requires `inactive` plus `MainPID=0`. Windows keeps refusing exactly as today. Only `inactive` admits.
- **D4 revalidation points — ACCEPT.** The fingerprint is captured once in `requestBoundSystemRestart` (`src/cli/system-restart-client.ts:96`). Fingerprint and supervision are then rechecked after the parent lease, in `beforeStop()` with no intervening await, after confirmed shutdown, synchronously before spawn, in the child before and under its lease, and in the existing child admission checks before bind, after bind, and before PID publication. The parent checks once more before reporting success. Any drift is terminal: no recapture and no second spawn.
- **D5 L1 separation — ACCEPT.** Only restart-specific CLI modules change.
- **Amendment A1.** The current refusal (`state.kind !== "none"`) relaxes only for `kind === "installed"` records whose ownership is `none`, on darwin or linux, with `inactive` supervision. Every other existing refusal stays in force: ownership claims, unreadable state, foreground parents, client and sibling roles, fenced trees, attestation, deadlines, and Windows.

## File change map

| File | Change |
|---|---|
| `src/cli/update-restart-service-record.ts` (new) | `captureUpdateRestartServiceRecord()`, `assertUpdateRestartServiceRecord()` |
| `src/cli/update-restart-supervision.ts` (new) | `probeUpdateRestartSupervision(deadlineAt, deps)` |
| `src/cli/update-restart-home.ts` | `serviceRecord` field, relaxed `readUpdateRestartHome` per A1, assert compares the digest |
| `src/cli/update-restart.ts`, `update-restart-child.ts`, `update-restart-transport.ts` | revalidation at the D4 points; digest in the child marker |
| `src/cli/index.ts` | only if the child bind checks live there (keep the edit to one guard call) |
| tests: `tests/cli/cli-update-restart-service-record.test.ts`, `cli-update-restart-supervision.test.ts` (new; register in layout.json and test-layout-expected.json), plus existing `cli-update-restart{,-home,-child,-transport}.test.ts` and `system-restart-client.test.ts` | |
| `structure/runtime.md`, `structure/ops/service-and-sidecars.md`, `docs-site/.../reference/cli/lifecycle.md` | contract sync |

## Acceptance (activation scenarios)

1. Installed but unloaded launchd/systemd record, ownership none, inactive supervision: the update restart proceeds. Test fixtures inject the record and an `inactive` probe.
2. Same-revision provenance change, identical-byte replacement (new inode), or same-size edit with restored mtime between capture and any D4 point: `update_restart_home_changed`, zero stop POSTs before the refusal, zero spawns after it.
3. Supervision `active` or `unknown` (launchd exit codes other than 112/113, systemd `activating`, MainPID>0, malformed output, timeout): refuse.
4. Symlinked record, EACCES, or invalid JSON: refuse.
5. Windows with any record: refuse, unchanged.
6. Every pre-existing refusal test in the restart files still passes unchanged.

Verification: the files above via `bun scripts/test.ts`, plus `bun run typecheck`, `structure:check`, and `privacy:scan`. Hosted CI covers macOS, Windows, and Linux. A security review by an independent sol reviewer is required before ready.

Co-author: `Co-authored-by: agentHits <140916359+agentHits@users.noreply.github.com>`.

## Reflection dispositions (architect 01a11e35-f359, MISALIGNED → folded)

1. **A1 discriminant — FIX.** `ServiceStateResolution` is `none | state | unknown` (`src/service/state.ts:584`). A1 now reads: `state` (valid present record) with ownership `none` on darwin/linux and `inactive` supervision admits. `none` stays eligible. `unknown` always refuses.
2. **Pathname identity — FIX.** After the read, `lstat` of the pathname must match the descriptor's `dev`/`ino`. Candidate membership is recomputed on every assert. Tests add authority/mirror creation, deletion, and conflict, plus home-alias cases.
3. **Supervision independent of the definition — FIX.** Both launchd domains are probed even when the plist is absent. Each probe runs a bounded command with the remaining transaction deadline, and the deadline is checked again afterwards. `runLaunchctl` is not reused unbounded; the new module injects its own bounded runner.
4. **Child publication checks — FIX.** Fingerprint and supervision are checked before runtime-record publication and at `complete()` (existing hooks, `src/cli/index.ts:599-606`), and repeated after the async Bun-readiness wait. The plan prefers extending the existing guard callback so that `index.ts` (1976/1999) needs no edit, or at most one line.
5. **Marker contract — FIX.** The child marker requires `serviceRecord.schema === 1` and a 64-character lowercase hex digest. A missing or malformed value refuses before lease and preflight, with no legacy fallback.
6. **Phase-specific assertions — FIX.** Drift before stop: zero stop POSTs. Drift after stop and before spawn: zero spawns. Drift after spawn: no second spawn, no success report, and the child refuses or rolls back at its checkpoint.
7. **Ratchet accounting — noted.** `index.ts` 1976/1999, `update-restart-transport.ts` 193/1999, layout 23 lines of headroom.

## A-audit dispositions (auditor 01a11e3f)

- **B5 production admission — FIX.** In `standalone()` (`src/cli/update-restart.ts:195`), the blanket `diagnoseService().installed` refusal is replaced by A1. A present record admits only when the captured fingerprint shows ownership `none` and `probeUpdateRestartSupervision()` returns `inactive` within the remaining deadline. `inspectGuardedManagerTarget` at `:196` is PID-bound and stays; it already blocks a manager-bound target. Tests drive the production `standalone` validator and `runUpdateRestart` with injected `home`/`checkHome`/`standalone` deps. The success case covers an installed-but-unloaded record. Each failure case flips supervision to `active` between two D4 checkpoints and asserts refusal at the next checkpoint.
- **B5 re-audit — bounded retained probe.** `standalone()` passes deadline-aware `launchctl` and `systemdShow` deps into `inspectGuardedManagerTarget` through its existing seams (`src/service/guarded-manager-target.ts:73-75`). Both use the bounded runner from `update-restart-supervision.ts`, with a timeout of `min(2000, deadlineAt - now)`. A timeout or a remaining budget of zero or less refuses (`unverifiable_ancestry`). Test: supervision first reports `inactive`, then the retained manager probe times out, so the run refuses terminally with zero stop POSTs and no success report.

## P revalidation (wp2 cycle, 2026-10-09)

- `origin/dev` is still c15037b324, and no file in this change map has moved.
- **L1 overlap (corrected after the wp2 A-audit).** L1 (`codex/desktop-sidecar-cli-authority`, plan docs only so far) plans to modify `src/cli/update-restart.ts` itself (`020_command_guards.md:517-534`). It adds `inspectSupervision` to `UpdateRestartIo` and a `"desktop"` eligibility reason, inserts a Desktop veto inside `runUpdateRestart`'s `revalidate` before the `io.standalone` call, and wires it in `restartFromCurrentInstallation`. It also expands `tests/cli/cli-update-restart.test.ts` (`:650-664`), and edits `src/cli/index.ts` lifecycle and status (≤ +5 lines).
- **Integration seam that keeps wp2 out of L1's block.** wp2 adds no lines inside `runUpdateRestart`. Every parent D4 checkpoint goes through `io.checkHome(home)` (`assertUpdateRestartHome`), which `runUpdateRestart` already calls in `revalidate` (initial and `beforeStop`), at both prelaunch points, and on every replacement-loop iteration. That function recaptures the service-record fingerprint and runs the bounded supervision probe. The eligibility relaxation lives only in `standalone()`. wp2's edits in `update-restart.ts` are confined to `standalone()` and the deps object in `restartFromCurrentInstallation`. The latter is the only shared hunk with L1, an additive deps merge. wp2 tests go in new files and do not touch L1's planned cases in `cli-update-restart.test.ts` beyond fixture updates the new `UpdateRestartHome` field requires.
- **Ordering.** L1 is the critical fix and is expected to merge first. Whichever PR merges second rebases and adds a combined regression in its own new test file: an installed but inactive service record stays unchanged while same-PID Desktop supervision appears before the final `beforeStop` revalidation, and the result is zero stop POSTs, zero spawns, and reason `desktop`. The second PR also reconciles the shared structure-doc paragraphs. `index.ts` growth (1976 + 5 + ≤1) stays under the 1999 cap.
- The architect consultation (proposal and reflection) and the independent audit were completed in wp1 against this same `dev` head. This cycle executes this document as written.
