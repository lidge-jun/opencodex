# wp3 revalidation — authoritative provider operations

Previous D: wp2 closed at `8379bdd821e35b2dd0d3f7eec3da366499bbd3cf`, after integrating dev `a99de42e7a`. The final source-bound gate passed 404 tests across 23 files, typecheck, structure, generated-surface, privacy, docs and whitespace checks. Seventeen real isolated CLI scenarios passed. Both independent code re-reviews ended PASS. Layer 1 is [PR #6526](https://github.com/lidge-jun/opencodex/pull/6526); broad hosted CI remains tracked separately. The next branch is `codex/cli-parity-providers`, based on that exact parent.

## Fresh source findings

The provider-editor parser and field policy remain authoritative in `src/server/auth-cors.ts`. The GUI projects exactly defaultProvider/providers and removes four display markers. Snapshot must validate the resulting public DTO before output; apply must refuse forbidden fields rather than strip them. The server retains deep candidate validation, DNS checks and public-baseline CAS. No new management route or provider adapter is necessary; `provider-routes.ts` remains near its file-size cap.

Pacing observations do not contain editable rules. `providerRequestPacingStatus` returns queue/timing/enabled/in-flight observations. Scalar edits must read the selected provider's stored requestPacing from the pinned config/provider DTO, not reconstruct it from status. Replacing this block by PATCH preserves only the observed fields; it is not a CAS promise.

`provider.ts` returns JSON before its requested local sync, and the human path can claim sync even without a running proxy. The change must report actual saved/sync disposition using the existing quiet sync seam; the no-live local save remains available. Live lifecycle dispatch must occur before any local load/save branch.

The batch PUT and single DELETE have different cleanup contracts. Batch replacement removes custom models/context caps and refreshes derived state, but does not invoke DELETE's OAuth account-set cleanup. Help must distinguish these effects rather than emulate extra deletions.

Baseline execution: `bun test tests/providers/provider-config-batch-management.test.ts` passed 10 tests, 71 assertions against this parent. It covers actual isolated management handlers and persisted state; no live configuration, credential or provider was used. This is baseline proof only, not verification of the forthcoming CLI layer.

## Consultation status

A same-architect source revalidation proposal and scoped security plan consultation inform the concrete amendment to 030. Security advice is scratch-only. Independent final A follows the executable amendment and same-architect reflection; no wp3 source implementation has started during P.

Concrete 030 digest `6f97c170adb7ddcf1975ed869459824b5e0dd3529d4c6dc95699e24edcff02ff` received same-architect ALIGNED reflection and scoped SECURITY A PASS, with no remaining numbered blockers. Artifacts: `.tmp/cli-parity/wp3-reflection.md` and the final section of `.tmp/cli-parity/wp3-security-plan.md`. General independent A remains a separate check before B. The broad runtime-api error proposal was deliberately narrowed to fixed provider-domain messages.

## C correction: applied injection is not catalog convergence

Independent code review reproduced an applied/ok backend result after catalog refresh threw. CLI-only status/ok projection would therefore repeat a false success. The narrow necessary extension preserves the existing optional refreshOutcome from the catalog result through src/codex/sync.ts's applied return; it changes no sync action, destination, configuration write or retry. The CLI now separately reports configApplied and catalog convergence, retaining needsSync/nonzero when refresh failed/refused, while unchanged valid catalogs need no write. Actual backend fixtures cover thrown refresh, refused refresh with an existing catalog, and unchanged committed catalog. Existing sync consumers receive only additive optional evidence; focused backend regressions are included in C. This correction was discovered during code review, not part of the earlier baseline pass.
