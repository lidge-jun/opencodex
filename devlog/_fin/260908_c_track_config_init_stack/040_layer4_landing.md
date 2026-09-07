# 040_layer4_landing.md — wp4: tip CI, merge, and closure

## CI suppression: mechanism, not draft status

`.github/workflows/ci.yml` triggers on `pull_request: {}` with **no draft
filter** (line 7), and the `changes` job gates expensive work on the PR's own
file list, which includes `src/**` and `tests/**`. Opening a lower-layer pull
request — draft or not — therefore starts repository CI.

The mechanism that actually satisfies "CI on the tip only" is to **open no pull
request for wp1 and wp2**. Their branches are pushed so the tip has a real
parent chain, but only `codex/c-track-init-guidance` gets a PR, based directly
on `dev` so its diff is the cumulative stack. One workflow run, one subject.

## Landing sequence

1. Push all three branches with `--no-verify`.
2. Open the tip PR only, base `dev`, with the full repository template
   (Summary, Verification, Checklist) and `Closes #3893`. Record the local
   suite as NOT RUN with the owner instruction as the reason; the Verification
   section must not imply a local green run.
3. Confirm the tip is based on the current `dev` head before CI. If `dev` has
   advanced, rebase and cascade first — CI against a stale base does not certify
   the integration tree that will actually merge.
4. Wait for CI on the tip's exact head SHA. Skipped or cancelled checks are not
   passing evidence.
5. Record the merge decision. Both current maintainers hold `admin`, and
   `MAINTAINERS.md` permits explicit maintainer integration into `dev` without a
   second approval, provided the decision and exact-head CI evidence are
   recorded and security review is kept separate. The credential-adjacent
   `atomic-write.ts` carry is the security-review subject; its independent audit
   is summarized in `010` and must be named in the merge record.
6. Merge the tip, pinning the reviewed head SHA.

## Proving the carried work landed

Ancestry alone is insufficient: `dev` can contain the merge while a conflict
resolution silently dropped a contributor hunk. Before closing anything:

- Compare each source PR's pinned patch against the tip tree, documenting the
  one intentional adaptation (wp2 rewrites the `openSync` line that #3896's
  hunk sits next to).
- After the merge, compare the landed tree on fetched `dev` against the
  reviewed tip tree.
- Re-read the landed commit's trailers to confirm both `Co-authored-by` entries
  survived the squash.

A squash landing does not make the original contributor SHAs ancestors, so
trailer and content comparison are the credit and delivery evidence.

## Closure

1. Close #3900 and #3896 as landed through the tip, naming the merge commit and
   crediting @x3M3x and @parkjs101 with the evidence above.
2. Close issue #3893: PRs here target `dev`, and GitHub only auto-closes linked
   issues on the default branch.

## Failure handling

If the tip's CI fails, fix the responsible layer and cascade the rebase upward
(`DEV-STACK-02`) before re-running CI on the new tip head. Do not open or merge
a lower layer independently to bypass a red tip.
