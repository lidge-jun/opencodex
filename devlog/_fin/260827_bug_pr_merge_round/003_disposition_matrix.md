# Disposition matrix — all 12 PRs

| PR | title | lane | reason |
|---|---|---|---|
| #2672 | normalize canonical forward prompt envelope | **L1** | maintainer-authored, full CI matrix green, destination-scoped, manifest version bumped, docs updated. Merge first — it is the base of #2674. |
| #2674 | normalize Posit tool continuations | **L1** | stacked child of #2672, full CI matrix green. Merge second, retarget to dev after the parent lands. |
| #2671 | Muse Spark image input on OpenCode Go | **L1** | five-line registry declaration on an existing mechanism, four focused tests, CodeRabbit clean, review recommends merge. Add the reviewer's requested test (live row advertises `["text"]`, config still wins) before merging. |
| #2693 | Gemini 3 thought-signature fallback | **L4** | 15 lines, test-only — and the test FAILS on its own branch because the implementation was never written (see 004). Needs an upstream fact before it can be implemented or closed. |
| #2684 | Azure Model Router function schemas | **L1** | 92 lines, self-contained, host-scoped to Azure endpoints, reuses the existing Zen flattening helper, ships a negative test proving non-Azure targets are untouched. Fix the label/enforce-target hygiene, then merge. |
| #2639 | backfill status and created_at | **L3** | `status` half is correct; `created_at` breaks `tests/server-combo-failover-e2e.test.ts:1323` (proven, see 002). Cherry-pick `status`, hold `created_at`. |
| #2647 | Command Code reasoning presets | **L3** | content is three table rows and is fine, but the branch conflicts with dev on `src/providers/command-code-efforts.ts` and its test rewrites a catalog snapshot count 51 -> 60 that must be re-verified live. Re-apply the rows on a dev-based branch. |
| #2690 | normalize xAI Responses root tool schemas | **L4** | 926/289 across 8 files. Reclassified from L3 at audit round 2: the fix imports the extracted module, so "fix minus refactor" is incoherent (007, finding 9). It also conflicts with the now-merged #2684 on `openai-chat.ts`. Either rebase and land whole, or reimplement against the existing helper. |
| #2663 | bridge code-mode helpers through exec | **L2** | 528/68 across 12 files with substantive tests, CI green, compiles. Too broad to merge as a single review-required commit on its own head; land squashed with a written summary and close. Sequence before #2694. |
| #2694 | SenseNova bare exec_command wrapper | **L4** | does not compile: 5 tsc errors, one call to a function that does not exist (see 001). Gate keys on a provider id absent from the registry. Reimplement minimally after #2663, or close as NOOP if #2663 subsumes it. |
| #2638 | close drain routing follow-ups | **L4** | 1341/119 across 7 files, hygiene FAIL, enforce-target FAIL, CHANGES_REQUESTED. Touches `src/server/responses/core.ts` and subagent fallback — shared runtime. Rewrite the actual routing fix minimally. |
| #2497 | native main token refresh and replay | **L4** | 2622/76 across 20 files, CONFLICTING on 5 files including `src/server/responses/core.ts`, hygiene FAIL. Touches OAuth token refresh = credential boundary, so it needs explicit security review per MAINTAINERS.md before any rewrite lands. |

## Order

L1 first (#2672 -> #2674 -> #2671 -> #2684): each is small, green, and independent of
the others except the declared stack.

L3 second (#2639 -> #2647 -> #2690): each needs a dev-based branch and a decision
about which part travels.

L2 third (#2663): large but healthy; landing it changes the answer for #2694.

L4 last (#2693 -> #2694 -> #2638 -> #2497): each is a rewrite. #2693 is blocked on an
upstream provider fact and #2497 additionally needs a human security decision.
