# One request-wide replay grant through translated dispatch

Depends on: existing reset-grant/send-budget owners; no new public type or config field.

## File map and concrete delta

- MODIFY `src/server/responses/adapter-dispatch.ts`: carry source #6525 imports, budget Pick fields `claimAmbiguousResend`/`sendsUsed`, memoized inbound self-contained judgment and one pre-header grant callback. Pass that same callback to both initial and rebuilt generic retry helpers. For reset opt-in, supply remaining send allowance and `noteTransientSends` to both helpers. Preserve compact prepaid sends and adapter-owned branches.
- Refine recovery accounting in that same file: all helper-counted reset-only credential/repair hop reservations must set `countedExternally` just like transient helpers; physical sends and workflow counts must agree. Exact configured transient totals must be reduced by prior sends and cannot borrow the final recovery reserve. Any adjustment stays in generic adapter dispatch and is activated by focused regressions.
- NEW `tests/responses/responses-translated-reset.test.ts`: carry all 10 original tests. Add previous-id refusal (construct valid stored predecessor if needed), post-header/output failure with exactly one physical send, shared grant across initial and rebuilt legs, explicit total across rebuilt legs, prepaid recovery accounting, and a loopback upstream which reads a full request then closes before headers, succeeds on the replacement, and verifies identical bodies and exactly two sends. Deterministic completion signals and `finally` cleanup, no sleeps for synchronization.
- MODIFY `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`: register the new test under responses with consistent existing indentation/order.
- MODIFY `src/types/provider.ts`: describe pre-header translated generic fetch support; no type/schema change.
- MODIFY `docs-site/src/content/docs/reference/configuration/providers.md` and corresponding `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` pages: carry source policy extension, clarify existing native-only introductory wording, retain default-off/self-contained/grant/billing caveats and explicitly exclude adapter-owned and post-header translated failures.
- MODIFY `structure/transports/responses-failover.md`: state initial/rebuilt shared-grant behavior and accounting, link added regression; keep `fetchWithResetRetry` tool-side `replaySafe` distinct from operator grant.
- Existing unit docs record decisions, verification and publication; no screenshots or raw security notes enter public commits.

## Execution and delegation

After independent A audit, a bounded gpt-6.1-sol executor owns adapter-dispatch and the new test/layout entries, with no branches/commits/goals/FSM. Main handles integration, git and evidence. A separate doc executor owns provider type comment, the eight provider pages and failover SoT. Write sets are disjoint. Fresh independent C reviewer checks all changed files and source coverage.

## Acceptance activation

| Scenario | Observable proof |
|---|---|
| Bare opt-in plus pre-header reset | HTTP 200, two byte-identical translated sends, request/workflow count two |
| No/disabled opt-in, stored or prior state | No replay; existing refusal (or prior-state admission), no spent replacement |
| Grant already spent/repeated resets | At most the configured shared replacements; refusal preserves non-replayability |
| Effort refusal then reset on rebuild | Three sends, same downgraded bytes for final two, count three |
| Initial replacement returns a recoverable-looking HTTP failure | Non-replayable refusal prevents rebuild/target hop |
| Effort refusal reaches rebuilt send with already-spent shared grant | Rebuilt reset refuses replacement; grant is not reset |
| Exact one-send/total cap/exhaustion | No physical send beyond cap, zero dispatch when initially exhausted |
| Credential/repair prepaid hop | Count every wire send exactly once; workflow matches request count |
| Abort during failing send | 499 and no replacement |
| Post-header stream failure/output | No reset replay and no second upstream request |
| Real loopback reset | Full request consumed then socket closed before headers; replacement succeeds exactly once |
| Core optional subsystem | `tests/lab/core-lab-boundary.test.ts` stays green |

## Verification

Baseline commands executed before implementation: `bun test tests/lib/ambiguous-resend-gate.test.ts tests/responses/responses-reset-replay.test.ts` (23 pass); `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts tests/ci-workflows/file-size-ratchet.test.ts` (27 pass); `bun run structure:check`, `bun run privacy:scan`, `bun run typecheck` (completion recorded in evidence). Test paths are direct arguments, structure/privacy scripts inspect repository files, and tsconfig includes `src`.

After implementation run the new test plus reset/reasoning-downgrade/send-budget/fast-downgrade/lib-grant and core-lab suites; repeat static gates once on final code. Docs validation uses `cd docs-site && bun install --frozen-lockfile && bun run build`. Confirm the new happy-path test fails on original dispatch before claiming regression proof. Wider native/broad coverage belongs to real hosted PR checks; `.github/workflows/ci.yml` runs on ordinary `pull_request` events, not branch pushes. Missing/skipped/pending checks remain missing proof.

## Boundary strength

Existing runtime gate executes synchronously at ambiguous replay admission and uses the shared budget; no new enforcement layer is introduced. Known bypass: adapters owning `fetchResponse` retain their own policies outside this lane. Residual: upstream may have executed an inference before reset, which is why opt-in and billing caveats remain. No claim of exactly-once upstream inference.

Documentation coverage amendment: also MODIFY `structure/transports/responses.md` reset-replay ownership row and `ResetReplayPolicy` comment at `src/types/provider.ts:71`. Qualify failover helper prose at lines 52/62 to distinguish `replaySafe` from the existing operator-grant override. Scout reviewed all 20 mapped server/type SoT documents; no other consequence changed.

Architect refinements accepted (RETRY-D02/D03): all six generic helper-funded hop sites use transient OR reset policy for `countedExternally`. Exclude an already-booked pending permit from prior sends when calculating the exact configured remaining cap; preserve its last funded slot without opening a final reserve. Assert wire count = request delta = attempt-log count, with workflow count where observable. No new runtime file owner is needed.
