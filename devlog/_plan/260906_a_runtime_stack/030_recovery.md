# 030 — Native MESSAGE recovery and cached replay (#3568)

Status: candidate implementation plan, researched 2026-09-06 KST. This is a
docs-only deliverable. Revalidate during this layer's P after preceding layers
land; no implementation or verification pass is claimed here.

## Implementation-cycle completion versus landing

This decade cycle ends with a reviewed prepared draft PR, exact-carried-head focused remote activation evidence and remote typecheck, with full CI dispatched. That cycle D does not claim the bug shipped, full CI passed, or an issue resolved. `060_landing.md` retains the mandatory full current-head cross-platform/type/privacy/docs evidence, review, dev ancestry and immediate source-PR/fully-resolved-issue closure gates. Later P consumes the verified prepared stack parent; it need not have landed yet. Only final landing yields feature DONE.


## Loop specification and scope

- Class: C4 for the existing recovery admission boundary; C3 for destination
  normalization. Archetype: spec-satisfaction repair, one implementation PABCD
  cycle for this decade document.
- Trigger: native parent MESSAGE delivery or replayed encrypted task history on
  an opted-in routed child. Goal: preserve the admitted plaintext assignment and
  deliver supported plaintext Go Responses agent messages.
- Non-goals: #3571 catalog/effort ordering, multipart recovery, native-backend
  retry policy, new credential sources, recovery enabled by default, new routing
  metadata protocol, deployment/release work, or a general solution to #3661.
- Verifier: exact-layer remote focused regressions, full Cross-platform CI,
  privacy and type gates, and independent recovery-boundary review. Commands
  below are planned for remote execution only; none ran during planning.
- Stop condition: reviewed prepared draft and exact-head remote focused/type evidence; full CI/dev inclusion are required by 060 before feature completion. Partial #3661 stays open.
- Memory artifact: this file and main-owned `000` roadmap/evidence ledger.
- Outcomes: DONE only with the evidence above; NOOP only if current dev already
  contains equivalent behavior and regressions; BLOCKED for external CI/review
  dependencies; UNSAFE/NEEDS_HUMAN for a necessary expansion of admission policy.
- Delegation: inherited parallel read-only reviewers authorized. Downward scope
  changes require a P amendment; main reclaims a packet after two distinct worker
  failures. Main owns FSM, implementation, commits and stack integration.
- Resource scope: existing gh credentials; later writes restricted to own stack
  branches and scoped PR administration. This worker writes only this plan and
  `040_affinity.md`. No explicit user token/cost cap; a 2-hour checkpoint triggers
  reassessment, not an automatic success or exhaustion claim. No local tests,
  typecheck, build, Git mutation or GitHub mutation in this planning task.
- Public record rule: this file describes already-public PR behavior and general
  integration requirements. Any new security investigation belongs in `.tmp/`.

## Provenance and current source

