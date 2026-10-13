# 020 — Design: opt-in health sentinel

The final design, as implemented, is recorded in `structure/ops/service-health-recovery.md`
(activation, policy, kill binding, persistence, coverage). This document keeps the reasoning and
the audit trail that shaped it. The summary below is the shape after all four rounds; each round's
table records what changed at that point, and a later round can supersede an earlier disposition.

## Current shape

- **Activation.** `serviceHealthRecovery.enabled` (metricsExport contract). Spawned from `ocx start`
  after `reconcileClientStartupBeforeReady`, only for a managed service child that is not a
  sibling. npm/Bun installs run `src/service/health-sentinel-main.ts`; standalone binaries run the
  private `__health-sentinel` argv. The desktop sidecar is not a managed service child and keeps its
  own Rust supervisor (follow-up: count timeouts there with the same policy).
- **Lifetime.** Allowlisted environment with absolute paths; stdin pipe as lifeline; withdrawn by a
  drain-start hook (`runDrainStartHooks`, called right after `beginShutdownDrain()`) and by
  `syncCleanup`.
- **Policy.** 30 s cadence while healthy, 1 s between probes once one has timed out, 20 s deadline,
  120 s grace, arm on an identified answer, 3 timeouts and 60 s span (≈62 s continuous silence),
  backoff ×2 per recovery in the last hour, cap 3 per hour, pause, clock-step and sentinel-lag guards.
- **Kill binding.** Windows: kernel32 handle opened at startup via `bun:ffi`, accepted only if the
  parent was created before the sentinel, `TerminateProcess` through it. POSIX: live `ppid` check
  immediately before SIGKILL.
- **Coordination and persistence.** The final re-read and the durable `intent` write run under the
  ownership mutation lease (500 ms wait, `processImage: () => null` so no subprocess); busy defers.
  The lease is released before the kill, because on Windows the sentinel may end with the proxy and
  a lease it still held would delay the replacement's startup (round 3). Every history write takes
  the lease. History fsync + rename + POSIX directory fsync, fail closed, entries settle as
  `terminated` / `unconfirmed` / `failed` / `skipped`.
  The replacement prints one line about a recent recovery.

## Audit round 1 dispositions (GPT-6.1-Sol, FAIL)

| # | Finding | Disposition |
|---|---|---|
| 1 | Pipe openness is not atomic identity | Folded: live `ppid` check on POSIX immediately before the kill; Windows co-termination through libuv's kill-on-close Job |
| 2 | Windows Job kills the sentinel with the parent | Accepted as intentional co-termination; everything is persisted before the kill; Windows CI test asserts proxy exit, history entry and sentinel exit |
| 3 | Bootstrap and references | Folded: absolute paths and pid in dedicated variables; subprocess and sink retained |
| 4 | Disarm on transitions | Partly folded (shutdown hook + `syncCleanup`, spawn after ready). Rebutted for drain: a drain keeps the loop running, so it answers or is refused; only a stuck drain accumulates timeouts |
| 5 | Ownership revalidation | Folded: sibling records excluded, record re-read before the kill, POSIX parent identity. Rebutted: the config mutation lease guards config writes, not process termination; holding it from a sentinel would couple it to a lock a hung proxy may hold |
| 6 | Persistence | Folded: fail closed on unreadable history or failed write; `{at, pid}` entries; next start reports a recent recovery |
| 7 | Timing negative controls | Folded: pause guards, negative-clock guard, negative-control tests |
| 8 | Restart conditions / crash state | Folded into Acting (WinSW added); stale-record cleanup is the existing crash path, unchanged |
| 9 | Reuse and config details | Folded: `directLocalHttpFetch`; metricsExport-identical config handling; locale docs named in the PR |

## Audit round 2 dispositions (GPT-6.1-Sol, FAIL)

