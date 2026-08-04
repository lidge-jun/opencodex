# 010 — Reopen PR #536 and post the maintainer comment

Work phase: `wp2-reopen` · Criterion: `c2-reopen`

## Order of operations

Retarget first, reopen second. GitHub's `[WRONG BRANCH]` automation reacts to the
base branch; reopening while the base is still `main` re-triggers the wrong-branch
bot and re-drafts the PR.

```bash
gh pr edit 536 --base dev
gh pr reopen 536
gh pr view 536 --json state,baseRefName,isDraft,url
```

If the fork branch was deleted, `gh pr reopen` fails with
`Unprocessable Entity`. That is the `BLOCKED` outcome: record the exact error and
fall back to keeping the work as local `dev` commits plus a comment on the closed
PR.

The title still carries the `[WRONG BRANCH]` prefix the bot added. Strip it once
the base is `dev`:

```bash
gh pr edit 536 --title "feat(providers): add Zhipu AI GLM provider (open.bigmodel.cn)"
```

## Comment content

English, per the AGENTS.md review rules. Structure:

1. Reopening, with the base moved to `dev` on the contributor's behalf.
2. What we changed on top and why each change exists — one line per blocker,
   naming the file and the concrete failure mode, not a style verdict.
3. Why the work landed as maintainer commits: `maintainerCanModify` is `false` on
   this fork branch, so we cannot push the corrections to `feat/glm-provider`.
4. Credit: the contributor is named as the source of the idea and the original
   entry, and the commits carry `Co-authored-by`.
5. What is left for the contributor if they want to carry it themselves —
   verifying `liveModels` against a real BigModel key is the one item we cannot
   do without their credential.

Tone: this is a good idea that arrived with an unsafe id and thin metadata. The
comment should read as a maintainer finishing someone's work with them, not as a
rejection notice with a patch attached.

## Attribution in commits

Every commit in `wp3`–`wp5` ends with:

```
Co-authored-by: Lucinegogo <103441383+Lucinegogo@users.noreply.github.com>
```

Taken from `gh pr view 536 --json commits` (`authors[0].email`).

## Evidence to capture

- `gh pr view 536 --json state,baseRefName,url` showing `OPEN` + `dev`.
- The comment URL returned by `gh pr comment`.
