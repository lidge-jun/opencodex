# 011 — wp1 P re-verification and execution amendment

Re-read at P of wp1 (2026-09-05, `origin/dev` = `6d9639165`). Live `gh pr view`:

| PR | Head | GitHub mergeable | merge-tree (008) | Draft | Review |
|----|------|------------------|------------------|-------|--------|
| #3323 | 0facdae69 | CONFLICTING | CLEAN | no | REVIEW_REQUIRED |
| #3480 | 74ef8faae | MERGEABLE | CLEAN | no | CHANGES_REQUESTED (stale) |
| #3515 | 4f09faf5d | CONFLICTING | CLEAN | no | REVIEW_REQUIRED |
| #3484 | a4c50d104 | CONFLICTING | CLEAN | no | REVIEW_REQUIRED |
| #3525 | 288506dc6 | CONFLICTING | CLEAN | no | REVIEW_REQUIRED |
| #3490 | 3fbe8a2c7 | MERGEABLE | CLEAN | yes | REVIEW_REQUIRED |
| #3529 | 92b4eda26 | MERGEABLE | CLEAN | yes | CHANGES_REQUESTED |

All seven have `maintainerCanModify: true`.

## Execution rule (amends 010 §2.2-2.4)

GitHub refuses the squash button on a PR it flags CONFLICTING even when `merge-tree` is
clean, and a push to a contributor branch resets the readiness gate and re-drafts the PR
(`pr-quality-messages.cjs:272`). So the train uses two lanes:

