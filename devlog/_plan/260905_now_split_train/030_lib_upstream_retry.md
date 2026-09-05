# S01 L3/3 — Abort-aware retry waits

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Class: C3 boundary planning, docs-only here.
- Goal: move abort-aware waiting and bounded pre-wait body release into src/lib/upstream-retry-wait.ts (125 lines), leaving src/lib/upstream-retry.ts at 309 lines with its send-budget owner/oracle intact.
- Non-goals: no retry policy, delay, cancellation ordering, error attribution, heartbeat, deadline, status or signature changes. No new dependencies or caller migration. No resetting/multiplying budgets, and no cleanup of existing long functions.
- Verifier: 002_layer_map.md "Per-layer gate", instantiated below; this author runs no tests.
- Stop: independent layer verified at its own tip, open PR and exact-head green CI recorded by the parent; no merge.
- Escalation: source drift, an unlisted oracle/mock dependency, required budget move, altered timer/abort behavior, cycle, >500 source churn or write-scope expansion. Record unreleased security findings only in ignored scratch.

Basis: docs HEAD 4cc219549 and source origin/dev 1362b1a38, working-tree source identical for this file. Lane evidence: 016_lane_cli_storage_usage_update_lab_scripts.md:768–781 in the modular-debt-ledger unit. 000/001's older tip annotations do not override this refreshed source basis.

Structural map: 25 direct importing files. Examples src/lib/upstream-reachability.ts:27 and src/web-search/anthropic-executor.ts:7. Current dependency is clearableDeadline from ./abort (src/lib/upstream-retry.ts:17). The wait group (:49–173) is self-contained. Intended direction: preserved callers → upstream-retry.ts → upstream-retry-wait.ts; upstream-retry.ts → abort.ts remains. The new leaf imports nothing. Public boundary is the existing retry path; blast radius is lib with preserved adapter/server/web-search consumers.

Decision: move the cohesive body-release/sleep/heartbeat group, retaining all retry orchestration and evidence types/classes. Doing nothing leaves 429 lines; deleting/configuring changes behavior. Existing src/lib/bounded-body.ts reads bounded data rather than performing pre-replay cancellation, and src/lib/abort.ts owns deadline/signal composition rather than heartbeat generators; reuse would conflate contracts. rg for releaseResponseBodyBestEffort and sleepWithHeartbeats in src/lib confirms this owner. Sibling names match src/lib/upstream-reachability.ts, src/lib/upstream-http-version.ts and src/lib/bounded-body.ts. No new index barrel. This minimal move avoids retargeting the source-checked retry budget.

## Symbol inventory

Inclusive origin/dev:src/lib/upstream-retry.ts ranges from rg declaration/closing-line inspection. Consumer counts: distinct importing files found by resolving relative static/dynamic/mock specifiers from rg -l upstream-retry src gui/src scripts tests, then rg -l -w per symbol; lexical file references, not call counts. Private names have zero external consumers. R = original src/lib/upstream-retry.ts; W = src/lib/upstream-retry-wait.ts. The import binding is included separately from the 28 top-level declarations.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| clearableDeadline | import binding from ./abort | 17–17 | no | 0 | R (existing dependency) |
| RESET_RETRY_MAX_ATTEMPTS | const number | 20–20 | no | 0 | R |
| RESET_RETRY_BASE_DELAY_MS | const number | 21–21 | no | 0 | R |
| RESET_RETRY_MAX_DELAY_MS | const number | 22–22 | no | 0 | R |
| TRANSIENT_RETRY_MAX_ATTEMPTS | const number | 25–25 | no | 0 | R |
| TRANSIENT_RETRY_BASE_DELAY_MS | const number | 26–26 | no | 0 | R |
| TRANSIENT_RETRY_MAX_DELAY_MS | const number | 27–27 | no | 0 | R |
| TRANSIENT_RETRY_SLOW_ATTEMPT_MS | const number | 30–30 | no | 0 | R |
| isTransientUpstreamStatus | function | 38–41 | yes | 3 | R |
| RetryBackoffOptions | interface | 43–47 | yes | 0 | R |
| abortError | function | 49–51 | yes | 3 | W |
| sleepWithAbort | async function | 53–72 | yes | 3 | W |
| releaseResponseBodyBestEffort | async function | 84–120 | yes | 1 | W |
| sleepWithHeartbeats | async generator | 129–146 | yes | 1 | W |
| SameTarget429WaitOptions | interface | 148–157 | yes | 0 | W |
| prepareSameTarget429Wait | async generator | 164–173 | yes | 5 | W |
| isConnectionResetError | function | 175–184 | yes | 2 | R |
| retryAfterDelayMs | function | 186–194 | no | 0 | R |
| retryBackoffDelayMs | function | 196–201 | yes | 4 | R |
| cancelResponseBodyBestEffort | function | 203–210 | yes | 2 | R |
| fetchWithAttemptDeadline | async function | 212–236 | yes | 2 | R |
| ResetRetryOptions | interface | 238–244 | yes | 0 | R |
| TransientRetryOptions | interface | 246–255 | yes | 0 | R |
| UpstreamSendRecovery | type | 257–257 | yes | 2 | R |
| ReplayableFetch | type | 258–258 | no | 0 | R |
| UpstreamRetryEvidenceError | class | 272–291 | yes | 2 | R |
| applyUpstreamRecoveryInit | function | 302–312 | yes | 14 | R |
| fetchWithResetRetry | async function | 319–353 | yes | 16 | R |
| fetchWithTransientRetry | async function | 366–429 | yes | 8 | R |

