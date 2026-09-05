# 800 — Existing split-train cutoff closeout

> Latest user sequencing:830 now governs delivery. Publish and admin-merge
> the verified aggregate into dev FIRST, then run two full post-merge
> regression cycles840/850. Earlier prepublication ordering below is historical.

## Loop spec

- Archetype: satisfy-spec integration closeout; C3 refactor integration with explicit security review for affected trust boundaries.
- Trigger: the user stopped further debt-layer implementation and requested current-dev rebases, final-head-only CI, main-to-merged-dev regression checks, and delivery of recorded devlog.
- Goal: deliver the 14 already-implemented split PR contents and reviewed records without reverting newer dev behavior.
- Non-goals: implementing WP480 or other deferred layers; unrelated open PRs; main/preview promotion; releases, deployment, live-service changes, local suites, or peer-task communication.
- Verifier: per-stack range-diff/body/export/state/cycle review; pinned main and final candidate remote checks; actual final PR/merged-dev CI and ancestry. Detailed matrix:801.
- Stop: verified requested cutoff delivered and old PR dispositions accurately recorded; never claim all68 original rows were resolved.
- Memory: this800/801 pair, the new bound closeout goalplan and its ledger, and closeout-inventory.json in session evidence. Original goalplan remains unchanged except a supersession annotation.
- Expected outcomes: DONE for this cutoff only; unresolved verification or required user choices remain explicitly incomplete. No cancelled or missing check becomes PASS.
- Escalation: ambiguous consolidation authority, dirty ownership, lost source changes, semantic conflicts beyond necessary regression repair, or missing verification. Main reclaims a packet after two distinct failed workers; changing a worker scope requires a plan amendment.
- Resources: existing repository/GitHub/SSH credentials only; scoped local candidate refs/worktrees and isolated remote verification. User authorized unlimited time/tokens and gpt-6-astra high internal subagents. No numerical budget is invented.

## Pinned input and cutoff

Initial dev: `ba9a45570986aa7828508285e9a469549344dd70`.
Execution rebase pin: `bf58ef1824e7b827b2a6bc1a5effb5d36ce80180`. The
intervening Reserve and release-version changes remain part of the baseline.
In particular, preserve the new `planVisionSidecar` admission/policy options
and conditional Reserve compatibility in its moved planning leaf. The new
release-version behavior is not changed by this train.
Initial main: `48f8186647d9ffb108d226dcfa91a64225aae2a7`.
Preserve the WP480 docs-only head `ddb7013ac0c58e513c651d54a96e07f52ac0efbe` and central records head `9c0952e482b1586c0dc62d5c536698fe5578cf28`.
The original 68-file plan has17done/1in-progress/61pending work-phases; these counts are not file-resolution counts and are not rewritten as completed.
An existing native host goal cannot be replaced by the exposed create/update tools. This separate goalplan records the user-directed scope replacement; it is not a claim that a new native host goal was created or the old objective achieved.

## Publication decision — confirmed by user

The user explicitly confirmed preserving original PRs/branches, rebasing new local staging refs, and delivering the reviewed contents through one standalone aggregate PR. After verified landing, close the originals as superseded, not individually merged. Do not ask for that choice again.
The user additionally requires at least two complete main-to-dev regression PABCD cycles. Cycle1 follows810: local rebases, consolidation and first baseline/candidate regression proof, with no publication. Cycle2 follows820: an independent pinned-main export-contract guard, second regression pass and final-head-only publication/admin delivery. Two CHECK invocations or a docs-only cycle do not meet this requirement.
Local staging rebases are in progress; no external publication has occurred.
Original unfinished debt remains deferred, not completed.

## Exact inventory

