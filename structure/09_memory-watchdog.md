# Memory Watchdog SOT

## Why this exists

Field incident: OpenCodex on Bun reached **~79 GB private/committed memory while the working set
stayed ~5.8 GB**, freezing the box once the **system commit charge hit ~97% of the commit limit**.
The Bun/mimalloc native allocator retains committed memory the JS heap has already released
(mirrored upstream by Claude Code #36132); no in-app JS cache cap can fix native retention. The
locally-run stress harness reproduces the detectability signature on a healthy machine
(`afterClear private/RSS = 4.4–4.8` after clearing the JS store and forcing GC).

The only proven mitigation is to **observe the pressure and, opt-in, hand off to a graceful
restart**. Everything below follows from that.

## Platform scope (PR reviewers: read this first)

The watchdog is **cross-platform**; only the measurement *fidelity* differs per platform. This is
NOT a Windows-only patch, but the motivating incident, the highest-fidelity probe, and the v1
system-commit axis are Windows-specific.

| Layer | win32 | linux | other |
| --- | --- | --- | --- |
| Process pressure source | Private Bytes (async PowerShell probe) | VmRSS+VmSwap (`/proc/self/status`, no spawn) | RSS (in-process) |
| System commit axis (v1) | measured (CommittedBytes/CommitLimit) | not measured (`systemCommitAvailable=false`; `/proc/meminfo` `Committed_AS` is a documented follow-up) | not measured |
| Decision core (warn/critical, cooldown, max-restarts, history seeding) | identical | identical | identical |
| Quiet-window drain + exit-75 restart, supervisor gating | identical | identical | identical |
| Dashboard / management API / i18n | identical | identical | identical |

The commit-axis logic itself is platform-neutral and null-safe: on platforms without measurement
it simply skips (no NaN propagation, latch held), so enabling a Linux collector later is additive.

## Architecture: async collect, sync decide

```text
self-rescheduling probe loop (unref'd; first probe fires IMMEDIATELY at start)
  └─ captureMemorySnapshot() — async, never throws, never blocks the event loop
       win32: ONE hidden PowerShell child (array args, -NoProfile -NonInteractive) returns
              labeled values P=/C=/L=/A= (private, committed, commit limit, available physical;
              Win32_PerfRawData_PerfOS_Memory — all bytes, verified live). 15s budget
              (measured cold spawn: 4.0–5.9s); timeout kills the child; first-resolution-wins
              drops late results; failures degrade to an RSS fallback with a sanitized probeError.
  └─ tick(state, cfg, deps, snapshot) — sync, pure-core evaluate(), EXACTLY once per probe
       axis 1 PROCESS: pressure/physicalRAM vs warn(0.60)/critical(0.75) → opt-in restart path
       axis 2 SYSTEM COMMIT: observe-only high-water warning (see below), NEVER restarts
  └─ report cache (memory block, responseStateMetrics, lastProbeAt/lastSuccessfulSystemProbeAt)
       computed once per probe — a 5s dashboard poll never re-serializes the response store
```

Key invariants, each defended by a regression test:

- **The probe never blocks the event loop.** The original implementation used `Bun.spawnSync`
  (up to 2s synchronous stall per tick on Windows) — flagged as a deploy blocker by audit and
  replaced. A streaming proxy must not pause SSE for measurement.
- **Exactly one evaluation per probe.** Timeout → RSS-fallback evaluation, and a late success for
  the same probe is dropped; an unexpected `capture()` exception evaluates once on
  `rssFallbackSnapshot(..., "capture-threw")` instead of silencing the cycle.
- **A restart owns the exit.** `tick()`'s restart hook synchronously stops the watchdog;
  `probeOnce` pins its instance in a local and re-checks IDENTITY against the global after
  capture, after tick, and before rescheduling, so the stopped/replaced singleton is never
  touched or rescheduled (pre-fix this was an unhandled TypeError on every real auto-restart).
- **Stop kills the child.** `stopMemoryWatchdog()` aborts the in-flight capture via
  AbortController and a generation guard drops any result that still arrives.

## System-commit axis: why observe-only (v1)

`systemCommittedBytes / systemCommitLimitBytes >= 0.90` (env-only override
`OCX_MEMORY_WATCHDOG_COMMIT_HIGH_WATER`, clamped [0.50, 0.99]) logs ONE latched warning; the latch
re-arms only on a MEASURED recovery — measurement loss (probe failure) holds it, so a flapping
probe cannot re-warn each time it returns.

It never contributes to the restart decision because the commit pressure may come from **another
process**: restarting OpenCodex would not free it, and an automated restart loop against an
external cause is worse than a loud warning. Honest consequence, stated up front: **v1 does not
auto-mitigate the original incident** (79 GB / 128 GB RAM ≈ 62% process pressure < 0.75 critical;
system commit 97% → warning only). Promoting the commit axis into the restart decision, and any
UI-configurable thresholds, are deliberately deferred until field measurement validates the axis.

## Restart path (quiet-window) and honest loop guards

- `restartGraceMs` (default 30s, clamped [1s, 10min] on every entry path — env, config file,
  management API which 400s out-of-range values): draining rejects new turns with 503+Retry-After
  and returns the moment the in-flight set empties, so the restart lands on a natural idle gap and
  the value is a DEADLINE, not a delay.
- `minRestartIntervalMs` is normalized to ≥ `restartGraceMs` so a second restart can never arm
  inside the first drain window.
- Cooldown/max-restarts counters die with the process a restart ends, so they are re-seeded from
  a best-effort timestamps-only history file (rolling ~6h window, atomic-rename write, every
  failure swallowed). This is **not** a permanent cross-process guarantee: the supervisor's own
  restart limit/backoff (pm2 `max_restarts`, systemd `StartLimitBurst`) remains the outer layer,
  and exit code 75 is only a *request* to respawn. NSSM / Windows services are not auto-detected —
  set `OCX_SUPERVISED=1` there.

## Verification evidence (as merged)

- Unit/integration: `tests/memory-watchdog.test.ts` (66), `tests/memory-restart-history.test.ts`
  (11), `tests/memory-api.test.ts` (16) — includes a REAL Windows end-to-end probe test asserting
  private bytes and a sane commit fraction from the live labeled command.
- Live measurements on a Windows 11 box: probe cold spawn 4.0–5.9s (hence the 15s async budget);
  `Win32_PerfRawData_PerfOS_Memory` values confirmed to be bytes; harness detectability
  `afterClear private/RSS = 4.4–4.8`.
- Gates: `typecheck`, `lint:gui`, `build:gui`, `privacy:scan` all exit 0. `probeError` carries
  sanitized codes only (never raw command output/paths) — privacy-scan enforced.
- Full-suite caveat: on the development Windows box the suite exits 1 due to pre-existing
  environment failures (NTFS ACL hardening `EACCES` clusters in auth tests + branch-dependent
  release-helper tests). Evidence that these are unrelated: the failure set at this branch's HEAD
  is a strict subset (321 ⊂ 345, zero new files, zero memory-file failures) of the same run at the
  pre-change baseline commit under identical conditions.

## Audit trail

Three independent audit rounds shaped this design (summarized honestly rather than re-litigated):

1. Initial audit (deploy blockers): synchronous `spawnSync` probe stall, missing system-commit
   measurement, 60s startup blind spot, RSS-only stress assertions, unwired response-state
   metrics → all five confirmed against code and fixed by the async rewrite.
2. Design review: chose "cached-free" probe-completion-driven evaluation over defer-until-idle
   and blue-green alternatives (complexity/regression cost vs. benefit), kept warn-only defaults.
3. Post-implementation audit: auto-restart race in `probeOnce` (unhandled TypeError), capture-throw
   silence, positional PowerShell parsing, live re-clamp gaps → all four fixed with regression
   tests (the race test was validated to fail against the pre-fix code).

## Follow-ups (out of scope here)

- Field measurement, then possible commit-axis restart integration + UI thresholds (v2).
- Linux system commit via `/proc/meminfo` (`Committed_AS`/`CommitLimit`, no spawn).
- docs-site ja/zh-cn translations of the memoryWatchdog reference section.
- Separate issue: `windows-secret-acl` hardening is non-atomic under icacls timeouts
  (inheritance stripped before grant), which is the root cause of the environmental `EACCES`
  test failures on slow-ACL machines.
