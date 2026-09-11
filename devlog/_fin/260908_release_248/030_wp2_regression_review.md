# wp2 — regression review of the candidate against main

Reviewed `origin/main..origin/dev`: 70 commits, 162 files, 25 under `src/`, about 2096 changed source lines. The question this phase answers is narrow — does anything in that delta regress behavior that `main` currently ships? The local suite is NOT RUN by owner instruction, so the mechanical evidence is hosted CI and the argument below is a source read.

## What changed, by risk

Credential and quota handling carries the most weight. `src/codex/routing.ts` factors the background recovery settle path into `settleCooldownRecoveryLease` and adds a manual-reset claim/settle pair. The refactor moves `cooldownSource === "reset-derived"` and the scope restriction into the shared settle helper, which reads at first glance like a new restriction on the pre-existing background path. It is not: `claimDueCodexQuotaRecoveryProbes` already filters candidates to `(scope === undefined || scope === "shared")` with `cooldownSource === "reset-derived"`, so no claim that could previously settle successfully can reach the helper and fail those conditions. `tests/codex-integration/codex-cooldown-recovery.test.ts` and `codex-reset-credit-auto-redeem.test.ts` cover both paths.

`src/codex/auth-api.ts` adds a `dispatchSequence` fence around WHAM usage publication so a slow in-flight response cannot overwrite a newer published quota. The added early returns hand back the cached account info rather than publishing, which is a strict narrowing of when stale data wins.

`src/server/responses/core.ts` adds combo session recall for compaction triggers and a completion callback gate. The recall path is guarded on a bare model name, an actual `compaction_trigger` input item, no configured selector, and no resolvable combo id, so a request that previously routed by explicit selector still does. The previous-response error code changed from `invalid_request_error` to `previous_response_not_found`; that is a deliberate behavior change so Codex reconnects with full input instead of terminating the task, and it is the fix's whole point.

`src/router.ts` and `src/providers/default-aliases.ts` extend alias-ownership so a provider's own configured name also claims an alias, not just an explicit `alias` field. This makes an ambiguous alias resolve to nothing rather than to the wrong provider — a correctness fix with a narrow blast radius.

`src/config/atomic-write.ts` replaces `constants.O_WRONLY | O_CREAT | O_EXCL` with the `"wx"` flag string, which is the same semantics expressed portably; that was the point of the change on Windows.

## Coverage

Forty test files changed alongside the 25 source files, and every source area above has a focused test in the same domain directory. No source change in the delta arrived without paired coverage.

## Hosted evidence

Push-event run on `9ad218a9bdd34ee33004c35706d78396bf02eef2` (runtime-identical to the candidate): 19 successful check-runs, 2 skipped by design.

Dispatched full-lane run [34206043085](https://github.com/lidge-jun/opencodex/actions/runs/34206043085) on the exact candidate `7797586a8899c673eab48886a490e85b480c6d72` with `lane=all`, which adds the six Windows shards and the unsharded macOS control that the push event does not run.

## Verdict

No regression identified against `main`. The delta is corrective, each risky path narrows rather than widens behavior, and the one intentional behavior change (the previous-response error code) is the documented fix.


## Full-lane CI outcome

Run [34206043085](https://github.com/lidge-jun/opencodex/actions/runs/34206043085) on the exact candidate `7797586a8899c673eab48886a490e85b480c6d72` completed **success** after one rerun of a single job.

The first attempt failed on `windows 3/6`: `provider outbound GET transport > proxy mode reaches one real proxy across outbound, connection-test, and model-discovery paths` timed out at its own 15s bound, and the spawned fixture child was killed (exit 143). That test file is not in the release delta — `git log origin/main..origin/dev -- tests/providers/provider-outbound.test.ts` is empty — and the same content passed `windows 3/6` in dispatch run 34198186409 ninety minutes earlier. Rerunning the failed job passed. The evidence points at cold-runner timing on a 15s child-spawn budget, not at anything the candidate changed.

That timeout is a real fragility worth tightening later, but it is not a 2.48.0 regression and does not block this promotion.