Live GitHub dev and local HEAD both resolve to
`81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`. Original PR
[3568](https://github.com/lidge-jun/opencodex/pull/3568) head is
`036a9321788464fdf33a387c9f44a834a844bdc1`, retained as
`refs/codex/a-original/3568`. The earlier `origin/a-original-*` refs were pruned;
do not depend on them. Read the complete feature diff using
`git diff origin/dev...refs/codex/a-original/3568`, not `HEAD^..HEAD` (the last
two commits are documentation corrections).

Original author: `voiys <matej2714@gmail.com>` (GitHub `voiys`). Preserve these
commits in order when carrying the work:

1. `e8f8726040dbc45b1e946d59db6b9c477459b8d7` — recovery implementation.
2. `4464892336c75b8861ee4caeddfd97d6c4e0e6ab` — canonical Go destination docs.
3. `036a9321788464fdf33a387c9f44a834a844bdc1` — forward-auth exception docs.

A rewritten/squashed carrying commit and final squash body must contain
`Co-authored-by: voiys <matej2714@gmail.com>`; cite the original PR in the new PR.
Do not force-push the contributor branch.

Source anchors at the inspected dev SHA:

- `src/server/responses/agent-task-recovery.ts:61`: envelope type; line 72
  accepts only NEW_TASK; line 74 selects the supported tail envelope; line 180
  injects validated plaintext; line 277 performs admission and line 287 creates
  the existing cache key, including message type and parent scope.
- `src/server/responses/agent-task-recovery-cache.ts:23`: existing deletion/byte
  accounting; line 43 sets original expiry; line 117 owns resolving cache/flight
  behavior. Reuse these owners instead of adding another cache.
- `src/server/responses/core.ts:3233`: final-route recovery gate currently also
  requires an unreadable current task. Lines 3261–3282 own reparsing, preserved
  continuation fields and the existing non-persistable-body handling.
- `src/adapters/openai-responses.ts:2354`: body expansion/previous-response
  handling before effort mapping is the original insertion point.
- `structure/10_adapter-registry.md:5`: adapter factory authority remains the
  registry. `opencode-go.ts` below is a destination helper, not a new adapter id.

Owner search used `isOpenCodeGo`, `normalizeOpenCodeGoAgentMessages`,
`recoverEncryptedAgentTask` and recovery-cache exports. No equivalent Go helper
exists in current dev. Doing nothing retains the public regression; configuration
alone cannot admit MESSAGE or restore history. Reuse admission, injection, cache
deletion and Responses construction; do not duplicate them.

## Exact implementation change map

| Action / path | Before → planned after |
|---|---|
| MODIFY `src/server/responses/agent-task-recovery.ts` | Widen `AgentEnvelope.messageType` and the local parse variable to `"NEW_TASK" \| "MESSAGE"`; ROUTING_HEADER captures either and assigns the captured value. Add `restoreCachedEncryptedAgentTasks(req,input,config,{parentThreadId})`: scan only agent_message entries, reuse `admittedRecovery` on each singleton, read the existing cache, and call `injectAssignment` only for a valid hit; return restored count. Fresh recovery continues to handle only the supported tail. |
| MODIFY `src/server/responses/agent-task-recovery-cache.ts` | Export `cachedAgentTaskRecovery(key): string \| null`; return null on miss; delete expired entries with existing `deleteRecoveryCacheEntry`; return live assignment without extending TTL, creating a flight or performing network I/O. |
| MODIFY `src/server/responses/core.ts` | Import restoration helper. Retain Responses/spawn/opt-in/final-route/combo/pass-through exclusions, remove only the outer unreadable-tail prerequisite, restore history first, recompute unreadability, and attempt fresh recovery only when still needed. Feed actual successful restoration/recovery into the existing reparse/route-selection path; preserve continuation fields and existing non-persistence handling. |
| NEW `src/adapters/opencode-go.ts` | Add `isOpenCodeGo(baseUrl)` using URL origin `https://opencode.ai` and normalized path `/zen/go/v1`; malformed/other URLs return false. Add `normalizeOpenCodeGoAgentMessages(body)` with unchanged-reference no-op; convert only nonempty agent_message content arrays entirely composed of input_text/input_image/input_file into user messages; preserve original content parts and add readable author/recipient context. No encrypted/unknown-part conversion. |
| MODIFY `src/adapters/openai-responses.ts` | Import helpers; after `stripPreviousResponseId`, apply normalization only for `!forward && isOpenCodeGo(provider.baseUrl)`, before effort mapping. Preserve raw replay body and existing session headers. |
| NEW `tests/providers/opencode-go-agent-messages.test.ts` | Carry original provider tests and add canonical-Go forward-auth, renamed-provider/trailing-slash URL, malformed/other URL and input_file/empty/mixed unknown-part cases. Assert adapter output and source-body identity, not helper existence. |
| NEW `tests/server/server-agent-task-recovery-replay.test.ts` | Carry original replay/MESSAGE/mixed-history tests. Extend real handler coverage for known history plus a fresh tail and for cache-only continued turns. Check outbound body and recovery fetch counts, not just helper return values. |
| MODIFY `tests/server/agent-task-recovery-cache.test.ts` | Exercise the new read-only accessor on hit, miss and exact expiry; assert repeated reads do not extend lifetime or create recovery flights and expiry uses existing byte-accounting deletion. Reuse existing clock isolation. |
| MODIFY `scripts/test-layout/layout.json` | Register `opencode-go-agent-messages.test.ts` under providers and `server-agent-task-recovery-replay.test.ts` under server in `explicit`. Preserve other registrations. |
| MODIFY `tests/fixtures/test-layout-expected.json` | Add the same two basename/domain mappings. |
| MODIFY `docs-site/src/content/docs/reference/adapters.md` | Carry original non-forward canonical-Go conversion paragraph and recovery link. |
| MODIFY `docs-site/src/content/docs/reference/configuration/providers.md` | Carry original Go section specifying URL, adapter, forward exclusion, cached history versus fresh-tail behavior and context-only identities. |

No DELETE paths. Existing tests/security/fallback/combo helpers are read/reused;
extend an existing test file only by a documented P amendment if its fixture is
the right home for an uncovered acceptance row. No catalog files in this layer.

The enum chain is complete: creation is ROUTING_HEADER capture in
`findEnvelope`; serialization is `recoveryPayload` at line 303 plus the existing
message-type cache-key hash at line 292; deserialization/unknown handling remains
the strict envelope matcher and assignment validation at line 171; consumers are
admission, fresh recovery, cache restoration and injection. There is no persisted
enum migration. Recipient consistency remains enforced by existing envelope
validation; do not claim a new independent recipient cache-key field.

## Activation and independent acceptance

| Trigger | Observable acceptance |
|---|---|
| Opted-in valid MESSAGE on routed spawned Responses | One recovery request containing MESSAGE; provider receives recovered text; response succeeds. NEW_TASK remains equivalent. |
| Previously admitted ciphertext replayed after tool output or user continuation | Restored plaintext reaches actual provider body; recovery-call count does not increase. |
| Cached NEW_TASK + cached MESSAGE + distinct uncached current MESSAGE | Each known entry restores its own payload; only tail creates one fresh recovery; later replay creates no further recoveries. |
| Unknown historical ciphertext and a recoverable tail | Historical entry remains unchanged; do not claim batch history recovery. Keep existing terminal decision behavior when unsupported unreadability remains. |
| Miss, exact expiry, repeated reads before expiry | No replacement/fetch on read miss; unchanged original expiry and bounded accounting. |
| Other parent/caller/account/message type, malformed envelope or unsupported type | No cache restoration; original input remains unchanged. Existing admission negative suite stays green. |
| Recovery absent/disabled, native forward, trusted pass-through, combo attempt | Existing routing/admission behavior remains; opt-out makes no newly introduced recovery request. |
| Canonical Go non-forward plaintext text/image/file message | Public user message with original parts and readable identities; raw replay input not mutated. |
| Go forward, another destination, unknown/encrypted part, empty content | No Go conversion. Test canonical Go forward directly, not only ChatGPT forward. |
| Recovery success followed by reparse | Continuation fields survive; current route/selection and existing non-persistable-body treatment remain correct. |

This layer must pass without #3581 or #3571. Main integrates this core change
before #3581 and coordinates any C-lane #3576 core edits. Do not use stack order
to invent a dependency on unrelated SSE/WebSocket changes; revalidate shared
core and documentation context after their integration.

## Reviews, drift and landing handoff

Live PR is non-draft, MERGEABLE, REVIEW_REQUIRED. GraphQL returned two resolved
threads, zero unresolved. Preserve both corrections:
[canonical destination](https://github.com/lidge-jun/opencodex/pull/3568#discussion_r3939042861)
and [forward exception](https://github.com/lidge-jun/opencodex/pull/3568#discussion_r3939864549).
The earlier four-topic maintainer review was addressed by moving catalog work to
#3571; do not restore those removed hunks. Its mixed-history concern is represented
in current original tests and the acceptance table. Sender/recipient text is
model context only. The original author reports 19,287 full-suite passes and a
live test on an equivalent local release patch; neither proves the new stack head.

At later P, compare original feature patch against the actual parent tree,
refresh PR head/reviews and identify new exact-path overlap. Carry all three
original commits, preserve authorship and review corrections, then add focused
integration corrections separately. Main may push own stack branches with
`--no-verify` as authorized. Parent merge/squash requires child replay onto the
new dev ancestry and new head evidence; retarget children before deleting parent
branches. Close carried #3568 only after dev contains the result. Reference
#3661 as partial coverage, never `Closes #3661` for this slice.

## Remote-only verification plan

Planning exception to PLAN-VERIFIER-REAL-01: user forbids running tests,
typecheck/build locally and requests static workflow inspection now. Every
command here has execution status **NOT RUN**, exit code **N/A**. Later main
records remote command, exact checkout SHA, result and log URL/receipt.

Remote execution handoff (main verified): `the isolated remote verification host` has
`REMOTE_SOURCE_CHECKOUT` and Bun 1.3.14. Main creates an isolated remote clone
and checks out the exact carried SHA; the existing checkout is a source for
setup, not a shared mutable test directory. Implementation C runs focused
activation tests and typecheck there. Carry PR remains draft until full
current-head GitHub CI is green; final landing cycle requires every full gate.
The local package pins Bun 1.4.0, so the Bun 1.3.14 focused result is supplemental
and cannot replace the workflow's configured-runtime full gates.

In that isolated remote checkout, focused C commands are:

```sh
bun test tests/server/server-agent-task-recovery-replay.test.ts tests/providers/opencode-go-agent-messages.test.ts tests/server/agent-task-recovery-cache.test.ts
bun test tests/server/agent-task-recovery.test.ts tests/server/agent-task-recovery-security.test.ts tests/server/agent-task-recovery-fallback.test.ts tests/server/agent-task-recovery-combo.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts
bun run typecheck
```

Full landing gates, on remote runners only:

```sh
bun run test
bun run privacy:scan
bun --cwd docs-site run build
```

Direct test arguments observe the named target/imports; layout guards observe
both manifests. `package.json:43` defines the full test script,
`scripts/test.ts:321` adds `./tests/`, and `tsconfig.json:15` includes `src`.
The docs build is a separate remote requirement; ordinary runtime CI does not
prove prose accuracy. Review the two docs against actual adapter conditions.

Statically verified CI coverage: `.github/workflows/ci.yml:7` has no PR-base
filter, so child PRs qualify; lines 182–186 match `src/**`, `tests/**` and
`scripts/**`. Linux line 316 calls `scripts/ci/run-bun-test-batches.sh`, whose
line 197 enumerates tests recursively and line 58 accepts `.test.ts` files.
macOS line 532 and Windows line 754 run the tests directory in shards. Lines
422–431 run typecheck and privacy. Require actual producer jobs to succeed;
green intake/aggregate checks with skipped tests are insufficient.

Main's alternative manual CI invocation is
`gh workflow run ci.yml --repo lidge-jun/opencodex --ref OWN_LAYER_BRANCH -f lane=all`.
The workflow supports lane, not an invented expected-SHA input. Capture the run's
headSha and checkout provenance and reject stale results; PR workflows normally
test the synthetic merge ref, so record both PR head and tested merge SHA.
No workflow or runner approval was issued by this planner.
