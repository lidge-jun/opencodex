# 030 — wp3: refresh leftover inventory and merge only authorized ready items

Depends on: wp2 (#3190 on `origin/dev`).

## Fresh read, not the freeze table

At wp0 freeze the only authorized merge candidate was #3190. wp3 exists because the user asked to finish remaining ready work, not to stop after one PR. Re-run the inventory; do not reuse the freeze table as if it were live.

```
git fetch origin --prune
gh pr list --state open --limit 80 --json number,title,author,isDraft,mergeable,reviewDecision,headRefName,url
```

Then for every non-draft row:

```
gh pr view <n> --json number,title,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup,files
```

## Authorization filter (all must hold)

1. `isDraft == false`
2. `mergeable == MERGEABLE` (not CONFLICTING, not UNKNOWN-as-conflict)
3. Not `CHANGES_REQUESTED` unless this train already carries the requested change
4. Not a security-boundary diff (auth, credential, OAuth, workflow, release, dependency install) unless a named security review is already on the exact head
5. Not both of a documented pair (#2083 original and #2986 carry)
6. Not a parked item whose prior train already recorded a substantive blocker (#3061 launcher budget)

If zero rows survive, wp3 is NOOP with the live table recorded in an outcome doc, and criterion c-4 is met by that recording.

If a new row survives, land it the same way as wp2: rebase onto current `origin/dev` if behind, `--no-verify` push, exact-head CI, admin squash merge, fetch + merge-base proof. One PR per inner loop; do not batch-merge.

## Known likely leftovers after #3190

| PR | Expected live disposition | Merge now? |
| --- | --- | --- |
| #3142 | still CONFLICTING | no |
| #3061 | still CHANGES_REQUESTED + red macos | no |
| #2986 / #2083 | overlapping image-gen carry | no (pair) |
| #2877 | CHANGES_REQUESTED docs | no |
| #2805 #2783 #2527 | CONFLICTING | no |
| #2366 | CHANGES_REQUESTED contributor feature | no |
| #2734 | should already be closed by wp2 | verify |

A docs-only MERGEABLE PR with no CHANGES_REQUESTED and green hygiene (the #3114 shape) may be landed. Do not invent that it exists; the live list decides.

## Steps

1. Produce a timestamped table of every open non-draft PR with mergeable/review/CI bucket.
2. Apply the filter. Write survivors (possibly empty) into `031_wp3_outcome.md` at C, not here.
3. For each survivor, rebase / exact-head CI / admin merge / proof, serialized.
4. Re-fetch after each merge before judging the next row.
5. Switch this worktree off any deleted head branch.

## Accept

- Live inventory captured after #3190 landed.
- Every survivor that passed the filter is on `origin/dev` with merge-base proof, or the survivor list is empty and recorded.
- No conflicting, draft, or CHANGES_REQUESTED-without-carry PR was merged.
- #2083 and #2986 were not both merged.

## Activation

Trigger: the timestamped `gh pr list` output in the outcome doc is newer than the #3190 merge time. Observable: each claimed merge SHA is an ancestor of `origin/dev`. Negative: claiming c-4 from the wp0 freeze table without a second `gh pr list`.