## Leaf partition

One new sibling: src/lib/upstream-retry-wait.ts.

- Symbols: abortError, sleepWithAbort, releaseResponseBodyBestEffort, sleepWithHeartbeats, SameTarget429WaitOptions, prepareSameTarget429Wait; retain their existing export modifiers.
- Own imports: none. DOMException, timers, AbortSignal, ReadableStream and AsyncGenerator remain standard globals/types. The options interface moves beside its only declaring function; no return type edge to the facade.
- Move exact source chunk src/lib/upstream-retry.ts:49–173 (125 lines), with all internal comments/spacing unchanged. Expected leaf 125 lines.
- Residual retains all other source and the existing clearableDeadline import. Add the three one-line import/re-export statements plus two blank lines below: 429 − 125 + 5 = 309 lines. Total layout 125 + 309 = 434 (five added plumbing/layout lines).
- Expected source churn: 130 additions + 125 deletions = 255; no #b required. Highest-consumer fetch/recovery symbols remain untouched. cancelResponseBodyBestEffort (:203) intentionally stays with retry orchestration; it is the non-waiting cancellation variant, not the bounded pre-429 release helper.

## Re-export block

Exact named value and type exports:

    export { abortError, sleepWithAbort, releaseResponseBodyBestEffort, sleepWithHeartbeats, prepareSameTarget429Wait } from "./upstream-retry-wait";
    export type { SameTarget429WaitOptions } from "./upstream-retry-wait";

Exact explicit local import:

    import { abortError, sleepWithAbort } from "./upstream-retry-wait";

Insert the local import after the existing clearableDeadline import, then a blank line, the two export lines, then a blank line; retain original spacing otherwise. Re-export statements bind nothing: fetchWithResetRetry still calls abortError (:328) and sleepWithAbort (:346), and fetchWithTransientRetry calls sleepWithAbort (:413).

All other original exports remain declarations in R: isTransientUpstreamStatus, RetryBackoffOptions, isConnectionResetError, retryBackoffDelayMs, cancelResponseBodyBestEffort, fetchWithAttemptDeadline, ResetRetryOptions, TransientRetryOptions, UpstreamSendRecovery, UpstreamRetryEvidenceError, applyUpstreamRecoveryInit, fetchWithResetRetry, fetchWithTransientRetry. ReplayableFetch remains private.

## Module-level state and cycles

- No top-level let, Map, Set, WeakMap, lock or timer exists. Seven numeric policy constants remain owned by R: RESET_RETRY_MAX_ATTEMPTS (:20), RESET_RETRY_BASE_DELAY_MS (:21), RESET_RETRY_MAX_DELAY_MS (:22), TRANSIENT_RETRY_MAX_ATTEMPTS (:25), TRANSIENT_RETRY_BASE_DELAY_MS (:26), TRANSIENT_RETRY_MAX_DELAY_MS (:27), TRANSIENT_RETRY_SLOW_ATTEMPT_MS (:30).
- Timers in sleepWithAbort (:57) and releaseResponseBodyBestEffort (:100), listeners and heartbeat remaining count (:139) are invocation-local; move with W without hoisting, duplicating or changing cleanup. The un-signalled release branch (:96) retains its exact existing timer behavior; this is not a cleanup patch.
- fetchWithTransientRetry's transientStatuses (:372), sent (:380), countedFetch (:381), remaining (:389), attemptStart (:394) and final onSendsConsumed (:427) stay call-local in R. UpstreamRetryEvidenceError stays one class constructor in R, preserving instanceof identity and mock behavior.
- W must not import R, abort.ts, adapters or server modules. R → W is functional; prepareSameTarget429Wait's body release → sleep/heartbeat sequence stays wholly inside W. No new shared mutable state or cycle; the only new target has no outgoing imports. The existing R → abort.ts edge is unchanged.

## Tests

Complete direct importing-test list from rg -l 'src/lib/upstream-retry|lib/upstream-retry\.ts' tests, separated from the one source-only result:

| test file | import/pin line | disposition |
|---|---:|---|
| tests/lib/upstream-retry.test.ts | 9 | unchanged, original public path |
| tests/providers/upstream-transient-retry.test.ts | 2 | unchanged, original public path |
| tests/codex-integration/issue-914-transport-attribution.test.ts | 18 | unchanged, original public path |
| tests/codex-integration/upstream-reachability.test.ts | 8 | unchanged, original public path/class identity |
| tests/server/server-combo-failover-e2e.test.ts | 47 and 105 | unchanged dynamic import and mock.module path |

Source oracles and disposition:

