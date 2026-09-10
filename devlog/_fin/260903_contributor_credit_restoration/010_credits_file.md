# 010 — wp1: `CREDITS.md`

## Slice

NEW `CREDITS.md` at the repository root. MODIFY `README.md` and
`CONTRIBUTING.md` to link it.

## Why a file and not a history rewrite

See `000_plan.md`. Short version: the commits are inside published tags and
behind force-push rulesets, and `MAINTAINERS.md:26` already forbids rewriting
authorship in history.

## Row selection rule

A row exists only where the maintainer's own words — in the closure comment or
the landing commit body — state what the contributor supplied. Every row's
"what landed" cell is a quotation or a close paraphrase of that sentence, never
an inference from the diff.

Two grades, kept in separate tables because collapsing them would misreport
both:

- **Carried** — code, design, or tests were taken.
- **Report and diagnosis** — the fix exists because of the report, and the
  branch's own approach was explicitly not the vehicle. These contributors were
  told exactly why. The record should say the same thing.

## Table 1 — carried work

| Original PR | Author | Landed as | What landed |
|---|---|---|---|
| #1801 | @jonathanli12 | `cb48c2e11` | "carries all three of its unique tests"; the code-mode contract and its tests |
| #2123 | @chilung-cgu | `ef7b3c9cf` | "Your account loop and the reuse of `getTokenForAccountQuotaProbe` are what shipped" |
| #2655 | @TooSpace | `607042b02` | "re-implemented on current `dev` from your design" |
| #2693 | @yxr1995-maker | `d829215af`, `bdc1e97bb` | "carries your fix forward with the three review blockers closed" |
| #2734 | @TooSpace | `88c427522` | "That carry keeps the adaptive effort-mode design" |
| #2744 | @yxr1995-maker | `8877df0ee` | "The landed version reimplements that narrowly on current `dev`" |
| #2796 | @rrmlima | `bb3321ca8` | "Reimplements #2796 by @rrmlima" |
| #2797 | @rrmlima | `5734a1caf` | "Reimplements #2797 by @rrmlima" |
| #2812 | @gaoran1209 | `c986d1d20` | "Reimplements #2812 by @gaoran1209 with the maintainer's blocker addressed" |
| #2867 | @Ingwannu | `8d1dc1f5d` | "That landed change includes this PR's strict LoadState parsing" |
| #2870 | @luvs01 | `de91dfde4` | "the coalescing design here is right, and it is carried forward in #2872" |
| #2884 | @chilung-cgu | `eb52973c5` | "Completes contributor PR #2884"; the exact-name approach carried as-is |
| #3000 | @MarcTCruz | `fecb77a91` | "Your central insight": the refresh lock and the file it protects live under different homes |
| #3039 | @ntdatt812 | `b14b741dc` | "keeps your production logic exactly as written — the Windows budget, the `waited` guard, and the grace probe" |
| #3041 | @ntdatt812 | `b46164e78` | "carries your three merge-loop tests … they came from this PR" |
| #3067 | @ntdatt812 | `b14b741dc` | "keeps your diagnosis and your relocation", with the remedy narrowed |
| #3078 | @Veritas-7 | `0ef04e640` | "reimplements both of your production hunks on `dev`" |
| #3142 | @olddonkey | `52d941640` | "That carry keeps the measurement/refusal work and ships the guard default-off" |
| #3300 | @S0RYUASUKA | `15b43e51c` | the same two files made hermetic, landed through #3301 |

## Table 2 — report and diagnosis

| Original PR | Author | Fix landed as | Maintainer's words |
|---|---|---|---|
| #2925 | @ncepuee | `1d9b389c1` | "Credit to @ncepuee, whose #2925 identified this and argued the split" |
| #3006 | @Ingwannu | `870a2adb6` | "your PR correctly identified the broken invariant and verified the target was unused" |
| #3038 | @L-Y-J | `e9d198a3c` | "the defect is real and #3107 exists because you found it" |
| #3040 | @ntdatt812 | `330470e74` | "The defect you found is real"; the branch's remedy was the wrong direction |
| #3117 | @olddonkey | `b46164e78` | "Thank you for the focused report and tests" |
| #3143 | @Ingwannu | `408652698` | "The diagnosis here was yours and it was right" |
| #3223 | @alex-jordan547 | `d23eab43a` | "The report itself was what made the fix quick; the wire capture pointed straight at the cause" |

## Deliberately not tabulated

#3020 (@luvs01) and #2675 (@Ingwannu) were closed with "Landed via #3119" and
"Landed via #2677" and nothing further. The landing is recorded, the carry is
not stated, and inventing one would be exactly the inaccuracy this file exists
to correct. They are named in a closing paragraph instead of a table row.

## File shape

```
# Credits
  <why this file exists — the trailer, not the prose, is what tools read>
  <what it is not: not a substitute for git history, not a contributor list>
## Carried work            -> Table 1
## Report and diagnosis    -> Table 2
## Also closed as landed   -> the two above
## How this is maintained  -> pointer to the hygiene gate
```

## Link edits

`README.md` — MODIFY. Its contributing block gains one line pointing at
`CREDITS.md`.

`CONTRIBUTING.md` — MODIFY. The top bullet list already names `MAINTAINERS.md`,
`structure/`, and `docs/`; add `CREDITS.md` beside them.

## Verification

```bash
for sha in <every sha in both tables>; do
  git merge-base --is-ancestor "$sha" origin/dev || echo "NOT AN ANCESTOR: $sha"
done
```

Silence is the pass. The check is real: it caught `d975feaa4` being quoted from
a stale scan during drafting.
