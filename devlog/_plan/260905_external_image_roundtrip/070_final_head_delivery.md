# Final-head CI and stack delivery

## Loop specification

- Class: C3 final delivery of the already implemented 010–060 stack. One
  work-phase, `wp-delivery`, consumes the existing roadmap; no new feature cycle.
- Archetype: spec-satisfaction repair. Trigger: owner requests completion of the
  six-layer stack despite cancelled/failing final-head checks.
- Goal: all six PRs integrated into `dev`, with exact-head CI and merge ancestry.
- Non-goals: unrelated PRs, releases, deployment, live proxy restart, new vision
  behavior, relaxed assertions, workflow-gate changes, branch/worktree deletion.
- Verification: GitHub PR/run/job APIs and logs; local `git diff --check`, ancestry
  and read-only JSON inspection. NO local tests, typecheck, builds, or test hooks.
- Stop: all criteria evidenced, devlog closeout committed, FSM closed through D.
- Memory: this unit and the session-bound `.codexclaw` goalplan/ledger.
- Tools/credentials: existing GitHub repository access, scoped PR edits, CI reruns,
  `git push --no-verify`, explicit SHA leases if rewriting, `gh pr merge --admin`.
- Bounds: this stack only; no purchases or new credentials; no token cap; four-hour
  wall-clock ceiling; at most two concurrent gpt-6-astra/high leaf reviewers.
- Escalation: main reclaims after two distinct failed audit dispatches; new write
  delegation or source repair requires a plan amendment before implementation.
  NEEDS_HUMAN for missing authority, UNSAFE for boundary expansion, BLOCKED for
  external failures after safe alternatives, BUDGET_EXHAUSTED at the stated bound.

## Recovered evidence

Existing 060 identified and fixed late-spill wall-clock and loopback-port fixture
failures. This pass does not repeat those changes. All-format dispositions live in
003, including explicit native file/remote URL/history limits; normal OpenAI user
images were already retained. No real-model OCR fix is claimed.

Snapshot on 2026-09-05: #3586 merged as `c514a32c`; #3589 head `5060ac891`,
#3591 head `7484cc56e`, #3593 head `75dc09ea8`, #3595 head `01e3cfbeb`,
#3596 head `8809175ad`. #3597 is already merged and is context, not another task.
#3589 CI run 33949975196 and #3591 run 33949974086 passed. Runs 33949974578,
33949973937 and 33949973996 show cancelled prerequisites, with the aggregate
   `ci` correctly refusing cancellation. The #3595 aggregate explicitly reports
`platform-macos=cancelled`, `keyring-smoke=cancelled`, `npm-global-smoke=cancelled`.

## Planned delta and execution

1. NEW this 070 record; MODIFY 003/000 only to record final dispositions and
   completed delivery; MOVE this owning unit to `_fin` once its source outcomes
   are public. No source/test/workflow delta is currently justified.
2. Read check-run annotations and cancelled-job logs. Re-run only failed/cancelled
   jobs at the identical SHA. If GitHub cannot rerun cancelled prerequisites as a
   group, rerun their exact jobs (plus aggregate) using the existing CLI/API.
   Do not edit cancellation handling or skip real jobs. A demonstrated new failure
   requires its exact log, target-file diff plan, appropriate review, and CI proof.
3. Read unresolved review threads and verify each against its exact layer range.
   Historical completed reviews remain evidence only when the reviewed source
   patch is unchanged. Inspect the two existing CI fixture corrections separately.
4. Refresh each PR's head/base/checks immediately before merge. Mark #3591 ready
   after valid findings are resolved. Record owner-authorized approval bypass in
   PR delivery notes. Prefer `--merge --admin --match-head-commit <sha>`; repository
   settings allow merge commits. Repository automatic branch deletion is enabled:
   retain local SHA anchors and retarget the direct child to `dev` immediately
   BEFORE parent merge so deletion cannot auto-close it; never merge that child
   until parent integration is confirmed. Do not change repository settings.
   Fresh check listings alone do not prove a new base: compare the proposed
   integration tree to the actual checkout tree recorded by passing CI. If not
   equivalent, merge current `dev` into the bottom affected layer, cascade that
   integration upward, push with `--no-verify`, and obtain CI for each new head.
   Default PR triggers do not include `edited`; old reruns preserve the old ref.
   Merge bottom-up through 3595, then PAUSE before 3596; 3586 is incorporated.
5. BEFORE the still-open #3596 is merged, add only the owning-unit closeout to
   the top branch using a fast-forward `git push --no-verify`. Work in this
   app-bound checkout on an independently named local branch; never manipulate
   the source branch checked out in another worktree. Verify new top HEAD and
   integration-tree equivalence in CI, then merge #3596. Post-merge SHA/ancestry
   receipts remain in the ignored ledger and the PR delivery comment; no claim
   that a pre-merge document contains its own future merge SHA.
6. Fetch `origin/dev`; for every merge SHA run `git merge-base --is-ancestor`.
   Record final head/run URL/merge SHA, conditional-skip reasons and no-suite
   compliance. Close tasks/criteria with CLI evidence, generate the CI receipt,
   then C→D. No local passing-suite claim is made.

## Verifier grounding and risk

`gh pr checks 3589` and `gh run view 33949973937 --json headSha,jobs,conclusion`
read this exact stack: the first observes PR checks; the second proves the
cancelled prerequisites at the stated head. The aggregate log was opened.
`git diff --check` observes only file hygiene, not runtime correctness. Ancestry
proves integration, not behavior. CI-only verification overrides skill/repository
local-test defaults per the owner's explicit restriction.

No new fields, schemas, enforcement or credential destinations are introduced.
Admin merge bypasses approval rules only as explicitly authorized; it does not
turn failing/cancelled checks into passing evidence. Source-of-truth transport
docs already travel in the existing stack; this cycle adds delivery facts only.

## A-gate synthesis

Independent gpt-6-astra/high reviewer returned GO-WITH-FIXES (two P2 blockers).
Both folded above: a retarget cannot reuse old-base CI without tree equivalence;
the closeout commit must be pushed before the top PR closes. Root cause was an
underspecified delivery sequence, not a runtime defect. No conflicting fixes.
Annotations for all three cancelled runs explicitly name owner cancellation.
Current dev has advanced beyond the tested base, so integration equivalence is
checked before choosing a rerun versus new-head cascade.
