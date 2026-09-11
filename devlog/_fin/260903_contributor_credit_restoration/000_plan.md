# 000 — contributor_credit_restoration: Plan

> DIFFLEVEL-ROADMAP-01: exact paths, NEW/MODIFY, before/after shapes, written
> before P -> A.

## Objective

Restore contributor attribution that git history cannot carry, and make the
omission mechanically impossible to repeat.

Three deliverables, each its own PABCD work-phase after this roadmap cycle:

1. `CREDITS.md` — a durable attribution record in the tree.
2. A hygiene gate plus an `AGENTS.md` rule so a future carry cannot merge
   without naming the author it carried.
3. Credit sections appended to the affected GitHub release bodies.

## The defect

When a maintainer reimplements, carries, or rebases a contributor's pull
request, the landing commit is authored by the maintainer. The contributor's
name survives only if a `Co-authored-by` trailer names them — that trailer is
what GitHub reads for the contributor graph, the repository's contributor list,
and the author's own profile activity.

Some landings carry it. Others state the debt in prose and omit the trailer:

```
  53c09a247  "Clean reimplementation of #3193"   Co-authored-by: alan7629 ...   ✓
  5734a1caf  "Reimplements #2797 by @rrmlima."   (no contributor trailer)       ✗
```

Both sentences are equally sincere. Only the first is data. The second is a
string in a commit body that no tool reads, which is why the omission was
invisible until someone went looking.

## Evidence base (captured 2026-09-03)

Two independent scans, both re-runnable:

- **Commit-side.** Every `origin/dev` commit whose body matches
  `reimplement|supersede|carry of|rebase of|adopts the design from` followed by
  `#N`, joined against its own `Co-authored-by` trailers. 23 commits matched;
  12 name an author in prose whose trailer is absent.
- **PR-side.** All 674 closed-unmerged pull requests, narrowed to the 119
  authored by someone other than the maintainer since #2400. Maintainer closure
  comments were parsed for a landing reference (`landed via #N`,
  `superseded by #N`, `closing in favor of #N`); each landing PR's merge commit
  was then checked for a trailer naming the original author, matched on the
  GitHub login, the git author name, and the git author email taken from the
  original PR's own commits.

The two scans overlap and disagree in useful ways, which is why both are kept.
Three PR-side hits were false positives cleared by walking the merge range
rather than the squash commit (#2989, #2828, #2638 — luvs01's commits are
inside those merges). Eleven more were cleared once the login-to-git-identity
mapping was applied (`terrytan95` is `Terry Tan`, `ntdatt812` is
`Nguyen Thanh Dat`, and so on).

After both passes, 27 landing commits carry an uncredited origin.

## Why git history is not the repair

`dev`, `main`, and `preview` each carry an active GitHub ruleset that blocks
force-push (rulesets 20763889 / 20764415 / 20764486). Every affected commit but
one is already an ancestor of `origin/main` and sits inside a published release
tag — `v2.23.0` through `v2.40.0`. Adding a trailer means rewriting those
commits, which invalidates the tags, the npm `gitHead` values, and every clone.

`MAINTAINERS.md:26` already states the principle in the other direction:
authorship credit in git history is not rewritten. The repair therefore goes
*forward* — into files, gates, and release bodies, all of which are mutable.

## Evidence grading

Not every closed PR earns a row, and the difference is not a judgment call — it
is what the maintainer's own closure comment says. Two grades:

- **Carried** — the comment or commit states the contributor's code, design, or
  tests were taken. "keeps your production logic exactly as written",
  "reimplements both of your production hunks", "re-implemented on current dev
  from your design", "carries all three of its unique tests".
- **Diagnosed** — the fix exists because of the report, but the branch's
  approach was explicitly rejected. "#3107 exists because you found it" while
  the comment then explains why that layer was wrong.

Both belong in `CREDITS.md`; they do not belong in the same column. Recording a
rejected approach as carried code would be its own inaccuracy, and the
contributors who were told plainly why their patch was not the vehicle deserve
the record to say what actually happened.

A third class is excluded: PRs closed as duplicates where nothing of the
contributor's was taken and the report itself was not the trigger.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp0 | `000_plan.md` | This roadmap | — |
| wp1 | `010_credits_file.md` | `CREDITS.md` + README/CONTRIBUTING links | wp0 |
| wp2 | `020_hygiene_gate.md` | `AGENTS.md` rule + deterministic co-author gate | wp0 |
| wp3 | `030_release_notes.md` | Credit sections on the affected releases | wp1 |

wp3 depends on wp1 because the release sections link to `CREDITS.md` and must
not name a row that the file does not carry.

## Loop-spec

- Write scope: `CREDITS.md`, `README.md`, `CONTRIBUTING.md`, `AGENTS.md`,
  `.github/scripts/`, `devlog/_plan/260903_contributor_credit_restoration`.
- Out of scope: rewriting git history, force-pushing, retagging, re-releasing,
  `src/` and `gui/` runtime changes, reopening closed issues, and DMing
  contributors.
- Verification: focused `node --test` on the changed `.cjs` test file,
  `bun run typecheck`, and `git merge-base --is-ancestor` for every SHA in the
  table. No repository-wide suite, per the standing constraint.
- Terminal outcomes: DONE when all three deliverables are verified.
  NEEDS_HUMAN if a row cannot be sourced to explicit maintainer language.
  BLOCKED if a GitHub write is refused.
