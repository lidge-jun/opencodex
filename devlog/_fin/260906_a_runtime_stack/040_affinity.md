# 040 — Command Code conversation affinity (#3581)

Status: candidate implementation plan, researched 2026-09-06 KST. Depends on the
verified `030_recovery.md` layer for stack integration into its reparse owner.
This first-cycle artifact is docs only; re-read current source at this layer's P.

## Implementation-cycle completion versus landing

This decade cycle ends with a reviewed prepared draft PR, exact-carried-head focused remote activation evidence and remote typecheck, with full CI dispatched. That cycle D does not claim the bug shipped, full CI passed, or an issue resolved. `080_landing.md` retains the mandatory full current-head cross-platform/type/privacy/docs evidence, review, dev ancestry and immediate source-PR/fully-resolved-issue closure gates. Later P consumes the verified prepared stack parent; it need not have landed yet. Only final landing yields feature DONE.


## Loop specification and scope

- Class: C4 for conversation/cohort isolation; archetype: spec-satisfaction
  repair. One implementation PABCD cycle owns this document.
- Trigger: repeated Command Code requests from the same identifiable conversation.
  Goal: stable opaque session affinity without treating shared cache cohorts as
  individual conversations; enable API-key provider cache-key forwarding.
- Non-goals: Hermes #3433 diagnosis, measured cache-hit/cost promises, OAuth
  refresh changes, a global session registry, prompt-text-derived identity,
  default trust for unclassified cache keys, or extra OAuth cache-key forwarding.
- Verifier: remote identity/forwarding/reparse regressions, full current-head CI,
  privacy/type gates and independent boundary review. No local verifier runs.
- Stop: reviewed prepared draft atop recovery, with exact-head remote focused/type evidence. Full current-head gates and dev ancestry remain required in 080.
- Memory artifact: this file plus main-owned roadmap/ledger. Main alone owns
  FSM, goal, implementation, Git and stack integration.
- Resources: existing gh credentials and later own-branch writes only. Inherited
  parallel reviewers authorized; downward changes are a P amendment and main
  reclaims after two distinct worker failures. No explicit user token/cost cap;
  2-hour checkpoint triggers reassessment. This planner writes only the two
  assigned documents; no Git/GitHub mutations or tests/typecheck/build.
- Public scope: already-public patch behavior and general integration plan only;
  new security investigation notes belong in `.tmp/`.

## Provenance and source anchors

