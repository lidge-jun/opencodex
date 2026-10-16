# B3 — restart proposal hold

Depends on B2 integration into current `dev`. This is a disposition cycle for [#6085](https://github.com/lidge-jun/opencodex/pull/6085), not a source patch. Independent review found that its restart retries and post-deadline recovery can report success or launch a second proxy without proof the first attempt ended. A safe narrowed carry would need a production test seam that distinguishes pre-launch refusal, health-publication lag, and a later integration failure. That expansion is outside this train's bounded restart change. Keep the candidate open and comment with the concrete blockers.

## Exact action map

| Path or surface | Change |
| --- | --- |
| `src/cli/tray-proxy.ts`, `src/cli/index.ts`, `src/cli/dispatch.ts` | NO CODE CHANGE in B3. Preserve current once-only in-place restart, identity and replacement deadline. |
| `tests/windows/tray-proxy.test.ts`, `tests/cli/cli-restart-health.test.ts` | NO TEST CHANGE in B3. Existing coverage remains the baseline; no passing test is described as proof of the candidate. |
| `docs-site/src/content/docs/reference/cli/lifecycle.md`, `structure/runtime.md` | NO CONTRACT CHANGE in B3. Current warning and fail-closed behavior remain documented. |
| `000_plan.md`, `050_disposition_and_ci.md` | MODIFY candidate disposition, record this audit and the URL of the English PR comment. |
| [PR #6085](https://github.com/lidge-jun/opencodex/pull/6085) | COMMENT in English, then leave open. Explain the accepted-restart handoff race, start-return ambiguity, and exact tests needed for reconsideration. No merge or close. |

## Evidence and reconsideration gate

At `dev` `24b2f39b77`, `runProxyRestart` in `src/cli/tray-proxy.ts:149-198` starts only after confirmed absence and never replays a possibly accepted request. The candidate adds three start attempts and starts again after a post-deadline empty re-observation. An accepted restart may still publish its replacement after that empty observation. The `startWhenStopped` boolean can mean no start was attempted (`src/cli/index.ts:757`, `src/cli/tray-proxy.ts:110`) or a detached child was launched but has not become healthy (`src/cli/index.ts:789-803`). A healthy proxy can also precede a later integration exception (`src/cli/index.ts:809`), so a generic "marked start failed" recovery would hide that error. The service path can refuse before `ops.start()` (`src/service/cli.ts:345`). These cases need a typed production outcome or equivalent phase evidence plus tests that reach both real CLI start adapters; coordinator-only injected callbacks are insufficient.

Baseline verifier: `bun test tests/windows/tray-proxy.test.ts tests/windows/tray-proxy-deadline.test.ts tests/cli/cli-restart-health.test.ts tests/cli/cli-restart-handoff.test.ts` ran on `24b2f39b77`: 45 pass, 0 fail. No patch was tested or landed. The gate for reconsideration is a current-dev diff with observable tests for pre-launch refusal, late health after a launched child, post-health reconciliation failure, service preflight refusal, accepted-restart late replacement, and an actual production adapter invocation, followed by exact-head CI.
