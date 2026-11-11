# 060 — Implementation slices

The owner approved 030 with the bounded ARM64 fallback. The work lands in three pull requests so each one is reviewable on its own, and only the second changes behavior.

## PR1: primitives and the two operations (this slice)

Library code with hermetic tests. Nothing calls it yet, so no platform's behavior changes.

| Module | Content |
|---|---|
| `src/service/windows-process-native.ts` | x64 FFI from the trusted system directory: `GetProcessTimes` creation time, the handle terminate (open, compare creation time on that handle, `TerminateProcess`, close), the bind-time exit watch, `QueryServiceStatusEx` for the Schedule host PID |
| `src/service/windows-process-evidence.ts` | facades: the CIM snapshot with `CreationDate` (native times on x64 kept only when they agree with CIM to the ms), `sc.exe queryex Schedule` fallback, the ARM64 PowerShell terminate, the watch |
| `src/service/windows-stop-binding.ts` | the 030 binding rule as a pure function: bound (deepest first, pid + creation time + image + command-line digest), unbound, unreadable |
| `src/service/windows-stop-budget.ts` | the caps and the admission arithmetic of the 030 tables, plus the part B window |
| `src/service/windows-checked-stop.ts` | part A, `stopWindowsServiceChecked(deps, options)` with every effect injected, admission after the registration probe, and the authorizer variant `guardedStopWindowsServiceChecked` |
| `src/service/windows-stop-confirm.ts` | part B, `confirmWindowsStopFreed(deps)`, and `resolveWindowsStopPort` |

Contract doc: `structure/ops/windows-checked-stop.md`.

## PR2: caller wiring

- Live deps adapters for part A and part B: capped `schtasks /query` and `/end` (2 s, through the test-home guard), WinSW non-waiting `stop` (2 s) and `sc query` polling, a port sampler, the listener identity check (`findLiveProxy` identity), and the clock.
- `stopServiceIfInstalledDetailed` and the guarded `stopManager` slot become async on every platform. On Windows they call part A instead of `stopWindowsChecked` plus `killWindowsServiceWrapperProcesses`, and all their callers change in the same PR.
- Part B replaces `proxyStillLiveAfterStop`, the `schedulerCanRespawn` re-poll and the uninstall respawn window on Windows, and is added after the guarded `settle`.
- `ocx stop --deadline-ms <n>`, also read from `OCX_STOP_DEADLINE_MS` so a Desktop can pass a deadline to an older CLI without that CLI rejecting an unknown flag. The flag wins over the variable, and 60 s applies when neither is set.
- `ocx-stop/1` additive fields `serviceStopReason` and `portHeldByForeign`, with no new `outcome` or `proxy` value.
- The receipt's part A record (`partA`, the bound manager, and the ended wrapper set as pid + creation time), and `/api/stop` skipping part A for a receipt that carries it.
- The guarded inspection's `bound-stray` state through the binding rule, `sameGuardedManager` comparing the bound wrapper set.
- Service uninstall/remove and `prepareServiceInstall` refuse on a part A outcome other than `stopped`, and on a part B result other than a free port.
- The updater's three call sites move to the authorizer variant and abort on a non-`stopped` outcome (`preparePort` becomes async or part A runs before it).
- The new caps from 030: the forced `taskkill` at 5 s, orphan discovery at 3 s, and `revertSystemEnv` at 1 s.

## PR3: Desktop

- Optional `serviceStopReason` / `portHeldByForeign` fields on `StopSummary` (`serde(default)`), with the elevation hint and the warning text.
- The exit/restart drain deadline goes to 75 s on Windows, and the deadline passes through `OCX_STOP_DEADLINE_MS` (and `--deadline-ms` once the CLI floor allows it) on both the takeover and the drain.

## Where PR1 differs from 030