Live dev/local HEAD: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`.
[Original PR #3581](https://github.com/lidge-jun/opencodex/pull/3581) head and its
single feature commit: `f60397d3408e0339ffc66acdcaca8133e40866c2`, retained at
`refs/codex/a-original/3581`. Author: `SB Yoon
<44089734+yansigit@users.noreply.github.com>` (GitHub `yansigit`), original
authored date 2026-09-05T01:58:50Z. Preserve original author on carry and include
`Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>` in any
rewritten/squashed landing. Do not rewrite the contributor's branch.

Current source still uses `randomUUID()` unconditionally at
`src/adapters/command-code.ts:528`. The helper insertion owner is the same file
after `projectSlug` at line 212. Current `src/server/responses/core.ts:2954`
parses the request, line 2987 assigns inbound thread id, lines 2990–3004 classify
the separate replay scope, and line 3262 preserves fields after recovery.
`src/types/request.ts:71` holds `_clientThreadId` without the proposed cohort
field. `src/providers/registry.ts:2169` is API-key `commandcode`; line 1332 is
OAuth `command-code`. They are separate transport contracts.

Owner searches: `commandCodeSessionId`, `promptCacheKeyIsSharedCohort`,
`prompt_cache_key`, `_clientThreadId`, `_reasoningReplayScope`. Existing
classification, provider derivation and Chat serialization already exist; reuse
them. `src/providers/xai-transport.ts:101` has a different provider's derivation;
do not reuse its namespace/contract for Command Code. Doing nothing retains
random affinity, configuration cannot change the header builder, and no matching
Command Code helper exists. No new cache/service dependency is warranted.

## Exact implementation change map

| Action / path | Before → planned after |
|---|---|
| MODIFY `src/adapters/command-code.ts` | Import `createHash` alongside `randomUUID`; add exported `commandCodeSessionId(parsed)`. Select trimmed `_clientThreadId`, else trimmed replay `clientThreadId`, else trimmed `options.promptCacheKey` only when cohort marker is exactly false. With no identity return randomUUID. Hash `command-code:${kind}\0${identity}` with SHA-256 and form the original opaque UUID-shaped value, preserving explicit version/variant nibble comment. Use helper for x-session-id. |
| MODIFY `src/types/request.ts` | Add optional internal `_promptCacheKeyIsSharedCohort?: boolean` beside `_clientThreadId`; document true=shared, false=explicitly conversation-scoped, absent=unclassified. Do not expose it as a client JSON input field. |
| MODIFY `src/server/responses/core.ts` | Immediately after initial `parseRequest(body)`, copy `options.promptCacheKeyIsSharedCohort` onto parsed internal marker. Add marker to the existing `kept` list in recovery reparse, now containing #3568 restoration. Preserve all sibling fields and both true and false values (undefined-only filtering). |
| MODIFY `src/providers/registry.ts` | Add `promptCacheKey: true` only to `commandcode` API-key provider. Leave OAuth `command-code` transport setting unchanged. |
| MODIFY `tests/providers/command-code-provider.test.ts` | Carry stable/opaque identity, precedence, different-identity, UUID shape and random fallback tests; add whitespace-only fallback and same literal under different identity-kind cases. Assert actual built x-session-id as well as helper output. |
| MODIFY `tests/providers/commandcode-provider.test.ts` | Extend registry expectation and construct real Chat request with promptCacheKey, asserting prompt_cache_key body forwarding. Retain explicit disabled-provider override behavior. |
| MODIFY `tests/claude-integration/claude-code-thought-signature-scope.test.ts` | Carry true/false/undefined propagation assertions in existing drive helper; retain the independent replay-scope expectations. |
| MODIFY `tests/server/server-agent-task-recovery-replay.test.ts` | Parent-layer test file exists after 030. Add real handler/adaptor-boundary observation of marker preservation for recovery and cache-only restoration, with true/false/undefined cases. Use the existing fixture/post helper; no source-text assertion as a substitute for executing reparse. |
| MODIFY `docs-site/src/content/docs/reference/adapters.md` | Add a concise Command Code subsection describing OAuth x-session-id priority/random fallback and API-key commandcode prompt_cache_key forwarding separately; no cache-performance promise. This is a docs-sync addition beyond the original seven-file patch. |

No NEW or DELETE production/test files. The modified replay test is owned by the
parent layer and already registered there. No layout manifest update is needed
for modifying it. Keep the new helper in its existing adapter: no parallel
factory registration or session cache. `structure/10_adapter-registry.md:5`
remains authoritative and needs no factory-policy change; adapters.md is the
user-visible contract sync target.

## Explicit handler-fixture amendment

MODIFY `tests/helpers/agent-task-recovery.ts:144-159`: extend the sixth `post` options argument with `promptCacheKeyIsSharedCohort?: boolean`, and forward it to the fourth `handleResponses` options argument alongside abortSignal and translatorBudget. Do not put this internal field in the JSON request body. Existing callers default to undefined and remain unchanged.

MODIFY `tests/server/server-agent-task-recovery-replay.test.ts`: parameterize true/false/undefined, use the extended `post` helper for an initial admitted recovery and a continued cache-only replay, and observe the parsed request at the real selected adapter buildRequest boundary via a temporary spy restored after each test. Assert the exact internal marker and existing thread/replay metadata on both calls; assert only one recovery backend call. The later P must bind the spy to the actual exported adapter selector in that carried tree. A source-text assertion is not an alternative to the real reparse execution.

## Complete field and value chain

1. Creation: `src/server/claude-messages.ts:836` passes
   `promptCacheKeyIsSharedCohort: cacheKeySource === "system"` into
   `HandleResponsesOptions` (`core.ts:1548`). The new initial-parse assignment
   carries true/false/undefined unchanged. `_clientThreadId` and replay scope use
   their existing ingress owners; do not infer new trust from request content.
2. Internal transfer: `OcxParsedRequest` optional field and the `kept` list copy
   it across `parseRequest` after both fresh and cached recovery. It is process
   request metadata, not persisted configuration or continuation data.
3. Serialization/deserialization: the internal marker has no wire representation
   and no persisted migration (N/A intentionally). `parseRequest` at
   `src/responses/parser.ts:526` already maps public prompt_cache_key into options;
   clients cannot supply the internal classification through that mapping.
4. Consumers: `commandCodeSessionId` permits the cache-key fallback only for
   `=== false`; true/undefined both fail closed. Existing replay/cohort consumers
   at `core.ts:2990`, `core.ts:3560` and
   `src/oauth/anthropic-routing.ts:781` keep their distinct semantics; do not
   broaden/rewrite those predicates as incidental cleanup.
5. Provider capability chain: registry promptCacheKey →
   `src/providers/derive.ts:252` defaults and line 512 reconciliation → routed
   provider config → `src/adapters/openai-chat.ts:1573` serialization (and raw
   body forwarding at line 156). Original API-key regression observes the wire
   body, rather than only asserting registry metadata.

## Activation and independent acceptance

| Trigger | Required observation |
|---|---|
| Same trimmed explicit thread, differing replay/cache values | Same opaque x-session-id in actual built requests; thread wins. |
| No explicit thread, same trimmed replay identity | Stable header; changing replay identity changes it. |
| Neither thread nor replay, nonempty key with marker false | Stable cache-derived header; whitespace trimmed. |
| Same literal in thread/replay/cache namespaces | Different opaque values by kind; preserve original hash namespace. |
| Shared=true or unclassified marker, only cache key/prompt text | Fresh UUID each request; no prompt/body-derived identity. |
| Empty/whitespace identity or no identity | Random fallback, no accidental stable empty-string cohort. |
| Explicit thread with shared=true | Explicit thread remains valid; shared classification disqualifies only cache fallback. |
| Initial parse then successful fresh or cache-only recovery reparse | Adapter observes original true/false/undefined marker and original thread/replay metadata; stable affinity semantics survive. |
| API-key commandcode using route-derived config | Chat body carries prompt_cache_key when present/enabled; absent key or explicit disabled capability omits it. |
| OAuth command-code | Uses proprietary x-session-id builder; this patch does not opt its registry entry into Chat cache-key forwarding. |
| Synthetic raw identity strings | Header matches UUID-shaped contract and contains no raw identity. No added identity logging. |

C must drive both the helper and real adapter/handler paths. This plan claims a
stable request header, not proven provider cache savings or a provider guarantee
that distinct sessions receive distinct workers. Any credentialed live provider
smoke needs main's chosen authorized runtime scope; a synthetic wire test is not
misreported as real upstream acceptance.

## Review disposition, drift and stack order

Live PR is non-draft, MERGEABLE, REVIEW_REQUIRED. GraphQL has zero review threads;
there is no current formal approval. The author already incorporated UUID
nibble explanation and retained API-key-only forwarding/unclassified-key
fallback in the original head. Latest
[author update](https://github.com/lidge-jun/opencodex/pull/3581#issuecomment-5549518114)
reports 18,244 passes on `be81013fa` base; those historical results do not validate
the current parent tree. Older draft/failure commentary is superseded.

The original patch context predates the current core: original initial-parse
line 2896 is now 2954 and original reparse area around 3210 is now 3262. Carry by
function/field ownership; never replace current core with the older file. Refresh
onto the completed 030 layer and preserve both restoration behavior and the new
cohort marker. Coordinate the shared core with C-lane #3576 through main. This
is not a fix for #3433 and must not close that issue.

Main publishes a child PR targeting the recovery branch if that PR is still
open; after parent squash/merge, replay only this layer onto dev and retarget.
Revalidate exact diff, review and CI for every new head. Original contributor
credit survives cherry-pick/reimplementation/squash. Own-branch `--no-verify`
pushes are authorized; local prepush hooks must not start a suite. Close original
#3581 once the equivalent change is proven on dev; do not close merely because
a carrying child PR exists. No Git/GitHub action is performed by this planner.

## Remote-only verification and CI coverage

All commands below: **NOT RUN, exit N/A during planning**, per explicit user
instruction. Later main runs them only in the remote checkout of the exact layer
and records SHA, command result and artifact/CI URL.

Main verified `REMOTE_HOST:REMOTE_SOURCE_CHECKOUT` and Bun 1.3.14. Use an isolated
remote clone at the exact carried SHA for focused activation tests/typecheck;
do not mutate the existing remote checkout for this layer. Its Bun version
differs from package.json's 1.4.0 pin, so this is supplemental evidence. Carry
PR stays draft until full current-head GitHub CI is green. Final landing cycle
requires every full gate on the configured remote runners.

Implementation C, in the isolated remote clone:

```sh
bun test tests/providers/command-code-provider.test.ts tests/providers/commandcode-provider.test.ts tests/claude-integration/claude-code-thought-signature-scope.test.ts tests/server/server-agent-task-recovery-replay.test.ts
bun run typecheck
```

Full landing gates, remote only:

```sh
bun run test
bun run privacy:scan
bun --cwd docs-site run build
```

Focused direct arguments cover identity selection, actual request headers/body,
cohort propagation and parent recovery interaction. `tsconfig.json:15` includes
src; `package.json:43` maps full suite to `scripts/test.ts`, whose line 321 adds
`./tests/`. No claim that typecheck covers prose. Docs require remote build plus
manual comparison of actual transport semantics.

Static workflow proof: `.github/workflows/ci.yml:7` permits child PR bases;
lines 182–186 select runtime/tests, line 316 runs Linux batches, and
`scripts/ci/run-bun-test-batches.sh:197` recursively enumerates tests (accepted
suffixes at line 58). macOS line 532 and Windows line 754 cover tests shards.
Lines 422–431 run typecheck/privacy. Thus this runtime layer should activate
real jobs even though its parent is not dev. Runtime CI does not guarantee the
new documentation subsection's accuracy; review it explicitly.

Optional later manual dispatch:
`gh workflow run ci.yml --repo lidge-jun/opencodex --ref OWN_LAYER_BRANCH -f lane=all`.
Record run headSha and actual checkout SHA; this workflow exposes only lane,
not expected-SHA pinning. For PR CI record current PR head and synthetic merge
SHA. Require completed successful producer jobs and independent review of the
current patch; author-reported tests, skipped producers, stale green heads and
hygiene checks cannot complete this layer.