| PR | Original head | Replay boundary | Staging ref |
|---|---|---|---|
| #3557 | `97df51515c22ccd610665989aa940f15bc3bca24` | `4457429662bc98279d8b321e6f75d752f77e78e8` | `codex/closeout-pr-3557` |
| #3559 | `5b253af7f3392c4af3c2177d6b66a06a8d674044` | `4dde2db97aaa7c16566ad192bf55fcbb609ab13a` | `codex/closeout-pr-3559` |
| #3566 | `58dba9e0b2209bd9f76c4d5fb4943df0d6ab710b` | `4dde2db97aaa7c16566ad192bf55fcbb609ab13a` | `codex/closeout-pr-3566` |
| #3567 | `c1d436738c5fb012b666cc15e87e777a66e7648d` | `4dde2db97aaa7c16566ad192bf55fcbb609ab13a` | `codex/closeout-pr-3567` |
| #3570 | `fdddbd3e1516997111b201a7c191fc08a6f8d4dd` | `97df51515c22ccd610665989aa940f15bc3bca24` | `codex/closeout-pr-3570` |
| #3574 | `8a404cb889abda5ab6d9cd384833e5d3c34dd873` | `24cc558d53262abde171c8228dc41d8613fa16c7` | `codex/closeout-pr-3574` |
| #3577 | `51f5a82d7c6ff3cc3a2df1a08716fa5eff1e67b1` | `24cc558d53262abde171c8228dc41d8613fa16c7` | `codex/closeout-pr-3577` |
| #3580 | `3793fb0326b8aea541918905461a8a4a0e5fcd79` | `a594a7f216f633afcedf0b44225f604b2f5f3f37` | `codex/closeout-pr-3580` |
| #3583 | `c0fab2d74b977092884ea817c274ef2f3f4021a7` | `a594a7f216f633afcedf0b44225f604b2f5f3f37` | `codex/closeout-pr-3583` |
| #3585 | `1cab08d405fc59bc5b386aa21a073f4301246ac2` | `760eddee1b0f60e3d9bf442bbc947f18c379ca5d` | `codex/closeout-pr-3585` |
| #3590 | `82e069c9fe59b9660bee7964cd58c0141687267b` | `3c920af5f7b18ecd98f87a589d21d299f5cbe172` | `codex/closeout-pr-3590` |
| #3594 | `0c914bf265ce38c57498c21ccf81f0202b9c133c` | `3c920af5f7b18ecd98f87a589d21d299f5cbe172` | `codex/closeout-pr-3594` |
| #3599 | `5c1a398da78975312c183c1c2b6e0ff8241ac02c` | `593978db019e03bcb03a862ee4e44f6356930c6a` | `codex/closeout-pr-3599` |
| #3611 | `bbf8d3cd25ccf70eb595bc7982f63528d060c1bd` | `be81013fab6d83ff630ca5f38e7881678a303871` | `codex/closeout-pr-3611` |

All local original heads matched the GitHub inventory. The13 existing associated temporary worktrees were clean; #3611 has no checked-out worktree. Recheck ownership before any write.

## Overall procedure and cycle boundary

1. Preserve original refs with immutable checkpoint refs and a manifest. Keep original branches unchanged; use staging refs rather than rewriting originals checked out elsewhere. Stay in the existing a2c0 worktree for aggregate source, FSM and receipts.
2. For each root, create its staging ref at the recorded original head in a task-owned checkout. Rebase locally with `git -c core.hooksPath=/dev/null -c rebase.updateRefs=false rebase --onto <pinned-dev> <recorded-replay-boundary> <staging-ref>`. No push.
3. Rebase #3557 first. Rebase #3570 onto the new #3557 staging tip, replaying only above original97df51515; do not replay the parent twice. All inventoried replay ranges contain no merge commits.
4. Review range-diff and source-level delta for each candidate. A dropped commit requires demonstrated prior inclusion; do not silently discard it. Preserve author metadata and any coauthor trailers.
5. Resolve conflicts by preserving current-dev behavior and the intended extraction, never blanket ours/theirs. Shared000/003 records use one reviewed final version; retain all layer-specific records and history.
6. Merge the staged results into `codex/closeout-split-train` in a2c0, parent before child. This is the actual B source delta. Record old PR/head → staged head → included aggregate ancestry/content.
7. Include reviewed public-safe accumulated devlog, including WP450 delivery/post-merge proof and the deferred WP480 plan. Do not copy .codexclaw, .tmp, secrets, or undisclosed security working material into tracked docs.
8. Freeze candidate source and documentation before publication. Transfer unpublished commits to isolated remote checkouts with a Git bundle and exact SHA verification; do not push intermediate heads merely to test them.
9. Close cycle1 only after real first-pass regression evidence. In cycle2, add the independently sourced guard specified in820, repair only demonstrated regressions, and run second-pass/final full gates with independent review. Re-check current dev before final publication and revalidate changed integration input.
10. Publish only the stabilized aggregate head, create the templated PR and observe its actual CI. Necessary corrective commits get fresh final-head checks; no workflow disabling, skip-ci camouflage, blind retries, or cancelled-check reuse.
11. After actual success and valid review closure, use admin merge with explicit expected-head matching. Verify actual merge tree equals the tested integration tree and fetch dev to prove ancestry. Observe normal final merged-dev CI; the final-head policy does not suppress this automatic run.
12. Only after delivery proof, reconcile original PRs using the confirmed disposition and record the cutoff result. Keep residual/unimplemented debt visible.