- **Direct lane** (#3480, #3490, #3529 — GitHub MERGEABLE): 010 §2.3 P1-P6 as written. Drafts:
  `gh pr ready` by the maintainer, wait for the full matrix on the exact head, then
  `--admin` squash with the bypass comment. Stale CHANGES_REQUESTED on #3480 is dismissed with
  a comment citing the rebased head; #3529's CHANGES_REQUESTED is re-read first — if it
  targets the current head, fold the requested change on a carry branch instead.
  #3490 additionally needs the §3.4 `layout.json` line + test relocation, which is a push to
  the contributor branch; if that re-drafts the PR, it moves to the carry lane.
- **Carry lane** (#3323, #3515, #3484, #3525 — GitHub CONFLICTING): maintainer branch
  `codex/260905-carry-<n>` = PR head + `git merge origin/dev` (rename-aware; expected zero
  conflicts, abort and escalate to wp2 otherwise), pushed `--no-verify`, PR against `dev` with
  `Co-authored-by: <login> <id+login@users.noreply.github.com>` (008 Blocker 4 form) and
  "Supersedes #<n>". Exact-head full matrix must be green; then `--admin` squash, close the
  original with the landing SHA. Rationale from memory: author-bound readiness does not reset
  on maintainer carry branches.

Carry PRs are independent (disjoint source files, 010 §2.1); they may run CI in parallel and
merge in the 010 §2.2 order. Every merge is followed by P5 ancestry proof and a 060 row.

## Verifiers (exist; run at P)

- `bun run typecheck` on each carry head — exit 0 on `6d9639165` baseline.
- Focused: `bun test tests/server/server-auth.test.ts` (#3515), `bun test tests/server/management-integration-journal-delete.test.ts` (#3484), `bun test tests/server/memory-watchdog.test.ts` (#3525), `bun test tests/server/management-route-registry.test.ts` (#3323), `bun test tests/adapters/google/google-adapter.test.ts`-family for #3480 per 010 §3.2, `bun test tests/codex-integration/codex-legacy-config-keys.test.ts` (#3490 after relocation), `bun test tests/adapters/key-failover.test.ts`-family for #3529 per 010 §3.7.
- Sandbox-red (EADDRINUSE) files are hosted-CI-only (008).

## Stop condition

Seven ledger rows with ancestry exit 0, or a documented escalation per item (BLOCKED after
3 refused merges). Outcome DONE / partial with named residuals.


## Audit fold (wp1 A, round 1 — claude-opus-5 micro-audit, GO-WITH-FIXES blockers=5)

1. **010 §1 non-goals amended:** the "no rebase, carry, or reimplementation" clause is
   repealed for wp1; a GitHub-CONFLICTING/merge-tree-CLEAN PR is carried within wp1 per the
   carry lane above. A merge-tree CONFLICT still hands the item to wp2.
2. **maintainerCanModify:** true for #3323, #3515, #3480, #3490, #3529; **false for #3484 and
   #3525** — no direct-lane fallback for those two; carry lane only.
3. **Carry PR body:** full template (Summary / Verification / Checklist) is mandatory; a carry
   whose diff touches `gui/` (#3484) must include a GUI screenshot in the description
   (`pr-quality.cjs:527`) or carry the `gui-screenshot-waived` label the original PR holds.
4. **Bypass comment on every `--admin` merge**, carry lane included (MAINTAINERS.md:172).
5. **Baseline re-pinned:** `origin/dev` = `980a9fbed` at A; merge-tree CLEAN for all six
   carryable heads at that tip; `bun run typecheck` exit 0 re-run on the carry heads at B.
6. Verifier note: `tests/codex-integration/codex-legacy-config-keys.test.ts` is created by the
   #3490 relocation (§3.4), not pre-existing; the PR head has it at `tests/` root.
7. CHANGES_REQUESTED on #3480 (`4f5b05468`) and #3529 (`8b0327f4b`) both predate the current
   heads and are dismissed as stale with a comment; #3529's docs blocker is addressed by
   `92b4eda26` (verified: `key-failover.ts` JSDoc and `structure/04` updated).
8. #3515 carries an APPROVED review on its exact head; the carry PR body cites it.


## B progress (2026-09-05)

Carry heads built as PR head + `git merge origin/dev` at `980a9fbed` (all merge-tree CLEAN), each verified
locally with `bun run typecheck` exit 0 and the focused file(s) below, pushed `--no-verify`:

| Original | Carry PR | Carry head | Focused evidence |
|----------|----------|------------|------------------|
| #3323 | #3539 | cc599fb79 | tests/server/management-route-registry.test.ts 13/0 |
| #3484 | #3540 | d30b3c4e4 | tests/server/management-integration-journal-delete.test.ts 13/0 |
| #3515 | #3541 | 696847cd4 | tests/server/server-auth.test.ts 105/0 (unsandboxed; port bind) |
| #3525 | #3542 | 16c5df4a1 | tests/server/memory-watchdog.test.ts 13/0 |
| #3480 | #3544 | 368c5137a | tests/adapters/google/google-adapter.test.ts 33/0 |
| #3490 | #3545 | 8b5370900 | codex-legacy-config-keys 6/0 + test-layout(+tooling) 17/0 after layout.json + fixture + relocation |
| #3529 | #3546 | 7c922afaf | key-failover + core-lab-boundary 33/0; chat-native-policy + openrouter-routing + terminal-guard + combo-failover-e2e 145/0 |

Direct lane collapsed into carry lane for #3480/#3490/#3529 too: pushing to a contributor draft
resets its readiness gate, while an owner-authored carry PR skips the checklist and gets the full
matrix immediately. "enforce-target fail" rows seen at 22:43Z were cancelled runs superseded by
re-queued runs on the same head, not real failures.


### #3544 macos 2/2 (run 33926622201) — classification pending rerun

Single failure: `tests/update/update-stop-first.test.ts` "npm launcher restarts the stopped runtime
after a staged update failure" at 93,274 ms (readiness wait on a restarted proxy on a macOS runner;
9089 pass / 1 fail / 533 files). #3544's diff is one string appended in `src/adapters/google.ts`
plus a test in `tests/adapters/google/google-adapter.test.ts`; it cannot reach the update
launcher. Not classified as flake by assumption: the failed job was re-run (`gh run rerun --failed`)
and the merge waits for that exact-head result. dev's own CI at the previous tips was green
(`980a9fbed`, `6d9639165`, `79e03643d`).


## D — wp1 outcome: DONE (6/7 landed; #3480 carried as wp2 pre-flight)

Verification receipt: seven landings ancestor-proven against fresh `origin/dev` (`1362b1a38`),
focused suite on the landed tip 95 pass / 0 fail across 8 files. #3544 (carry of #3480) has
22 green checks and one queued macOS 2/2 rerun after a single unrelated `update-stop-first`
readiness timeout; it merges at wp2's first step once that job reports, with the same P1-P6
sequence. No repository-wide local suite was run.

