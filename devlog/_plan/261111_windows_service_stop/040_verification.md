# 040 — Verification

## Hermetic (any CI host; existing non-live seams only: injected process table, scheduler probe, WinSW status, terminate primitive; no real schtasks/PowerShell)

- Binding: wrapper with this home's paths and a wrapper image bound; same path token under a non-wrapper image not bound; another home's wrapper not bound; substring-only match not bound; stray wrapper with the task not running bound by the stray rule; unreadable command line or creation time under the bound manager → unknown, nothing killed.
- `/end` accepted, wrapper survives → handle terminate of the wrapper only → child stopped through the graceful path → stopped.
- The child refuses the graceful stop (409) → never force-killed; outcome survived.
- In the guarded path, the wrapper is ended before `signalApproved`, and the approved PID still receives its graceful signal and teardown-deferral receipt.
- Child exits 0 and the wrapper relaunches within the deadline → survived (no unbounded retry).
- Access denied on `/end` or terminate → denied, no further kills.
- Creation time changed between bind and terminate (PID reuse) → that PID untouched.
- Port still answered by this installation's identity → survived; by a foreign identity → stopped + `portHeldByForeign`.
- Order: wrappers end in part A, the child then stops through the caller's graceful path, and only then does part B check the port. A receipt-backed `/api/stop` whose receipt records part A `stopped`/`absent` for the current manager runs neither part A nor part B; a receipt without that record gets today's route behavior; a route without a receipt and risk `none` runs part A only (part B belongs to the caller).
- `portHeldByForeign` after part B: install and backend switch stop before publishing assets or starting the service.
- With no registered task, an orphaned wrapper (parent gone) is not bound → `unbound-wrapper`.
- `ocx service uninstall` and `prepareServiceInstall` end a looping wrapper before deleting or replacing the task.
- A wrapper that matches image and path but fails lineage is not terminated → survived with `unbound-wrapper`.
- ARM64 fallback (if approved): CIM creation time bind, in-script StartTime recheck, `Kill()` on the same object.
- `ocx uninstall` runs part B after a part A `stopped` and keeps client configuration on any other outcome; service uninstall/install refuse before deleting/replacing the task on a non-stopped outcome.
- `/api/stop` with a receipt skips part A; the whole consented stop fits the stated budget with injected clocks.
- Guarded path: a stray wrapper bound by the rule is `bound-stray` and reaches part A; an unbindable one stays approval-changed.
- Output mapping per path: `ServiceStopOutcome`, `ocx-stop/1` (no new outcome/proxy enum values; additive fields only), `/api/stop` codes, Desktop parser unit tests with old and new documents; updater variant refuses without authorization at entry, before each manager stop and before each terminate.
- Plain `ocx stop`: part A `denied`, `survived` and `unknown` each send no `/api/stop` POST, set `ownershipBlocked`, skip the shared restore, and record `outcome: failed`, `proxy: unknown`, `sharedTeardown: skipped`.
- `absent`: no registered task or WinSW service and no bound wrapper → `ServiceStopOutcome` `absent`, no "Service manager stopped.", the POST is sent, part B does not run (no 6 s hold); the same with an unreadable process list → still `absent`, and plain `ocx stop` still stops the proxy.
- Budget, with injected clocks: admission refuses with `unverified-budget` and changes nothing (no `/end`, terminate or POST) when the remaining time is below the worst case still to come; once admitted, every step at its cap ends before the deadline; the graceful exit wait is never shortened; part B never gets less than 6 s; `--deadline-ms` from both Desktop paths is honored, and a missing flag means 60 s; macOS/Linux ignore it.
- `/api/stop` without a receipt, stray of a deleted task: the 4 s sweep plus the measured worst case of `performStopTeardown` answers within 10 s; every parent POST gets the full 10 s abort; a registered WinSW service keeps today's in-process stop.
- WinSW: a non-waiting stop plus an SCM poll capped at `<stoptimeout>` + 2 s; an overrun → `unknown` and nothing further; registration probes capped at 2 s, an unreadable `schtasks` answer stays `unknown`.
- The final enumeration runs after the 6 s hold; an unreadable result or a wrapper absent at bind → non-success; `ocx service stop` defers the teardown through a receipt and keeps it when part B fails; when the receipt claim fails and the teardown is owned, it sends no child stop and reports the failure; a wrapper that appears after part A is caught by part B before any teardown.
- The child exit ladder in sequence: an answered POST, a timed-out exit wait, then the forced kill (`taskkill` 5 s + `waitForExit` 5 s) all fit the admitted budget.
- Caps that are new: `taskkill` in the forced fallback times out at 5 s; orphan discovery at 3 s (overrun refuses); `revertSystemEnv` at 1 s; inherited-receipt probes counted as 3 s × N at admission (two hosts per probe); the measured worst case of `restoreSharedClientStateAfterStop` fits the reserve; a receipt without a part A record makes the route re-run part A within its 6 s cap.
- Admission runs after the registration probe: `absent` is never refused for budget.
- A wrapper relaunched after bind (port still free during the hold) is caught by the final enumeration → survived.
- Updater call sites, including the one in `preparePort`, abort on a non-`stopped` part A.
- New test files registered in the layout maps; no capped file grows (file-size ratchet).

## Real Windows device (required before the implementation merges)

| Case | Why it needs a device |
|---|---|
| Registered task, `/end` leaves the `wscript.exe` + `cmd.exe` loop alive; checked stop frees the port | Real Task Scheduler instance semantics |
| Killing the wrapper after `/end` does not fire restart-on-failure (PT1M × 3) | Scheduler retry behavior |
| Elevated (HighestAvailable) task stopped from an unelevated shell and from unelevated Desktop | Real access checks → denied; a command line hidden from a non-admin CIM query classifies as unknown or denied consistently |
| npm Bun runtime vs bundled `ocx.exe` | Different process trees and command lines |
| Logon/session-unlock trigger during a stop | Trigger timing |
| WinSW backend stop with `onfailure restart delay="5 sec"` against the WinSW cap (`<stoptimeout>` + 2 s) and the part B (6 s hold) deadline | Real SCM behavior |
| Slow startup / antivirus interference against the deadline | Timing on real hardware |
| Windows ARM64 | No FFI: bounded fallback (or unknown, if the owner chooses the strict variant) |

Evidence per case (redacted: no tokens, runtime-port.json contents, environment dumps or full command lines): outcome JSON, whether the port is free afterwards (`Get-NetTCPConnection -LocalPort <port>`), surviving process image names.
