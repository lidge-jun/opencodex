# 030 — wp2: origin remote branch deletion

`origin` carries 56 branches. The deletable set is the intersection of:

- not `dev`, `main`, `preview`
- not the head ref of an open pull request whose head repository is
  `lidge-jun/opencodex` (fork-hosted heads are not ours to delete and are not
  reachable as `origin` refs anyway)
- content already on `dev` by the T3 test applied to `origin/<branch>`, or the
  branch is a spent dispatch/promotion artifact

Two families dominate the remote list and need separate judgment:

- `origin/codex/win-dispatch-*` (9 refs) — CI dispatch artifacts pinned to a
  commit SHA. Spent once their run finished.
- `origin/assets/*` and `origin/media/*` — evidence assets referenced from PR
  and issue bodies by raw URL. Deleting these breaks images in published
  descriptions, so they are retained unless the referencing item is closed and
  the image is no longer rendered. Default is keep.

Deletion uses `git push --no-verify origin --delete <exact-branch>`, one ref per
command with a bounded timeout. `--no-verify` is required because the pre-push
hook runs a local suite, which is forbidden for this unit; the safety that hook
would provide is already supplied by the T1–T4 evidence and the guard sets, and
a deletion pushes no code.

## Outcome

Of 62 non-protected remote refs, only 2 were provably spent:

| Branch | Proof | Result |
|---|---|---|
| `codex/regaudit-ci-main-af6113a03` | empty vs `dev` | deleted |
| `codex/260904-logs-cost-effort-polish` | content already on `dev` (PR #3367 merged) | already gone; pruned locally |

38 hold unique unlanded work, 14 are open-PR heads, 5 are orphans, 3 protected.
The remote was already close to minimal — the sprawl was local.

## A third fail-open, caught here

The first remote pass marked all five `assets/*` branches deletable as
"content_landed". They are **orphan branches with no merge base**, so
`git diff origin/dev...origin/assets/*` exits 128 with
`fatal: ... no merge base` and prints nothing. Reading that empty stdout as
"no difference" would have deleted five evidence branches holding 36 image files
that exist nowhere else.

This is the same mistake as the zsh word-split in `010_method.md` and the
ignored return codes in `015_audit_record.md`: **empty output treated as
evidence of absence, when it was actually evidence of a failed command.** Three
occurrences in one campaign, each in code written after the previous one was
documented.

The remote classifier is now fail-closed the same way: a missing merge base
disqualifies every `dev`-relative test and the branch is preserved outright.
The five orphan asset branches are retained under `orphan_no_merge_base`.

The general lesson, now stated once for the whole unit: a test whose "safe"
answer is produced by silence must verify that the command spoke.

## Exit criteria

- `git ls-remote --heads origin` no longer lists any deleted ref.
- Every open PR's head ref still resolves on its own repository.
- Asset branches still referenced by open items remain.
