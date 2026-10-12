# Source inspection and verification evidence

- Worktree initial HEAD b82b39018b48ad489110b4165ee2cd9ba30433d5; fetched dev cb2d1736a858a69b3d95944d531f48b93c2f56a5 differs only in CLI/help files. Revalidate before implementation and publication.
- Source PR #6508 open at dd4fc9a8f732699d88f46058c3298073d9aa2317, author Maxy Milan Sorée <maxy@mxymedia.nl>; five changed paths, no returned reviews/comments, stacks API returned []. Source body reports a synthetic native macOS/Bun repro; it is not our runtime proof.
- Issue #6504 lacks complete client wire capture; the reported recovery is anecdotal. Current catalog/launcher docs do not establish a guaranteed 1M native upstream window.
- src/claude/outbound.ts:249 derives failed status, but :726 drops code at fail. src/protocols/encoders/messages.ts:390 does likewise. src/server/claude-messages.ts:1398 and direct encoder :449 collapse collected errors to 502. The JSON/non-2xx branches also discard context identity.
- src/server/responses/context-overflow.ts:19 produces classified context terminal events for provider HTTP 413 with proxy-owned copy. Preserve this owner.
- src/server/inference/client-encoder-delivery.ts:46 excludes Responses-wire routes from direct encoding; direct encoder tests must exercise AdapterEvents.
- `bun install --frozen-lockfile --ignore-scripts`: exit0, existing lockfile unchanged. Install log in ignored scratch.
- Initial transport baseline: exit1, missing zod/v4, no behavior executed. After install same three explicit test files: exit0, 27 pass, 0 fail, 64 assertions; .tmp/release-stabilization/transport-baseline-installed.log.
- New helper owner search: `context_length_exceeded`, `anthropicFailedStatus`, `anthropicErrorBody`, `collectAnthropicMessageResponse`; reuse outbound error classification and exact code comparisons, not a parallel classifier.
- Private conversation capture and real paid upstream probes have not run. Synthetic fixtures are sufficient for proxy wire regression proof; native client compaction is a separate evidence limit.

- Messages baseline: bun test tests/claude-integration/claude-outbound.test.ts tests/responses/protocol-direct-encoders-messages.test.ts tests/responses/responses-context-overflow.test.ts exited0: 143 pass, 0 fail, 597 assertions (messages-baseline.log).

- Architect same-handle reflection: ALIGNED; D1-D5 map to plan. Incorporated baseline freshness, executor-vs-network distinction, Retry-After activation and failed-JSON reachability clarifications. No material design gaps.

- Independent A reviewer 01a10218-d4e7-7f63-9f01-8582de5584be: GO-WITH-FIXES (blockers=0). Main accepted all four clarifications: failed-JSON reachability, prior exact assertion update, non2xx400 versus precedence negatives, baseline freshness/exact future command. No design/ownership expansion.

- Docs-only B finalized the approved roadmap and checked that no runtime paths changed. Synthetic isolated Claude Code2.1.288 local HTTP400 probe exited1 in0.38s displaying API Error400; two local Messages requests were observed, so this proves surfacing/prompt termination only, not zero retry or automatic compaction. No private conversation or real provider was used; ignored probe artifact retained.

- Transport P revalidation: previous D direction was carry6508 then Messages. Rebased docs commit onto cb2d1736a8; transport paths are byte-identical to the architect/auditor reviewed source. 010 remains the executable plan with unchanged D4 decisions; existing proposal/reflection and whole-roadmap audit remain applicable.

- Transport B: cherry-picked6508 with -x (0076dc5b0b), original author retained; added UTF-8 exact threshold, destination-away and AbortError executor tests. Focused initial green exit0. Removing byte conversion made the boundary tests fail (transport-mutation-red.log); source restored before broader affected transport checks. No retries or credential policy altered.

- Transport C/D: 199 passed,0 failed,1 older-runtime skip; mutation6fail. Typecheck/privacy/structure exit0; docs561 pages/77932links pass. Pinned Bun postinstall was completed after ignore-scripts prevented bun-run commands; no lockfile change. Independent code/security reviewer01a10221-1acd-7f90-92c9-ae96f95229f1 returned PASS, no blockers, four extra synthetic boundary probes passed. Next: publish transport and continue Messages.

- Messages P revalidation: transport D concluded reviewed upload bytes are ready; continue020 per roadmap. All three Messages runtime files remain identical to original architect/reflection/audit source. Same D1-D3/D5 decisions apply with accepted reachability clarifications; no credentials/compaction-policy edits. Transport published as PR6513, and Messages is a separate child branch pending parent integration.

- Messages B: new real HTTP Messages regressions first failed8 cases (502 collection/JSON, missing stream code, retry hint leak), then passed. Restoring all three pre-fix source files with current regressions caused13 failures; restored fixes afterward. A canonical native final-send fixture also asserts actual Messages SSE/JSON and exactly1 upstream send. Explicit Direct stored-main variant encountered the separately owned auth fence (requires caller bearer); used the existing canonical-forward fixture pattern without changing credential owners.
- Messages affected command from020 passed211 tests/0 failures across5 files. Defensive upstream JSON remained JSON into the ingress: stream true also returns HTTP400 as asserted. Existing endpoint negatives preserve unrelated failures.
- Composed real-client probe: isolated Claude Code2.1.288 -> proxy /v1/messages -> canonical native Responses executor redirected to synthetic upstream response.failed/context_length_exceeded. Exited1 in0.765s,3 bounded upstream requests, displays API Error400 and synthetic input-limit message, no timeout. Client uses known Claude model name mapped in isolated config to native GPT destination. It proves composed surfacing/termination, not zero retries, real account behavior or automatic compaction. First unrecognized fixture alias was rejected by client before upstream (0hits) and is not counted as passing evidence. Scratch script/log retained; no private conversation or external provider used.

- Test placement amendment: registering a new Messages test hit NEW_OVERSIZED at2000lines in test-layout-expected.json. Move the new cases into the existing claude-outbound.test.ts under a nested fixture scope (remains below2000), remove only our new registry row/file; preserve ratchet, no cap increase or formatting workaround. Runtime/interface/flow decisions unchanged.

- Messages C/D: after relocating fixtures,238 tests passed/0fail across7files including layout/ratchet; typecheck/privacy/structure exit0,docs561pages/77932links pass. Independent implementation/security reviewer01a10230-ce6c-75c3-b677-9edafdd2b12a PASS, blockers0; additional partial-output/cancellation/exact-code-negative probes passed. Next publish Messages child and complete exact-head hosted evidence; no claims of native account/automatic-compaction success.