| # | Finding | Disposition |
|---|---|---|
| 1 | ppid narrows but does not close the check-to-kill race | Windows (fast id reuse): folded with a held process handle and creation-time check. POSIX: history and log writes moved before the parent check, so the check is the last step before `kill`; reuse inside that window needs a full wrap of a sequential pid space. Accepted residual, documented |
| 2 | libuv ignores Job assignment failure | Folded: Windows no longer relies on the Job; the handle survives either way and the sentinel still exits on EOF |
| 3 | Bootstrap | Resolved in round 2 |
| 4 | Startup readiness; stop semantics under a stalled drain | Folded: spawn after startup reconciliation; drain-start hook withdraws the sentinel before in-flight work is awaited |
| 5 | Ownership mutation lease | Folded: the final checks run under `acquireOwnershipMutationLease`. (Superseded in round 3: the lease now covers the re-read and the `intent` write and is released before the kill.) |
| 6 | Durability, serialization, intent vs confirmation | Folded: fsync before rename, writes under the lease, two-phase entry states, notice wording follows the state |
| 7 | Phase-aligned recurring stalls | Folded: back-to-back probes after a timeout; test sweeps every 500 ms phase of 23 s stalls every 50 s and shows a fixed cadence would have recovered (not vacuous) |
| 8 | Kill/restart coverage | Folded: process test drives the real launcher and sentinel against a fixture that stops answering (and one that exits by itself) on every CI OS. Stale pid/runtime records after a hard kill take the existing crash path, unchanged here |
| 9 | Standalone contradiction | Fixed in this document |

## Audit round 3 dispositions (GPT-6.1-Sol, FAIL)

| # | Finding | Disposition |
|---|---|---|
| 1 | POSIX check-to-kill window | Rebutted as an accepted, documented residual. `process.ppid` changes at the parent's exit, before the parent can be reaped and its id freed; reuse inside the window additionally needs the id space to wrap (99,999 on macOS; `pid_max`, typically 4,194,304, on Linux) between two adjacent syscalls. Windows, where ids are reused quickly, uses the held handle |
| 2 | Windows lifetime | Accepted by the auditor; comment on Windows `ppid` semantics corrected |
| 4 | Late activation during a drain that began mid-startup | Folded: `!shuttingDown` at the call site and `didRunDrainStartHooks()` in the launcher |
| 5 | Ownership revocation not read | Rebutted: the sentinel changes no ownership. It only ends a hung process; whether anything restarts is the manager's decision, and a restarted child passes the existing service-child ownership gate at startup. The lease still serializes the decision against ownership transitions |
| 6 | Settlement outside the lease; rename durability | Folded: every history write takes the lease; directory fsync after rename on POSIX (Windows cannot open a directory for fsync; documented) |
| 7 | Sub-slack pauses | Folded: slack lowered from 30 s to 5 s. Residual: pauses under 5 s can lengthen a probe by at most 5 s each, which cannot fabricate ~62 s of continuous silence |
| 8 | Supervisor restart validation | Partly folded: a contract test pins each manager's restart-on-unclean-exit rule and the sentinel's kill choice. An end-to-end restart needs an installed service and is out of CI scope; stale records after a hard kill take the existing crash path |
| new | HANDLE marshalling (`ptr`, pseudo-handle -1) | Folded: HANDLEs are u64 bigints; the sentinel opens itself by id instead of using the pseudo-handle |
| new | Windows co-termination strands the lease | Folded: the lease is released before the kill; settlement re-takes it |
| new | Unbounded test cleanup | Folded: every wait in the process test is bounded, and a surviving sentinel is reaped |

## Audit round 4 dispositions (GPT-6.1-Sol, FAIL) and A-phase decision

| # | Finding | Disposition |
|---|---|---|
| 1 | POSIX identity; the "full wrap" argument is wrong | Accepted that the argument was wrong: the allocator may already sit just before the parent's id, so reuse needs only exit, reap and one new process landing on that id while the sentinel is descheduled between its last check and `kill`. The POSIX path is therefore probabilistically safe, not identity-bound. Documented as such and flagged for explicit maintainer acceptance in the PR; Windows, the platform of #6671, is identity-bound |
| 2–5, 8, 9 | Windows lifetime, bootstrap, late activation, ownership, restart validation, conventions | Resolved or acceptably rebutted per the auditor |
| 6 | Directory fsync swallowed EIO | Folded: only "unsupported" codes are tolerated; storage errors fail the write, so no kill follows |
| 7 | Sentinel pauses ending near each deadline | Folded: a wall-clock lag monitor in the sentinel; a timeout during which the sentinel's own loop ran more than 2 s late is discarded (test reproduces the auditor's t / t+21 s / t+42 s scenario) |

A-phase verdict (main agent): **near-pass**. Four independent rounds; every correctness finding is
folded. Residuals carried into the PR: POSIX kill is probabilistically bound (maintainer decision);
real supervisor restart after the kill is verified by contract tests, not by an installed service.
