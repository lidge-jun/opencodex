# 004 — VOID: the six 1.3.14 "singles"

> **This phase does not ship.** Four of the six do not fail on `bun 1.4.0`
> (`002`). The two that survive are defect 1, replanned in `020` — and NOT with
> the `V2CliDeps.featureAction` seam sketched below, which the audit rejected
> for removing the `cmdV2 → codexFeaturesInvocation → commandInvocation`
> integration from exactly the tests that should keep it.
>
> Kept as a record of what the wrong runtime made look like six defects.

> **Status: HELD, pending the `002` baseline** (`bun 1.4.0`). Every failure
> below was observed on `bun 1.3.14`; see `001_runtime_fault.md`.
>
> The audit landed two corrections that apply regardless of runtime:
>
> - **S1 and S6 are probably not independent.** They were argued as ambient
>   `CODEX_HOME` defects, but a preload that COMPLETES already assigns a
>   per-file `CODEX_HOME` (`scripts/test.ts:22-26,62` → `tests/preload.ts:57-64`).
>   On 1.3.14 the preload did not complete, so "ambient" was a symptom of the
>   guard fault, not a cause. Re-measure both after `002`; if they vanish, they
>   leave this phase.
> - **S6's proposed assertion is ordered wrong.** Checking
>   `getEffectiveActiveCodexAccountId(config) === "pool-a"` before
>   `recordCodexUpstreamOutcome` (`tests/routing-profile.test.ts:494`) cannot
>   observe the cursor movement at `src/codex/routing.ts:2422-2438`. It has to
>   run after.
> - **S3/S4's semantic seam must not silently drop launcher coverage.** The
>   Windows `.cmd` path is covered by `tests/codex-v2-gate.test.ts:1692-1726`
>   and `tests/win-exec.test.ts:92-125`; both stay unchanged, and one
>   `cmdV2 → feature action` integration assertion must survive the refactor.
> - **S2's budget cannot come from `isolationBudgetMs()` alone.** That helper
>   only scales under `CI=true` or `OCX_TEST_FULL_SUITE=1`
>   (`tests/helpers/ci-watchdog.ts:49-51`), and the self-hosted run sets
>   neither. Use explicit case-local budgets and scale `totalTimeoutMs` with
>   them. The production default is 30s (`src/lab/live/executor.ts:110`); the
>   30ms in this test is a fixture artifact, and the dedicated first-byte and
>   inactivity cases at `:76-103` keep that behaviour covered.
>
> **S5 moves out of this phase.** It is an investigation with no known failing
> line, and mixing it here breaks the research/implementation split. It returns
> as its own phase once `002` says whether it still fails.

Six failures that are not the preload defect. Each passes on macOS at the same
SHA (verified per file). Grouped by mechanism, because the fixes pair up.


## The six, and where they went

Four do not fail on bun 1.4.0 and have no successor phase. The two that survive
are the launcher-argv defect, replanned from scratch in 020_defect_launcher_argv.md.

The per-defect fix sketches that used to live here are removed rather than kept:
they were written against a fictional failure list, and two of them (the
V2CliDeps.featureAction seam, the CODEX_HOME isolation for S1/S6) were
subsequently rejected on audit. Reading them as guidance would be worse than
having nothing.
