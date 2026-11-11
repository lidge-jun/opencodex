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
- Order: wrappers end in part A, the child then stops through the caller's graceful path, and only then does part B check the port; `/api/stop` runs part A only.
- `ocx service uninstall` and `prepareServiceInstall` end a looping wrapper before deleting or replacing the task.
- A wrapper that matches image and path but fails lineage is not terminated → survived with `unbound-wrapper`.
- ARM64 fallback (if approved): CIM creation time bind, in-script StartTime recheck, `Kill()` on the same object.
- `ocx uninstall` runs part B after a part A `stopped` and keeps client configuration on any other outcome; service uninstall/install refuse before deleting/replacing the task on a non-stopped outcome.
- `/api/stop` with a receipt skips part A; the whole consented stop fits the stated budget with injected clocks.
- Guarded path: a stray wrapper bound by the rule is `bound-stray` and reaches part A; an unbindable one stays approval-changed.
- Output mapping per path: `ServiceStopOutcome`, `ocx-stop/1` (no new outcome/proxy enum values; additive fields only), `/api/stop` codes, Desktop parser unit tests with old and new documents; updater variant refuses without authorization at entry and before each terminate.
- New test files registered in the layout maps; no capped file grows (file-size ratchet).

## Real Windows device (required before the implementation merges)

| Case | Why it needs a device |
|---|---|
| Registered task, `/end` leaves the `wscript.exe` + `cmd.exe` loop alive; checked stop frees the port | Real Task Scheduler instance semantics |
| Killing the wrapper after `/end` does not fire restart-on-failure (PT1M × 3) | Scheduler retry behavior |
| Elevated (HighestAvailable) task stopped from an unelevated shell and from unelevated Desktop | Real access checks → denied; a command line hidden from a non-admin CIM query classifies as unknown or denied consistently |
| npm Bun runtime vs bundled `ocx.exe` | Different process trees and command lines |
| Logon/session-unlock trigger during a stop | Trigger timing |
| WinSW backend stop with `onfailure restart delay="5 sec"` against the part A (5 s wait) and part B (6 s hold) deadlines | Real SCM behavior |
| Slow startup / antivirus interference against the deadline | Timing on real hardware |
| Windows ARM64 | No FFI: bounded fallback (or unknown, if the owner chooses the strict variant) |

Evidence per case (redacted: no tokens, runtime-port.json contents, environment dumps or full command lines): outcome JSON, whether the port is free afterwards (`Get-NetTCPConnection -LocalPort <port>`), surviving process image names.
