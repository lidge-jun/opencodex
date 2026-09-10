# 010 — wp2 FIX lane: #2747 and #2740

Both are correct code sitting on a stale base. Neither needs a logic change; both
need a rebase I am now authorized to push.

## #2747 — reap the recovery proxy instead of trusting `stop`

Head `07b975873`, **already approved by me**, 39 behind, merge CLEAN, tsc OK,
15/0 on its own suite on the merged tree. Fork `olddonkey/fix/update-recovery-orphan-cleanup`,
`maintainerCanModify: true`.

Its `ci`/`macos` red is the pre-#2766 `release version line` failure, and a rerun
cannot clear it because a rerun replays the same commit.

ACTION: rebase `pr2747-r3` onto `origin/dev`, force-push to the fork branch, let CI
run at the new head, merge when green.

**Fork-push discipline.** The previous round declined this; the user has now
authorized it. The A-gate reviewer demolished an earlier draft of this section, and
it was right: the draft said "verify `git diff` between old and new head touches
nothing but the rebase", and that check is actively misleading. A two-dot
`git diff OLD NEW` after a 39-commit rebase reports the entire intervening `dev`
range — **70 files** on #2747's real rebase — so an executor following it either
panics at 70 files or waves through a genuine rewrite. Use checks that are invariant
under rebase:

```bash
# 1. the patch itself is unchanged
git diff-tree -p OLD~1..OLD | git patch-id --stable
git diff-tree -p NEW~1..NEW | git patch-id --stable    # must match

# 2. commit-for-commit correspondence — no drops, no reorders
git range-diff origin/dev...NEW OLD_BASE...OLD          # every row reads "="

# 3. the PR's own file set — three-dot, not two-dot
git diff --name-only origin/dev...NEW

# 4. never overwrite a concurrent author push
git push --force-with-lease=refs/heads/<branch>:<author's last OID> \
  https://github.com/<AUTHOR>/opencodex.git NEW:refs/heads/<branch>
```

On #2747 these read: patch-id `efa23210f341` both sides, `range-diff` `1: = 1:`,
three-dot name list `tests/update-stop-first.test.ts` alone.

Two further rules absent from the first draft:

- **Push to the fork, never to `origin`.** Destination is
  `https://github.com/<author>/opencodex.git`. The previous round created a stray
  same-named branch on `origin` and had to delete it.
- **Stop if the live head is already on current `dev`.** Re-rebasing a stale local
  ref rewrites a branch that is already correct. Check
  `gh pr view <n> --json headRefOid` first.

**A force-push resets the readiness checklist.** `enforce-target` returns a
contributor PR to draft and unticks all four boxes on new commits — by design, since
an attestation about the old commit cannot cover a new one. So a rebase does not end
at "let CI run": the PR is a draft again, and drafts here start only
`enforce-target`/`hygiene`/`label`/`resolve-pr`/CodeRabbit, none of which compile or
test. Two boxes ("on the latest dev commit", "resolved all Codex and CodeRabbit
findings") become objectively true and can be evidenced; the local-CI attestation
and the ready-for-review confirmation belong to the author. **Ask — do not tick
another contributor's attestation.**

## #2740 — atomically commit cleanup run metadata

Head `f07ee36f2`, draft, 39 behind, merge CLEAN, tsc OK, 2/0 on the merged tree.
Fork `luvs01/fix/storage-policy-metadata-race`, `maintainerCanModify: true`.

Mutation oracle already proven in the previous round: revert only
`src/storage/policy.ts` + `src/storage/policy-job.ts` and the race test goes 0 pass /
2 fail. The test drives the interleave through
`setPersistedConfigMutationBeforeCommitForTests`, so it is deterministic rather than
timing-dependent — it will not become a flake later.

It has only 5 checks, none of which compile or test. The merged-tree run is its first
real evidence.

ACTION: rebase onto `origin/dev`, force-push under lease, then ask the author to
complete the readiness checklist so the full matrix runs. Merge when green **and** a
non-author approval exists — `luvs01` is the author, so mine qualifies.

Recording a judgement the reviewer flagged as unstated: this PR writes through
`mutatePersistedConfig` into `config.json`, the file that holds API keys. It is not
a credential surface — it changes *how* a metadata write commits, not what is
stored, and its whole purpose is to stop clobbering concurrent edits. But "adjacent
to the file holding the keys" deserves an explicit call rather than an assumed one.

## Ordering

Independent — `tests/update-stop-first.test.ts` vs `src/storage/*`. No pairwise
merge-tree needed. Land #2747 first (already approved), then #2740.

## TESTS

- #2747: `tests/update-stop-first.test.ts` (the PR is the test).
- #2740: `tests/storage-policy-config-race.test.ts`.

## Verification (C)

```bash
bun x tsc --noEmit
bun test tests/update-stop-first.test.ts          # expect 15/0
bun test tests/storage-policy-config-race.test.ts # expect 2/0
```

Plus exact-head CI green after each rebase, and for #2740 the mutation oracle
re-run on the rebased tree rather than the remembered one.