- **Part B's closing sample.** The 6 s hold is measured between port sample starts, and the window floor is also 6 s, so the last sample starts at the window's end and can run up to its 0.5 s cap past it. The budget counts this, which raises the admission minimums to 48.5 / 56.5 / 42.5 s. The Desktop drain case becomes 70.5 s, which still fits in 72 s.
- **WinSW binds nothing.** WinSW-only part A neither enumerates nor binds. This follows 030's step 4 and its 25 s row: a stray scheduler wrapper left behind by an earlier backend is caught only when nothing is registered. "Proxy still alive after WinSW stopped" is an injected `proxyAlive` check inside the 1 s manager-state step. An answer of "cannot tell" leaves the decision to part B.
- **Terminates share the wait cap.** 030's tables do not price the terminate calls themselves. They share the 3 s handle-wait window, which matters for the ARM64 script (about 1 s each).
- **Unbound wrappers with nothing registered.** Binding finds no bound wrapper but an unbound one is alive. The result is `survived` / `unbound-wrapper`, not `absent`, matching 040's bullet; the 030 "absent" definition reads as "nothing bound" alone. Nothing is changed either way.
- **Unreadable candidates with nothing registered.** An unreadable wrapper image above the child counts only while a manager is registered. A hand-started proxy under an elevated shell would otherwise lose the stop it gets today. A matching wrapper without a creation time stays `unknown` even with nothing registered.
- **Snapshot type.** The snapshot type is `WindowsStopProcessEntry`, which is `WindowsProcessEntry` plus `startTime`, in the evidence module. `windowsProcessList` and the guarded inspection stay untouched until PR2 switches them.
- **The Schedule PID is read before admission.** Part A reads the Task Scheduler host PID from the SCM (cap 2 s) right after the registration probe, before admission, whenever a task is registered or a stray sweep runs. 030's tables do not list this read. Admission measures the time left on the caller's deadline, so the read's actual elapsed time is already taken out of what admission sees, the same way the step 1 stray enumeration is.
- **Not every effect is capped.** The registration probes, enumeration, Schedule PID, `/end`, WinSW stop and poll, terminates, manager state and `proxyAlive` run under caps. `openWatch` and the authorizer do not. `openWatch` is one `OpenProcess` per wrapper with no wait in it. The authorizer runs before each terminate, inside the shared 3 s terminate-and-wait window, so a slow authorizer eats that window: the next terminate gets less time, and an authorizer that never returns hangs Part A. PR2's authorizer (the updater's `mutationGate` check) has to be bounded by its caller.
- **Fractional timeouts.** A cap derived from the deadline (`windowEnd - now`) is fractional on the real clock. The spawned terminate fallback floors it to whole milliseconds before building the script and calling `execFile`, and spawns nothing when it floors to 0, because `execFile` reads a 0 timeout as "no timeout".

## ARM64 decision for PR2

050 requires an ARM64 device run before the bounded fallback ships; without one, ARM64 ships the strict variant (report `unknown`, kill nothing). No ARM64 device run exists, so PR2 ships the strict variant. PR1 still contains the fallback script, and `terminateWindowsProcessBound` reaches it on its own: on win32 without the FFI primitive (ARM64, or an x64 whose DLL load failed) it runs the PowerShell script. PR2's terminate adapter therefore has to gate strict itself, for example by answering `unavailable` whenever `windowsProcessNative()` is null, and must not call `terminateWindowsProcessBound` there. Without a native API `openWindowsProcessWatch` already answers `unavailable`, so the wait reports `unknown` rather than proving an exit.

## Notes for PR2

- **The route's caps.** 030 caps the `/api/stop` route's stray sweep at 4 s and its receipt-less Part A at 6 s. `stopWindowsServiceChecked` has no overall cap: its own caps add up to more (the stray path alone has a 5 s enumeration), and it never returns before its steps do. The route needs an outer race on its deadline that answers `service_state_unknown` on overrun, or cap overrides passed in, such as a 4 s enumeration for the sweep.

## Open questions

- Is the closing-sample accounting acceptable, or should the hold be measured differently, for example by shortening the final enumeration to 4.5 s to keep 030's totals?
- Should a WinSW-only stop also sweep a stray scheduler wrapper (that would add an enumeration and 3 s to the WinSW row)?
- `GetLastError` after a failed `OpenProcess` through Bun FFI separates "gone" from "denied". If the runtime clobbers it, the answer degrades to "unavailable" (`unknown`). The live x64 test in `tests/windows/windows-process-evidence.test.ts` checks this on the Windows CI lane.
