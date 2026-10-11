# Release Train 6 — plan (2.73.0)

Status: P (wp0 roadmap). Coordinator branch `codex/rt6-coordinator`, session 01a0ee05-d4d7-7b82-9d81-87aa50359448.
Base: `origin/dev` 73289d46ae (dev already opened at 2.73.0 by #6243; 2.72.0 was cut from the previous tip).

## Objective

Survey every open PR (55) and open issue (52, including #6244) on 2026-09-30, select what should land before
2.73.0, and land it on `dev` through pull requests in four lanes. Cutting the release itself is
out of scope. Per-item evidence is in `001_survey_ledger.md`; raw survey reports stayed in
`.tmp/rt6/` because some of them discuss unreleased security review.

## Selection (architect decisions D1-D10, accepted with amendments below)

| Lane | Item | Method | Gate |
| --- | --- | --- | --- |
| L1 provider/client | #6230 cursor code-mode denial hint | merge original fork PR | approve fork CI, exact-head green, review |
| L1 | #6236 routed `comp_hash` | merge original fork PR | same |
| L1 | #6225 Devin 429 retry advice | carry (contributor draft), `Co-authored-by` luvs01 | fresh CI on carry |
| L1 | #6242 Qwen late system message | investigate, then narrow fix PR | destination contract established, else defer |
| L2 Anthropic pool | #6204 pause/resume | merge original, **merge commit** | recorded security review, exact-head CI |
| L2 | #6207 per-account thresholds | retarget to dev after #6204, merge | re-run CI on retargeted head |
| L2 | #6203 cooldown recovery (#6197) | fix-up commits on original branch (no force-push) | 3 stale-publication fixes + regression, security review |
| L2 | #6234 combo cooldown | carry with fixes, `Co-authored-by` vadymhimself | pooled-account attribution tests |
| L2 | #6244 main hard lock never releases (new issue, found by A audit) | investigation only; owner policy question | no merge in RT6 without an owner policy decision |
| L3 transport | #6235 Claude stream reset | merge original fork PR after #6204 | fork CI, review |
| L3 | #6232 `summary:none` marker | carry, test moved to sibling file, `Co-authored-by` cshyang | file-size ratchet |
| L3 | #6200 canonical non-stream (#6162) | fix-up commits on original branch | disconnect regression, security review |
| L4 platform | #6238 Windows wrapper (#6237) | merge original fork PR | negative wrapper cases, security review |
| L4 | #6161 packaged keyring (P1 #6139) | update original branch from dev, fix-ups | fresh CI incl. packaged jobs, security review |

Issue hygiene now: close #6093 and #5679 (fixed by #6224, confirmed at
`gui/src/components/provider-workspace/ProviderSettings.tsx:525,538` and
`src/server/management/cursor-integration-routes.ts:152`).

Deferred with reasons: every other PR and issue (see ledger). Named near-misses: #6119 (junction
containment still wrong, maintainer change request on exact head), #6205 and #6076 (outstanding
maintainer change request not withdrawn), #5932 (GUI + OAuth surface, screenshot and sponsorship
missing), #4732 (perf carry, not release-critical).

## Amendments to the architect proposal

- A1 (D3): contributor drafts #6225/#6232/#6234 are carried instead of readied. The review-readiness
  gate returns contributor PRs to draft until the author ticks the checklist, so readying them for the
  author is not ours to do. Carries keep the author's commits (cherry-pick) where they apply.
- A2 (D3): fix-ups on @Ingwannu's in-repo branches are added as new commits on top of the observed
  head, and the head SHA is re-checked right before pushing; bringing a stale branch current uses a
  merge from `dev`, never a force-push. If the head moved, the worker stops and reports.
- A3 (D8, revised after reflection): #6242 is evidence-gated. The worker first ties the exact upstream
  error text to a public source and establishes how that destination treats `developer` and later
  `user` messages; only then is a narrow fix written. Otherwise #6242 stays open (011 doc).

## Build order and execution shape

