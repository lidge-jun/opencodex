# 020 — CREDITS.md row for #3988

Work from a **clean worktree** of `origin/dev`. Do not touch the dirty files on
the session checkout (`src/cli/dispatch.ts`, other in-progress units).

Create the delivery branch **before** editing, so 020's commit is on the branch
030 will push (reviewer blocker: branching from `origin/dev` after the commit
orphans it):

```
git fetch origin dev
git worktree add /tmp/opencodex-credits-3988 origin/dev
cd /tmp/opencodex-credits-3988
git switch -c docs/credits-3988-rrmlima
```

## Files

| Path | Op |
| --- | --- |
| `CREDITS.md` | MODIFY — insert the follow-up table below after the four-track section (after the paragraph ending "The table deliberately retains the unadopted scope.", currently around line 156) and before `## Report and diagnosis`. |

## wp2 P stale-check (after wp1 D)

Previous D: inventory frozen; unique miss #3988; `origin/dev:CREDITS.md` still
lacks `/pull/3988`. Insertion anchor on current `origin/dev` CREDITS.md is
still line 156 ("The table deliberately retains the unadopted scope.") then
blank then `## Report and diagnosis` at line 158. Work from a clean worktree;
session checkout may only have the untracked plan unit.

Do not edit CREDITS.md until B after this cycle's A.

## Insert (exact)

```markdown
### 2026-09-13 follow-up: landing trailer dropped at merge

The last 3,000 commits reachable from current `dev` were scanned the same way
as the 2026-09-07 audit: carry/reimplement language on the landing, then the
**actual landing commit**, then GitHub's commit-author mapping. One new miss
is not already on this page.

[#4031](https://github.com/lidge-jun/opencodex/pull/4031)'s own description
named the trailer. The merge commit did not keep it. The cherry-picked object
is authored as an unmapped machine identity, which GitHub maps to no account.
The only remaining trailer is automation.

| Pull request | Author | Landed as | What landed |
| --- | --- | --- | --- |
| [#3988](https://github.com/lidge-jun/opencodex/pull/3988) | [@rrmlima](https://github.com/rrmlima) | [`e2bf1672c`](https://github.com/lidge-jun/opencodex/commit/e2bf1672c974611f8db736cd64a90e1dc443924a) / [`14ce693e5`](https://github.com/lidge-jun/opencodex/commit/14ce693e5846596c823941ce90add538713a25b1) | "Carries #3988 by @rrmlima (`cherry-pick -x`)" — Gemini/CCA/Vertex/AI Studio model-tail `(continue)` nudge in `messagesToGeminiFormat`. |
```

Link targets are the full SHAs (`git rev-parse e2bf1672c` /
`git rev-parse 14ce693e5` on `origin/dev`). Table cells keep the 9-char prefix,
matching the 2026-09-07 follow-up tables. Do not publish the machine author
address; describe it as an unmapped machine identity (same masking rule as
`CREDITS.md` unlinked-trailer section).

## Commit trailers (forward attribution)

The commit that lands this docs change **must** include:

```
Co-authored-by: rrmlima <137737127+rrmlima@users.noreply.github.com>
```

Numeric-id form only. Do not copy the id-less `users.noreply.github.com`
form, and do not copy any personal address from #4031's PR body.

Suggested subject:

```
docs(credits): record the #3988 carry whose merge dropped the trailer
```

`[skip ci]` is allowed, matching merged #3811 / #3787 (docs-only credits
repairs that the operator also asked to merge without a local suite). Hosted
required checks are not the verifier for this docs row; the trailer on the
exact merge object is.

## Accept

- `rg '/pull/3988' CREDITS.md` exits 0.
- New row cites the #4031 quote, not a diff.
- `git log -1 --format=%B` contains `137737127+rrmlima@users.noreply.github.com`.
- `privacy:scan` not required locally if the file adds no new email; do not
  introduce one.
- No other files in the commit.
