# Scan evidence (000-range research)

Window: `git log origin/dev -n 3000` after fetch. Tip recorded in
`.codexclaw/evidence/4c876c16-4cd9-4a26-bcd5-743ccaa1b137/credits-scan/window.txt`.
Default branch is `main`. Previous `CREDITS.md` follow-ups: #3318, #3787, #3811.

## Method

1. Tight regex for carry/reimplement/supersede + `#N` on commit subject/body.
2. For each source PR, `gh api repos/lidge-jun/opencodex/pulls/N` for `user.login`.
3. Inspect the **actual landing** (merge unique commits, not the PR body).
4. GitHub GraphQL `Commit.authors.nodes.user.login` — this is whether GitHub
   maps the trailer/author to an account.
5. Skip rows already in `CREDITS.md`. Skip self-carries (`lidge-jun`). Skip
   normally merged contributor PRs.

Nothing here is inferred from a diff.

## Negative results (ordinary path worked)

These titled carries are **not** new `CREDITS.md` rows:

- Sep 7 skip-ci train `#3871`–`#3892` / `#3878`: second-parent commits already
  contain `ID+login@users.noreply.github.com` trailers. GraphQL resolves
  Liang-Psych, RobinBially, x3M3x, luvs01, makesomethingshit, Ingwannu,
  hualiny, terrytan95.
- `#3921` carry `#3908`: `ankaifeng <qq.com>` GraphQL-resolves to **akf66**.
- `#4285` carry `#4078`: `Sayo <hi@sayo.wtf>` resolves to **wtfsayo**.
- `#4300` reimplements `#4293`: `Valerio Coltre <gmail>` resolves to **colthreepv**.
  `#4291` by L4XB was superseded and explicitly **not** carried ("Does not
  include #4291's fabricated text floor").
- `#3870` reimplements `#2033`: `louis-tepe` noreply on `6eadb1658`.
- `#4347` / `#4340` / `#4338`: Warexpor, david-wang-0, luvs01 resolve.
- `#3388` carry on `3f3008422`: `Maple <hzlhu@qq.com>` GraphQL-resolves to
  **zleo-ai**. Trailer present and linked; no `CREDITS.md` row.
- `#4026`/`#4027`/`#4028` carry `#3340`/`#3349`/`#3350`: unique commits are
  **authored** by Flowershangfromthebranches with numeric-id noreply.
- `#4030` carry `#3990`: unique commit authored `rrmlima <rrmlima@users.noreply.github.com>`;
  GraphQL resolves to rrmlima.
- `#4102` carry `#4081`: unique commits include `luvs01 <27862058+luvs01@users.noreply.github.com>`
  as **author**.
- `#3954` by omarjson was closed "Landed via #4136" but the maintainer comment
  says the approach **cannot land** (report/diagnosis, not carried code).

## The miss

| Source | Author | Landing | Why GitHub credit is missing |
| --- | --- | --- | --- |
| [#3988](https://github.com/lidge-jun/opencodex/pull/3988) | [@rrmlima](https://github.com/rrmlima) | `#4031` merge `e2bf1672c` (on `main`); cherry-pick `14ce693e5` | Unique commit author is an unmapped machine identity (GraphQL `user: null`). Only other trailer is `CommandCodeBot`. `#4031` **PR body** had `Co-authored-by: rrmlima <rrmlima@users.noreply.github.com>` and was dropped from the merge message. |

Maintainer words (PR #4031 Summary): "Carries #3988 by @rrmlima (`cherry-pick -x`)".
Merge subject: "fix(google): guard model-tail histories with user continue nudge across Gemini and CCA (carry #3988)".

rrmlima already has a noreply trailer on `#3787` (`24c761a05`) for earlier
uncredited landings. That does not attribute **this** cherry-pick. `CREDITS.md`
does not yet list `#3988`.
