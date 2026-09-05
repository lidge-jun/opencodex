# 000 — Windows suite failure inventory, FIRST ATTEMPT (VOID)

> **This document is superseded and its numbers must not be used.** It was
> measured with `bun 1.3.14` while the repository pins `1.4.0`
> (`package.json:68`). A controlled A/B on the same box showed the headline
> defect exists only on 1.3.14: the same two files give 44 fail on 1.3.14 and
> 50 pass on 1.4.0. See `001_runtime_fault.md`. The corrected baseline is `002`.
>
> It is kept, not deleted: the shard timings, the log layout, the serial-lock
> protocol and the reasoning that the audit overturned are all real, and a
> deleted mistake is one the next person repeats.

Unit: stabilize the Windows test suite until four shards run clean, twice.
Base: `dev` at `00834d710`. Runner: **not** GitHub Actions — the user's own
Windows box `desktop-c795oh4` (Windows 10.0.26200.9168, 16 cores, Git-bash,
`bun 1.3.14`, checkout at `C:\ocxwin\repo`), reached over SSH.

## Why a self-hosted baseline instead of a CI dispatch

The Windows leg is `workflow_dispatch`-only (`.github/workflows/ci.yml:565`) and
each shard carries a 25-minute ceiling. A CI round therefore costs ~25 minutes and
returns a log that is already truncated when a shard is slow. The self-hosted box
has no ceiling, so a shard runs to completion and every failure is readable. The
box is a single machine: **suite runs are strictly serial**, tracked by
`/c/ocxwin/.suite.lock`, and never overlapped.

## Baseline, all four shards

| shard | pass | skip | fail | wall | verdict |
|---|---|---|---|---|---|
| 1/4 | 4385 | 39 | **52** | 1083s | complete |
| 2/4 | 4507 | 15 | **122** | 1125s | complete |
| 3/4 | — | — | — | — | **WEDGED** — no verdict (see `030`) |
| 4/4 | 4405 | 12 | **5** | 922s | complete |

179 failures across the three shards that finished, plus one shard that never
reported. Shard 3 stopped producing output after `client-hub-relay` and stayed
byte-stable for 14 minutes with a live process; it was killed after a bounded
wait so shard 4 could run. Its ~215 remaining files are UNMEASURED, so this
inventory is a floor, not a total.

## Shard 1/4 detail

`bun test --isolate --timeout 60000 tests --shard=1/4`, 265 files, 1083.33s.

    4385 pass · 39 skip · 52 fail · 4 errors · 191329 expect() calls

Every failure below passes on macOS at the same SHA (verified per file, not
assumed): the ledger file is 44/44 green locally, and so are the six singles.

| # | Signature | Count | Owner | Class |
|---|---|---|---|---|
| L | `reset-credit operation migration faults require the repository test preload` | 44 | `src/codex/reset-credit-operation-ledger.ts:488` guard; raised from the `afterEach` at `tests/codex-reset-credit-operation-ledger.test.ts:296` | preload/env — one root, 44 cascaded cases |
| S1 | `adapter-event OAuth failover > Codex and Anthropic remain excluded` — expects 401, gets 400 | 1 | `tests/adapter-event-oauth-failover.test.ts:190` | TBD |
| S2 | `CL-03 pinned live transport … output_byte_limit` — gets `pinned provider first byte timed out` | 1 | `tests/lab-live-pinned-timeouts.test.ts:112` | timing race, slower Windows I/O |
| S3 | `ocx v2 keep-native-v1 > enabling the native-v1 pin disables the global V2 override before catalog sync` | 1 | `tests/multi-agent-keep-native-v1.test.ts` | TBD |
| S4 | `ocx v2 keep-native-v1 > mode v2 honors a pre-existing native-v1 pin …` | 1 | `tests/multi-agent-keep-native-v1.test.ts` | TBD |
| S5 | `OpenAI provider-option integration spine > keeps Pool, Direct, and API ownership stable …` | 1 | TBD | TBD |
| S6 | `routing profiles (RI-04) > API dry-run mirrors live codex cooldown for openai candidates` | 1 | `tests/routing-profile.test.ts:479` | ambient `CODEX_HOME` |

