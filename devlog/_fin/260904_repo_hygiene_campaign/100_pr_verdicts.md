# 100 — Per-PR verdicts

Full classification of the 53 pull requests open when the campaign started.
Method: fetch each PR head, take the files it touches
(`git diff --name-only origin/dev...<head>`), then compare those exact paths
two-dot against `origin/dev`. Remaining differences mean the work has not
landed.

## Closed

| PR | Author | Verdict | Evidence |
|---|---|---|---|
| #3312 | @RHODIZSECURITY | SUPERSEDED by #3348 | same 30 src/test files; the 9 that differ are v4 refinements, including a cooldown key moved off a positional pool id onto the key itself |

## Landed during the campaign

| PR | Verdict | Evidence |
|---|---|---|
| #3367 | merged | 24 files touched, 0 remaining; merged as `664d80c76` while the campaign ran |
| #2877 | 3 of 4 files landed | only `090_closeout.md` of the 260829 devlog unit still differs |

## Not superseded — measured, not assumed

Every remaining contributor PR was measured at **0% landed**. A sample, with
files touched and files still differing from `dev`:

| PR | Author | Touched | Still differ |
|---|---|---|---|
| #1645 | @waw4303 | 68 | 68 |
| #2462 | @kwannz | 95 | 95 |
| #2113 | @cb8010d6 | 65 | 65 |
| #2881 | @wonny-log | 51 | 51 |
| #2562 | @roy6732856 | 46 | 46 |
| #2351 | @harryzhou2000 | 41 | 41 |
| #3025 | @randomix777 | 37 | 37 |
| #2921 | @Warexpor | 36 | 36 |
| #2956 | @Manson2438 | 34 | 34 |
| #2230 | @ppvia | 33 | 33 |
| #3349 / #3350 | @Flowershangfromthebranches | 30 / 30 | 30 / 30 |
| #3252 | @x3M3x | 24 | 24 |
| #2527 | @harryzhou2000 | 19 | 19 |
| #2213 | @louis-tepe | 18 | 18 |
| #2280 | @cristph | 17 | 17 |
| #2716 | @zigzag-007 | 17 | 17 |
| #3329 | @Veritas-7 | 17 | 17 |
| #3340 | @Flowershangfromthebranches | 17 | 17 |
| #3251 | @abhisheksharma2411 | 12 | 12 |
| #3283 | @vanch007 | 12 | 12 |

…and the remainder identically. Full output: `.tmp/hygiene/pr-landing2.txt`.

## Overlap pairs that are not duplicates

35 PR pairs share ≥30% of their files. Two benign causes:

- **Declared stacks.** #3340 → #3349 → #3350, #3364 → #3365, #3369 → #3370. Each
  child states its parent and names its own unique commit. `enforce-target`
  explicitly supports this workflow.
- **Shared surface.** Ten GUI PRs co-edit `gui/src/pages/Models.tsx` and the
  i18n bundles because that is where GUI work lives.

Closing either class as duplicates would have been wrong, which is why file
overlap was used only to generate candidates and never as evidence.