wp1 prepares all four lanes in parallel (010-014): one gpt-6-sol worker per lane, each in its own git
worktree (`/tmp/ocx-rt6-l<n>`) on `codex/rt6-l<n>-*` branches from `origin/dev`. Workers push lane
branches and open carry/fix PRs, but never merge. Independent gpt-6-sol reviewers check the
security-sensitive items (#6204/#6207, #6203, #6200, #6238, #6161).

wp2 is the sequential merge train run by the coordinator. Hard order from D6:
#6204 → #6207 → #6203 → #6234; #6204 → #6235; #6232 → #6200. Preferred overall order:
#6238, L1 (#6230, #6236, #6225-carry), #6204, #6207, #6235, #6232-carry, #6203, #6234-carry,
#6200, #6161, #6242-fix. After each merge the next PR is updated from dev when it shares files and
its exact-head CI is re-read before merging.

wp9 closes out: final dev-tip Cross-platform CI (workflow_dispatch), issue closure, outcome and merge
ledger.

## Verification

Per lane focused tests are listed in the lane docs (commands taken from the architect proposal,
paths verified to exist on 73289d46ae or in the named PR diff). Every PR additionally needs
`bun run typecheck` locally and executed exact-head Cross-platform CI (`ci` aggregate success with
its test shards run, not skipped). Fork PR runs in `action_required` are approved by the coordinator
(`pull_request` workflow, `contents: read`, no secrets). Full `bun run test` is left to CI when
four concurrent worktrees make local full runs impractical; each PR's Verification section says so.

## Union risks carried from D7

- `tests/responses/openai-responses-passthrough.test.ts` is at its 4809 cap: #6232's +28 test lines
  must move to a sibling file registered in both test-layout manifests.
- `src/providers/quota.ts` (558/558) and `tests/cli/cli-account.test.ts` (2313/2313): #6203/#6207
  fixes must not add lines there.
- Shared files: `src/server/messages-native.ts` (#6204/#6235),
  `src/server/responses/passthrough-dispatch.ts` (#6204/#6200),
  `src/adapters/openai-responses/passthrough.ts` (#6232/#6200),
  `src/oauth/anthropic-routing.ts` (#6204/#6207/#6203), both test-layout manifests
  (#6204/#6207/#6203/#6200), `src/cli/capabilities.ts` (#6204/#6207; run `bun run skill:surface:check`),
  ten locale catalogs (#6207).

## Work phases and documents

| Work phase | Documents |
| --- | --- |
| wp0 roadmap (docs only) | 000_plan.md, 001_survey_ledger.md |
| wp1 lane preparation, four lanes in parallel | 010_wp1_lane_prep.md (index), 011-014 lane docs, 015 worker packets |
| wp2 sequential merge train | 020_wp2_merge_train.md; ledger 021_merge_ledger.md is written during wp2 |
| wp9 closeout | 090_wp9_closeout.md; outcome 091_outcome.md is written during wp9 |

Credit rule for every carry (AGENTS.md "Landing another author's work"): take the author's
identity from their own commits (`git log --format='%an <%ae>' <pr-commits>`); if that email is not
linked to their GitHub account, use `<id>+<login>@users.noreply.github.com` with the id from
`gh api users/<login> --jq .id`. Put `Co-authored-by: Name <email>` as a trailer in the carry commit
message AND in the PR description; the coordinator keeps the trailer in the squash commit body when
merging.


## Architect consultation record

- Architect: gpt-6-sol subagent 01a0ee12-4536-70e2-b224-4e7b02fc7ab7 (read-only, cxc-dev + cxc-dev-architecture).
- Proposal: decisions D1-D10 plus a 170-path union audit (kept in .tmp/rt6/architect-proposal.md).
  Accepted D1, D2, D4-D10; D3 amended by A1/A2.
- Reflection on the first plan revision: MISALIGNED with four gaps — (1) #6242 prescribed a rewrite
  before the destination contract was established; (2) #6161 packaged evidence underspecified;
  (3) merge gate checked only the ci aggregate, not all required checks and open P2 reviews;
  (4) no skip path for conditional items. All four are folded into 011, 014, 020 and A3 above.
