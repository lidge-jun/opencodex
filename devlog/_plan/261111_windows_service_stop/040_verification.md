# 040 — Verification

## Hermetic (runs on any CI host; injected process table, scheduler and terminate seams)

- Bind: wrapper with this home's paths bound; a same-name wrapper under another home, a substring-only match, and an unreadable command line under the bound manager (→ unknown, nothing killed).
- `/end` accepted but wrapper survives → terminate bound wrapper → stopped.
- Child exits 0 and the wrapper relaunches within the deadline → survived (no unbounded retry).
- Access denied on `/end` or terminate → denied, no further kills.
- PID reuse between bind and terminate (start time or digest changed) → that PID untouched.
- Port still answered by this installation's identity at the deadline → survived; answered by a foreign identity → reported as such, not stopped.
- Outcome mapping in `ocx stop --json`, `ocx service stop`, and Desktop's stop handling; exit codes; records kept on non-stopped.

## Real Windows device (cannot be proven hermetically; required before merge of the implementation)

| Case | Why it needs a device |
|---|---|
| Registered task, `/end` leaves `wscript.exe` + `cmd.exe` loop alive; checked stop frees the port | Real Task Scheduler instance semantics |
| Elevated (HighestAvailable) task stopped from an unelevated shell and from unelevated Desktop | Real token/integrity-level access checks → denied path |
| npm Bun runtime vs bundled `ocx.exe` | Different process trees and command lines |
| Logon/session trigger firing during a stop | Trigger timing |
| WinSW backend stop | Real SCM behavior |
| Windows ARM64 (no in-process FFI) | Fallback command-line read and terminate path |

Evidence to collect per case (redacted: no tokens, runtime-port.json contents, environment dumps or full command lines): outcome JSON, whether the port is free afterwards (`Get-NetTCPConnection -LocalPort <port>`), and the surviving process names.