| test file | exact read site | disposition |
|---|---|---|
| tests/lib/transient-budget-scope-source.test.ts | source("lib/upstream-retry.ts") at :48, readFileSync implementation at :7 | unchanged; TransientRetryOptions and fetchWithTransientRetry remain in R; assertions :49 and :51 retain full strength |
| tests/lab/core-lab-boundary.test.ts | readFileSync(current, "utf8") at :69 | unchanged; transitive walker automatically follows R → W; no scan-list addition |

The server-combo-failover-e2e mock at :105 is not a source-text reader: it spreads actualRetry captured by import at :47 and overrides fetchWithTransientRetry. Keep both import and mocked function in the original path; no retargeting to W. No oracle needs retarget-to-leaf or add-leaf-to-scan-list. Do not weaken or combine the source assertions merely because another part of the file moved.

Guards to drive red once in implementation C, restore then prove green:

- Remove the onSendsConsumed call from R's finally block temporarily; tests/lib/transient-budget-scope-source.test.ts:51 must fail. Restore; the guarded function is not moved.
- In W temporarily remove releaseResponseBodyBestEffort's signal.addEventListener("abort", onAbort, { once: true }) statement (original :113); tests/lib/upstream-retry.test.ts:113 must fail because the aborted wait no longer settles promptly (the 60-second release deadline exceeds the test timeout). Restore without changing source logic in the final diff.
- Temporarily add a static ../lab/paths import to W; tests/lab/core-lab-boundary.test.ts:284 must fail through the existing protected-root graph. Remove; never edit PROTECTED.

Keep behavioral wait tests at tests/lib/upstream-retry.test.ts:67, :76, :98, :113, :127, :268 and :288 unchanged. No guard was run or mutated during drafting.

## Verification

Implementation-only instantiation of 002 in this layer's dedicated worktree:

    bun run typecheck
    bun test tests/lib/upstream-retry.test.ts tests/lib/transient-budget-scope-source.test.ts tests/providers/upstream-transient-retry.test.ts tests/codex-integration/issue-914-transport-attribution.test.ts tests/codex-integration/upstream-reachability.test.ts
    bun test tests/server/server-combo-failover-e2e.test.ts
    bun run privacy:scan
    bun test tests/lab/core-lab-boundary.test.ts
    wc -l src/lib/upstream-retry.ts src/lib/upstream-retry-wait.ts
    rg -n 'from "[^"]*/upstream-retry"' src gui/src scripts tests | wc -l
    git diff --check
    git diff --numstat origin/dev...HEAD -- src/lib/upstream-retry.ts src/lib/upstream-retry-wait.ts

Domains: lib, providers, codex-integration and server, plus mandatory lab boundary. Run the mock-heavy server-combo-failover-e2e file in its separate Bun process as shown. Recorded static-from baseline: 25 matching lines. Compare before/after and separately confirm the resolved importer census remains 25 distinct files, including dynamic/mock paths; these are different measures despite the equal totals. Compare all 19 original exports (14 runtime and five types) and verbatim moved bodies/comments. Require no imports in W via rg -n '^(import|export).*from|^import ' src/lib/upstream-retry-wait.ts (no matches); with R's single new outward edge this rules out any new cycle. Preserve R's original abort dependency.

Full suite only on lidge, with true exit status retained instead of a tail pipeline:

    ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lib-upstream-retry && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test'

Parent coordinates the remote checkout and captures printed SHA, full-suite result/exit and exact-head CI rollup. Bind all results to the current PR head. No local full-suite run; no test execution by this document author.

## Accept criteria

1. Only W is added; the six wait-group declarations move verbatim from :49–173. Remaining 22 declarations and the abort import stay in R.
2. All 19 original exports remain importable at the original path. Five value and one type re-exports are explicit; the two residual helper calls have real local bindings. UpstreamRetryEvidenceError identity is unchanged.
3. Actual files are at most 400 lines, planned W=125 and R=309; source churn at most 500. Any formatting/count deviation is reconciled before readiness; no #b debt remains.
4. All seven numeric constants and the request-wide send budget retain their single owner. No moved timer/listener becomes module state, no return import or new cycle exists.
5. The budget source reader and server mock retain their original paths/assertions. All three planned red drives fail as expected and return green after restoration.
6. Focused suites, typecheck, privacy and lab boundary exit 0; original importer census remains 25. Full remote suite and full exact-head CI rollup are green at the recorded PR head; no local full-suite run.
7. PR base and ancestry match current L2, full template and stack map are present, and no merge/release is performed.

## PR

Title: refactor(lib): isolate abort-aware retry waits (split S01 L3/3)

Branch: codex/split-lib-upstream-retry. Base: dev. Closes: none.

Fill .github/PULL_REQUEST_TEMPLATE.md Summary, Verification and Checklist; include exact-head results and this DEV-STACK-03 map. Review this layer's diff only. PR numbers are intentional pre-publication placeholders.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 3 | #TBD-S01-L3 | upstream retry — this layer | codex/split-lib-upstream-retry | dev | wait/body ownership |
| 2 | #TBD-S01-L2 | errors | codex/split-lib-errors | dev | message predicates |
| 1 | #TBD-S01-L1 | redact | codex/split-lib-redact | dev | folding and offset identity |

Base: dev — no dependency on the layers below; no cascade obligation.