## Shard 2/4 detail — the same root, three more files

| Signature | Count | Guarded seam | src |
|---|---|---|---|
| `resetProcessStateForTests is available only under the repository test preload` | 68 | `resetCodexResetCreditRecoveryProcessStateForTests` | `src/codex/reset-credit-recovery.ts:638` |
| `fabric isolation limits can only be overridden by the test harness` | 49 | `setFabricProducerIsolationLimitsForTests` | `src/lab/fabric/producer-isolate.ts:287` |
| `real-home write guard > the preload sandboxes this very process` | 1 | — | `tests/test-home-guard.test.ts:274` |
| `runWindowsElevated spawn contract > an armed test cannot launch the live Windows elevation boundary` | 1 | armed-process refusal | — |
| `multi-account auth store > OAuth 30 second wait timeout …` | 1 | — | — |
| `Grok orphan adoption (#511)`, `020 coverage completions` | 2 | — | — |

The third row is the one that names the defect: the test whose whole job is to
assert `isTestHomeGuardArmed()` receives `false`. The guard is genuinely not
armed — this is not 161 separate assertions disagreeing, it is one process-level
fault observed 161 times.

## Shard 4/4 detail

| Signature | Count | Class |
|---|---|---|
| `service lifecycle cleanup ordering > an armed test cannot fall through to a live Task Scheduler mutation` | 1 | same guard root |
| `service lifecycle cleanup ordering > an armed partial install cannot fall through to live native-service removal` | 1 | same guard root |
| `Windows tray packaging and command safety > launches the detached tray host without retaining the proxy listen socket` | 1 | Windows-specific, own investigation |
| `health-aware scoring (RI-06) > execution path applies live codex account cooldown to openai candidates` | 1 | sibling of S6 — ambient `CODEX_HOME` |
| (1 more) | 1 | — |

The two service failures are the guard defect wearing a different coat, and they
are the dangerous shape of it: `tests/service.test.ts:1283` expects the armed
process to REFUSE a machine-global Task Scheduler mutation and instead gets
*"Task Scheduler reported success, but the new registration is absent"*. The
refusal did not fire, so an unarmed test process reached a live scheduler call on
the user's machine. That elevates the preload defect from "many red tests" to a
containment failure, and it is why wp2 leads the queue.

## Roll-up by root cause

| root | failures | phase |
|---|---|---|
| preload run-id provenance (guard never arms) | **163** | wp2 (`010`) |
| six shard-1 singles | 6 | wp3 (`020`) |
| shard-3 wedge | (blocks ~215 files) | wp4 (`030`) |
| shard-2/4 stragglers not yet classified | ~10 | wp5, after the above clears |

Fixing one defect is expected to clear roughly 90% of the red. The remainder is
small enough to work case by case — but the count only becomes trustworthy after
shard 3 reports, which is why the wedge is a first-class phase and not a footnote.

## Shard 1/4 signature table

44 of 52 failures are one defect. The headline number is six independent defects
plus one env fault, not fifty-two.

## L — the preload guard

```
488 |   if (process.env.OCX_TEST_HOME_GUARD !== "1") {
489 |     throw new Error("reset-credit operation migration faults require the repository test preload");
```

`tests/preload.ts:64` is the only writer of that variable, and `bunfig.toml`
preloads it for every invocation. The first occurrence in the Windows log is
**before any test body**, at the file's `afterEach`, and the run also prints
`[opencodex] Reset-credit operation ledger is unavailable.` So either the preload
never reached line 64 on this file's worker, or its effect was not visible there.
That distinction is what the wp2 experiment has to settle; it is not yet settled
and nothing below assumes an answer.

## Shards 2-4

Running serially after shard 1. Recorded in `001` when complete.

## Evidence

Shard logs live on the Windows box at `/c/ocxwin/logs/base-<n>.log` and are
copied into `.tmp/win/` (gitignored) for reading. They are not committed: a
single shard log is 650KB of pass lines.
