# WP3 — #1876 Windows discovery -> #1852 (Wave 5A-3) — rev 2 after audit

> Rev 2 folds blocker 6. Most of what rev 1 proposed is already on `dev`.

## What already exists (do not re-implement)

- `__OCX_ENUM_INCOMPLETE__` is already emitted at `src/codex/app-server-processes.ts:372`
  and `:377`.
- The parser already consumes it at `:392` — by **throwing** `windows_enum_incomplete`,
  not by mapping to a state.
- The `unknown` state already exists in the type at `:574`.
- `collectCodexAppServerCatalogState` already converts an enumeration throw into
  `{state:"unknown"}` via `enumerationFailed`, so guidance already fails closed.

Rev 1's "parse the sentinel to unknown" and the `collaboration.ts` change described
shipped work. Both are dropped.

## The one real gap

`$ErrorActionPreference='SilentlyContinue'` (`:362`) plus a top-level
`Get-CimInstance Win32_Process` (`:364`) that sits **outside** the per-process
`try/catch`. A non-terminating top-level CIM failure emits nothing, no sentinel is
produced, the parser sees clean empty output, and the collector reports
`not_running` — an unknown state laundered into a positive claim. Confirmed present
on `dev` and on #1876's head `d5acd7414` (which only refactored the string into
`windowsSnapshotPowerShellCommand()`).

## The two-consumer subtlety rev 1 missed

One sentinel feeds two consumers with opposite contracts:

- `collectCodexAppServerCatalogState` — must treat the throw as `unknown` (fail closed).
- `listCodexAppServerProcesses` — deliberately swallows the same throw into
  `snapshots = []` at `:427-431` for the kill/restart contract (#476).

So emitting the sentinel on top-level failure fixes guidance and simultaneously
means "no restart targets" on the restart path. That is acceptable (restarting
nothing is safe; claiming nothing runs is not), but it must be stated, not discovered.

## File change map

| File | Change |
|------|--------|
| `src/codex/app-server-processes.ts` | `-ErrorAction Stop` on the top-level query at `:364`, wrapped so a failure emits `__OCX_ENUM_INCOMPLETE__`; comment the restart-path consequence at `:427` |
| `src/codex/app-server-processes.ts` | `CATALOG_STATE_TTL_MS` (5_000, uniform today) must not cache `unknown`/`not_running` for the full TTL |
| `tests/codex-app-server-processes.test.ts` | regression for a top-level CIM query that returns **cleanly empty** (see the wording note below for what existing coverage does and does not reach); TTL behavior per state |

## Accept criteria (with activation)

1. A failing top-level CIM query yields `unknown`, not `not_running`.
   *Activation:* fixture whose PowerShell output is empty due to a top-level error;
   assert `state === "unknown"` and that the sentinel path ran.
2. `unknown` never produces positive disk-derived v2 guidance.
3. An `unknown` result is not served from cache for the full 5s TTL.

Verifier: `bun test tests/codex-app-server-processes.test.ts` — the change target.
`tests/multi-agent-compat.test.ts` is run as a **no-change regression guard** for
criterion 2 only; rev 2 dropped the `collaboration.ts` edit as already-shipped, so
that suite must stay green without being modified (round-2 audit blocker B).

Wording precision (round-2 audit): the existing test at
`tests/codex-app-server-processes.test.ts:86` does exercise a *throwing* enumerator
(by swapping `platform` so the real enumerator fails on a missing binary) rather than
only rejecting an injected callback. The untested path is narrower and is exactly the
one this work-phase adds: a top-level CIM query that returns **cleanly empty**.

## Windows proof (honest limitation)

`platform-windows` is `workflow_dispatch`-only and the aggregate accepts it as
skipped, so normal PR CI proves nothing about a PowerShell/CIM change. Request the
dispatch on the exact merged head; if it cannot be obtained, record that gap rather
than implying platform coverage.

## Closure

#1876 merges after the top-level fix; #1852 closes citing the merge SHA plus the
top-level-failure regression test.
## Outcome (executed)

DONE with one open evidence gap. Three commits:

| Commit | Change |
|--------|--------|
| `dc1df7d44` | `-ErrorAction Stop` + outer catch on the top-level query; parse loop extracted to `parseWindowsSnapshotOutput`; `listWindowsSnapshots` takes an optional runner; the collector's fail-closed catch now covers the injected seam too |
| `497b64338` | full-row fixture pinning every parsed field |
| `535e3c256` | `unknown` cached for 250ms instead of the uniform 5s (accept criterion 3) |

**Two defects found in my own work, both by auditing rather than by tests.**

The extraction silently dropped `ProcessSnapshot.owner` and every test still
passed — the two states these tests assert never read it, and the ownership
decisions that do live in other modules with their own doubles. It was caught by
diffing against `4d9738f43`, and the full-row fixture exists so the next refactor
cannot repeat it.

`collectCodexAppServerCatalogState` wrapped only the *default* enumerator in its
try, so an injected `listSnapshots` that threw would propagate instead of
degrading to `unknown`. No caller was broken in practice, but the regression test
for this work-phase would have been asserting the safety of a path the seam does
not share. Both paths now go through one catch — the shape
`src/codex/log-guard/processes.ts` already had.

**Open gap, recorded rather than implied.** There is no real-Windows evidence.
`platform-windows` is `workflow_dispatch`-only and the aggregate accepts it as
skipped. The reviewer's sharpest point stands: the tests drive an injected
`runPowerShell`, so no PowerShell ever parses the emitted script, and a *syntax*
error is not catchable by `try/catch` in the same scriptblock — it fails at parse
time, writes to stderr (which is `stdio: "ignore"`), and leaves stdout empty,
reintroducing precisely the fail-open this fixes. A second, milder risk: 
`-ErrorAction Stop` promotes non-terminating CIM errors to terminating, so a benign
per-instance error could turn a mostly-complete read into a persistent `unknown`.
Both need a maintainer-triggered dispatch on the merged head.
