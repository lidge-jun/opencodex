# 040 — wp1 implementation plan and file map

Implements 020 as finalized after four audit rounds. Diff-level map:

| File | Change |
|---|---|
| `src/service/health-sentinel-policy.ts` | New. Pure policy: cadence (30 s / 1 s while failing), deadline, grace, arming, threshold + span, backoff, cap, pause, clock-step and sentinel-lag guards |
| `src/service/health-sentinel-probe.ts` | New. `/healthz` over `directLocalHttpFetch`; answered / timeout / refused / error |
| `src/service/health-sentinel-main.ts` | New. Runner (`runHealthSentinel`, injected deps), history (two-phase entries, fsync + rename + dir fsync, fail closed), lag monitor, process entry with ownership lease and platform kill binding |
| `src/service/health-sentinel-windows.ts` | New. kernel32 handle via `bun:ffi` (u64 HANDLEs), creation-time check, TerminateProcess |
| `src/service/health-sentinel-launch.ts` | New. Gate, allowlisted env, spawn with stdin lifeline, drain-start and shutdown hooks, recent-recovery notice |
| `src/lib/optional-shutdown-hooks.ts` | Drain-start registry (`registerDrainStartHook`, `runDrainStartHooks`, `didRunDrainStartHooks`) |
| `src/server/lifecycle.ts` | One call: `runDrainStartHooks()` after `beginShutdownDrain()` |
| `src/cli/index.ts` | Import, private `__health-sentinel` argv, `let healthSentinel`, start after reconciliation when not shutting down, stop in `syncCleanup` (1983 → 1988 lines, threshold 2000) |
| `src/types/config.ts`, `src/config/schema/config-schema.ts`, `src/config/diagnostics.ts`, `src/config/feature-flags.ts` | `serviceHealthRecovery: { enabled?: boolean }`, metricsExport contract |
| `tests/service/service-health-sentinel-{policy,runner,launch,process}.test.ts`, `tests/helpers/health-sentinel-hung-proxy.ts` | Coverage; registered in `tests/fixtures/test-layout-expected.json` and on one existing `scripts/test-layout/layout.json` line (that file sits at 1999 of the 2000-line threshold) |
| `docs-site/.../reference/configuration/server.md` (8 locales), `structure/ops/service-health-recovery.md`, `structure/manifest.json`, `structure/INDEX.md` | Docs |

Verifiers: `bun run typecheck`; the four new test files; `tests/lib/optional-shutdown-hooks.test.ts`,
`tests/lab/core-lab-boundary.test.ts`, `tests/server/server-background-lifecycle.test.ts`, config
suites, `tests/server/management-metrics-export.test.ts`, test-layout and file-size ratchet tests;
`bun run structure:check`; `bun run privacy:scan`; `bun run test:changed` (queued behind other
worktrees' runs on this machine); hosted CI on Linux, macOS and Windows for the process test.

## Code review round 1 (GPT-6.1-Sol, FAIL) dispositions

| # | Finding | Disposition |
|---|---|---|
| 1 | Major: `raceGone` attached a handler per probe to one never-settling exit promise (reviewer measured 100,000 subscriptions and +15 MB after 50,000 probes) | Folded: the exit is one `AbortSignal` subscribed once per run; each race removes its listener in `finally`. Test: 5,000 healthy probes, exactly one subscription |
| 2 | Minor: the fixture answered once, so a slow runner missing that deadline never armed the sentinel | Folded: the fixture answers three probes before hanging; the process test uses a 2 s probe deadline, 10 s lag tolerance and 40 s outer bound |

## Code review round 2 (GPT-6.1-Sol, NEAR-PASS)

Round-1 major confirmed resolved (reviewer instrumentation: 50,000 healthy probes, one exit
subscription, no listeners left). The remaining minor — the fixture could start hanging before the
sentinel had armed — is folded: the sentinel logs `watching pid <pid> on port <port>` once when it
arms, and the fixture keeps answering until that line appears.

## Merge sign-off conditions (GPT-6.1-Sol high, SIGN-OFF-WITH-CONDITIONS on abd179ba5e)

| # | Condition | Change |
|---|---|---|
| A | Lease/history/log work between the last failing probe and `terminateTarget` had no freshness check (reproduced: a ten-minute injected history delay still killed) | `maxEvidenceAgeMs` (5 s). Right before the kill the runner re-checks the wall-clock age of the last failing observation; stale or future-dated evidence settles the `intent` entry as `skipped` and requires a fresh failing streak. Regression: injected +10 min delay and −2 h clock step both lead to a discard and a kill only after three new timeouts |
| B | Future-dated history entries were dropped, so a two-hour clock rollback lifted the hourly cap (reproduced) | `recentRecoveryCount` counts future entries as recent until the clock passes them by a full window. Regression: rollback with three entries stands down, also for a restarted sentinel; one future entry doubles the required span |

Accepted by the merge thread: POSIX PID-reuse residual for this default-off feature; Linux `pidfd_open` + `pidfd_send_signal` is a follow-up issue.
