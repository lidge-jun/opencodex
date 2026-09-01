# 011 — bd1 Batch A landing record

## Merged

| PR | Merge SHA | Note |
|---|---|---|
| #3174 gui mobile overflow | `e582aee214eec70f36be3062708bd1fddcf44807` | maintainer-authored, screenshots present |
| #3176 wrapped quota rotation | `2e2da87b512bde90a33c53d60d16550b885b9bc5` | credential path — review recorded in 010 |
| #3177 413 context overflow | `0d6424f80d0a6c28d2abc4816029944c5dade61f` | draft cleared first; closes #3170 |
| #3178 Hermes vision (carry of #3151) | `51c49177f59238d9e860895ffd76100c293ee4ff` | rebase service |

All four proven ancestors of `origin/dev` with `git merge-base --is-ancestor`.

## Rebase service, first use

#3151 sat 105 commits behind `dev`. Its single commit `5ced04dc0` cherry-picked onto
current `dev` cleanly (one auto-merge in `structure/09_client-integrations.md`), author
credit preserved — `git show --stat` reports the same 7 files, +97/-13 as the original.
Focused suites: 100 pass, 0 fail across 5 export/CLI/management files.

#3151 closed `landed-via-maintainer` naming the carry and the merge SHA, with the reason
for the carry and confirmation that the author's read of the red CI was correct.

## Issues closed

- **#3170** via #3177 — streaming 413 becomes one terminal `context_length_exceeded`.
- **#3146** via #3178 — Hermes export emits per-model capabilities.

## Count

Bug-labelled items: **24 → 19** (10 PRs + 9 issues).