## Mandatory conflict preservation

- #3577: move current `syncRawBodyImageDescriptions` behavior into the rewrite leaf, including the already landed file-ID/empty-URL caption alignment change.
- #3580: keep current `outputToToolResultContent` reference handling in parser-content: URL precedence, file-ID fallback, malformed omission and detail normalization.
- #3583: keep current file-backed-image rejection in retained `imageBlockToInputImage`, using the one relocated AnthropicRequestError class.
- #3557/#3570: retain newer OcxProviderConfig fields and the type-contract cycle break; rebase parent before child.
- #3594: retain cooldown fields, bounds/defaults, Retry-After/reset precedence and cancellation/deletion behavior while extracting identifier helpers.
- All other stacks: preserve public exports, state/cache ownership, original assertions and each original layer's thesis. Tests do not replace static extraction review.

## Scope of source writes

- #3557: `src/adapters/cursor/desktop-executor-contract.ts`, `src/adapters/cursor/native-exec-desktop.ts`, `src/types/provider.ts`, `tests/providers/cursor/cursor-desktop-exec.test.ts`.
- #3559: `src/lib/redact-folding.ts`, `src/lib/redact.ts`, `tests/lib/redact.test.ts`.
- #3566: `src/providers/openai-tiers-destination.ts`, `src/providers/openai-tiers.ts`, `tests/adapters/openai/openai-provider-option.test.ts`.
- #3567: `src/adapters/anthropic-image-codec.ts`, `src/adapters/anthropic-image-normalize.ts`, `tests/adapters/anthropic/anthropic-image-normalize.test.ts`.
- #3570: `src/adapters/cursor/tool-definitions.ts`, `src/adapters/cursor/tool-guidance.ts`, `src/adapters/cursor/tool-naming.ts`, `src/adapters/cursor/tool-schemas.ts`, `tests/providers/cursor/cursor-tool-definitions.test.ts`.
- #3574: `src/adapters/xai-schema-analysis.ts`, `src/adapters/xai-tool-schema.ts`, `tests/providers/xai/xai-tool-schema.test.ts`.
- #3577: `src/vision/image-rewrite.ts`, `src/vision/index.ts`, `src/vision/plan.ts`, `tests/vision/vision-cache.test.ts`.
- #3580: `src/responses/parser-content.ts`, `src/responses/parser-text-format.ts`, `src/responses/parser-tools.ts`, `src/responses/parser.ts`, `tests/responses/responses-parser.test.ts`.
- #3583: `src/claude/inbound-content-options.ts`, `src/claude/inbound-model-options.ts`, `src/claude/inbound-records.ts`, `src/claude/inbound.ts`, `tests/claude-integration/claude-inbound.test.ts`.
- #3585: `src/server/system-env-shell.ts`, `src/server/system-env.ts`, `tests/server/system-env.test.ts`.
- #3590: `src/codex/prompt-layers.ts`, `src/codex/prompt-layers/encoding.ts`, `src/codex/prompt-layers/paths.ts`, `src/codex/prompt-layers/revision.ts`, `src/codex/prompt-layers/toml-edit.ts`, `src/codex/prompt-layers/toml-read.ts`, `tests/codex-integration/codex-prompt-layers.test.ts`.
- #3594: `src/combos/identifiers.ts`, `src/combos/types.ts`, `tests/codex-integration/combos.test.ts`.
- #3599: `src/codex/log-guard/inspect-schema.ts`, `src/codex/log-guard/inspect.ts`, `tests/codex-integration/codex-log-guard-inspect.test.ts`.
- #3611: `src/clients/config-export.ts`, `src/clients/config-export/constants.ts`, `src/clients/config-export/contracts.ts`, `src/clients/config-export/dsh.ts`, `src/clients/config-export/mcode.ts`, `src/clients/config-export/model-metadata.ts`, `src/clients/config-export/omp.ts`, `src/clients/config-export/zcode.ts`, `tests/config/client-config-export.test.ts`.

Public regression evidence must name tested SHAs and distinguish intended main-to-dev changes from unintended regressions. A passing finite suite is not proof that every possible behavior is unchanged.
