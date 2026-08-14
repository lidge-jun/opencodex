# 100 — Verification evidence (WP1: phases 1-2)

Unit: `260814_lab_core_decoupling`. Records the C-phase evidence for phases 1 and 2.

## Local (macOS, Bun 1.3.14)

`bun x tsc --noEmit` — **exit 0**.

Focused suites, all green:

| Suite | Result |
|---|---|
| `tests/optional-shutdown-hooks.test.ts` | 14 pass |
| `tests/passive-route-linker.test.ts` | 8 pass |
| `tests/lab-passive-production-evidence.test.ts` | 16 pass |
| 7 `lab-automation-*` files | 52 pass |
| `tests/repo-hygiene.test.ts` | 11 pass |

## The property under test, proven directly

Module-graph walk over runtime imports (type-only excluded):

```
src/server/lifecycle.ts      69 -> 0   reachable src/lab modules
src/router.ts                24 -> 24  (phase 3 scope)
src/server/responses/core.ts 24 -> 24  (phase 3 scope, via router.ts)
```

The remaining edge is a single chain, confirmed by tracing rather than assumed:

```
server/responses/core.ts -> router.ts -> routing/compatibility/assemble.ts
  -> routing/compatibility/catalog.ts -> lab/query/catalog.ts
```

That is exactly what phase 3 removes.

### Guards driven red

Per the repository's own precedent for structural invariants, the boundary assertions were
proven non-vacuous rather than merely observed passing:

1. Re-added `import { resolveProductionRouteSubject } from "../../routing/compatibility/subject"`
   to `responses/core.ts`. Both `core request path boundary > responses/core.ts does not
   import lab or routing/compatibility` and the inverted CL-09 guard **failed**. Reverted;
   24 tests green again with no diff.
2. The scheduler-leak regression (phase 1) was likewise driven red before its fix:
   `runningAfter=true` before, `false` after.

## Remote Linux runner (`lidge`, Ubuntu, 16 cores, Bun 1.3.14)

Clone of `codex/lab-core-decoupling` at `db315a9`.

`bun x tsc --noEmit` — **exit 0**.

Full `bun test` reported 127 failures. **These are a pre-existing full-suite condition, not
a regression from this work.** Three independent lines of evidence:

1. **Zero Lab/boundary failures.** Filtering the failure list for `lab|shutdown|passive|
   linker|boundary|compat` returns three entries, and all three are unrelated tests whose
   names merely contain a matching substring (`doctor-gui-if-changed`, a vision sidecar
   test, a `cli surface` status test). No test from this unit failed.
2. **The failures do not reproduce in isolation.** Every sampled failing file passes when
   run standalone on the same machine, same commit:
   - `tests/server-rate-limit-retry-e2e.test.ts` — 6 pass, 0 fail
   - `tests/issue-702-expired-replay-state.test.ts` — 5 pass, 0 fail
   - `tests/autostart-health.test.ts` + the three boundary suites — all pass
3. **A `dev` baseline reproduces it.** A clean clone of `dev` at `c6688c7` on the same
   runner accumulated failures on the same trajectory (19 → 55 → 67 → 75 → 112) while its
   suite ran. The branch and the baseline converge rather than diverge.

The mechanism is cross-file interference in a shared-state full-suite run, which is why
`.github/workflows` shards the suite (`test 1/4` … `test 4/4`) and why
`ci: isolate Bun test shards into fresh-process batches (#1469)` exists. A single
unsharded `bun test` on one host is not the CI configuration and is not a valid baseline.

**Reported honestly rather than absorbed:** the authoritative full-suite signal for this
branch is CI's sharded run on the PR, not this unsharded local run. The focused evidence
above is what this cycle stands on.

## Commits

| SHA | Phase |
|---|---|
| `37084c24a` | roadmap + CODEOWNERS |
| `9d979f6e4` | audit rounds 2-3 |
| `199c19f8b` | audit round 3 close-out |
| `8f6908bb1` | phase 1 — cycle cut |
| `00a345b36` | phase 1 — scheduler teardown fix |
| `72aa7fbf4` | phase 1 — reviewer-case tests |
| `db315a9b6` | phase 1 — keying tests |
| `8babf7d5c` | phase 2 — request-path slot |
