# 000 — Windows service stop that frees the port (#7771 Option B): design

Status: approved (030). Implementation is split into three pull requests (060): PR1 (primitives and the two operations, #8564) and PR3 (Desktop, #8560) have landed; PR2 wires every caller. ARM64 ships the strict variant until the 040 ARM64 device case runs (050, 060).

## Problem

On Windows with the Task Scheduler backend, neither `ocx stop` nor `ocx service stop` can prove that the proxy port is free afterwards. `schtasks /end` ends the task instance but often leaves the wrapper (`wscript.exe` running the launcher VBS, then `cmd.exe` running the service script) alive, and the wrapper's `:loop` relaunches the proxy about five seconds later. Desktop then sits at `taking-over`, a second `ocx start` loses the port, and an update can race a respawned runtime. Issue #7771 tracks this; its 2026-10-28 design comment proposed options A (diagnostics), B (one checked stop) and C (a cooperative wrapper handshake) and recommended A first, then B.

What has shipped since: refusal diagnostics (#7973, option A), in-process command-line reads so the guarded takeover can verify the bundled runtime (#8487), and `ocx service restart` no longer reporting success while the old runtime answers (#8487). The port-freeing stop is what remains.

## Documents

| Doc | Content |
|---|---|
| 010 | Current stop paths, source-backed |
| 020 | Options and how they compare |
| 030 | Recommended design: one checked Windows stop |
| 040 | Verification: unit, hermetic integration, and real Windows device |
| 050 | Risks, compatibility and rollout |
| 060 | Implementation slices and where the code differs from 030 |

## Decision requested

Approve 030 (recommended: option B split into part A, a checked manager-and-wrapper stop, and part B, the caller's port confirmation after its graceful child stop, used by every Windows stop path including service uninstall and install/backend switch: `ocx stop` with and without a consent snapshot, `ocx uninstall`, `/api/stop`, `ocx service stop` and the updater's Windows stop; an explicit binding rule including the stray-wrapper case; a new creation-time reader and handle-based terminate; outcomes mapped additively onto `ServiceStopOutcome`, `ocx-stop/1`, `/api/stop` and Desktop). Also decide the Windows ARM64 variant (recommended bounded fallback vs strict, 030/050). Implementation starts only after that approval and needs a Windows host for the acceptance checks in 040.
