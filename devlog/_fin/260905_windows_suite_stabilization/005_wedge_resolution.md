# 005 — RESOLVED: the shard-3 wedge was the runtime, not a test

> **Outcome: this phase ships nothing, and that is the correct result.**
>
> The audit was right that adjacency is not attribution, and demanded an
> alone/alone/ordered-pair matrix before naming a culprit. That matrix was run
> on the box and it exonerates both files:
>
> | run | `bun 1.3.14` | `bun 1.4.0` |
> |---|---|---|
> | `cline-pass` alone | 6 pass, 0.95s | — |
> | `client-hub-relay` → `cline-pass`, `--isolate` | **wedged, exit 124** | 12 pass, 1.6s |
> | `cline-pass` → `client-hub-relay`, `--isolate` | 12 pass | — |
> | same pair WITHOUT `--isolate` | 12 pass | — |
>
> Order-dependent, `--isolate`-dependent, runtime-dependent, and absent on the
> version the repository pins. That is an isolate realm-transition fault in Bun
> 1.3.14, not a defect in either test. `client-hub-relay.test.ts` opens no
> socket and no process — it calls pure functions — so there is nothing in it to
> fix.
>
> The section below is the original reasoning, kept because its CI observation
> still stands on its own: a 25-minute shard ceiling reports a wedge as a
> timeout, so this class of fault has never been nameable from CI logs alone.

Not a failing test. A **stopped shard** — which is worse, because it produces no
verdict at all for the ~215 files behind it.

## Observation

Shard 3/4 printed its last line at 00:53 and produced nothing for the next 14
minutes: `base-3.log` stayed at exactly 96929 bytes while the Bun process
(PID 1382, started 00:50:43) remained alive under the run's shell.

Last file to report:

```
1228:tests\client-hub-relay.test.ts:
…
(pass) fixed-target hub management relay > rejects traversal, authority, encoded
       separator, and caller-host variants before outbound I/O [0.40ms]
```

The shard's file list is Bun's sorted round-robin (`NR%4==3` over
`ls tests/*.test.ts | sort`), which puts **`tests/cline-pass-reasoning-efforts.test.ts`**
immediately after `client-hub-relay`. Nothing from it ever printed, so the wedge
is at that file's load or first test.

## Why `--timeout 60000` did not save it

Bun's per-test timeout bounds a test body. It does not bound module evaluation,
and it does not bound a worker that never reports. Fourteen minutes with a live
process and a byte-stable log is neither a slow test nor a crash: the runner is
not making progress and nothing in the harness notices.

## Why CI never showed this

`.github/workflows/ci.yml:653` caps each Windows shard at 25 minutes. A shard
that wedges here is CANCELLED at the ceiling, which is recorded as a timeout, not
as a wedge on a named file — the same truncation `260902_windows_ci_release/070`
hit repeatedly and attributed to a "native-main-refresh microtask spin". The
self-hosted box has no ceiling, which is exactly why the file is nameable now.

## What is not yet known

The file itself is 152 lines and looks inert: it imports the registry, the
adapter and `routeModel`, builds a static config, and asserts on
`PROVIDER_REGISTRY`. Nothing in it opens a socket. So the suspicion falls on
module-graph evaluation under Bun 1.3.14 on Windows — `../src/router` and
`../src/providers/registry` pull in a large graph — rather than on the test
bodies. **That is a hypothesis, not a finding.** The next step is to run this one
file alone on the Windows box, with the suite lock held, and watch whether it
completes, wedges, or wedges only after a preceding file.

## Sequencing note

Because the box is single-tenant and runs are serial, a wedged shard blocks the
whole inventory. The baseline therefore stops shard 3 after a bounded wait and
records the wedge rather than waiting it out; shard 4 runs next so the inventory
is complete, and this file gets a dedicated isolated run afterwards.
