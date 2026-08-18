# 016 — Audit round r13-20260818042842: NEAR-PASS, the assertions had to become commands

`r13` did something the previous twelve rounds did not: it RAN the snippets. Four
blockers, all of the same kind — the plan described the right check in prose but did
not express it as something a shell would execute.

## What it found

1. **`VERIFIED_TIP` was captured after the gates, not before.** `020` created the
   worktree at a placeholder `<SHA>` and only named `VERIFIED_TIP` in a later
   section. If `cursor-call` moved during the ~8-minute suite, the recorded tip and
   the tested tree would differ — the exact defect `r10` closed one layer up, reopened
   inside the phase that owns it.

2. **`PR1_HEAD = <PR1_TIP>` is not an assignment.** The reviewer probed it: zsh
   exits 127 with `command not found: PR1_HEAD`, because `NAME = value` runs `NAME`
   as a command. The whole PR-head binding was a legend, not code.

3. **`040` printed `headRefOid` instead of comparing it.** A value the operator has
   to eyeball is not a gate.

4. **`PR1_TIP`/`PR2_TIP` were read by eye** and never asserted against the created
   branch tips. The ancestry and count checks prove topology, not identity.

5. **`MERGED_DEV` was a fresh mutable-ref read**, so a concurrent push after PR3
   landed would be silently attributed to this campaign while the ancestry test still
   passed.

## The fix

Every one became an executable assertion:

- `020` captures `VERIFIED_TIP` from `ls-remote` BEFORE the worktree, builds the
  worktree at that SHA, and asserts the remote HEAD equals it after checkout.
- `030` step 1 binds `PR1_TIP`/`PR2_TIP` with `git log ... | grep -F ... | cut`
  instead of "read them off that list".
- `030` step 5 uses real assignments (`PR1_HEAD=$(git rev-parse ...)`) and then
  `test "$PR1_HEAD" = "$PR1_TIP"` — the assertion that actually binds branch tips to
  the verified tree.
- `040` merges behind `test "$(gh pr view <n> --json headRefOid --jq .headRefOid)" = "$PR1_HEAD"`.
- `040` takes `MERGED_DEV` from `gh pr view <pr3> --json mergeCommit` — the merge
  itself — and separately asserts `dev` still points there, with an explicit branch
  for what to do if someone pushed after us.

Verified by running the extraction against the real tree:

    PR1_TIP=dfb6fb884df1df819aaf0d9d2ddfd07408860ea3
    PR2_TIP=6d974428396fc1cb283353142e10f07074aecc00

which are exactly the two boundary commits `030` names.

## The pattern, four rounds running

`r7`, `r8`, `r10` and now `r13` all found the same failure mode at different
altitudes: an artifact that one phase produces and another consumes, where the
binding lives in prose instead of in a command. Each document read correctly on its
own. The plan is only as strong as its seams, and a seam is only real when it is a
`test`.

