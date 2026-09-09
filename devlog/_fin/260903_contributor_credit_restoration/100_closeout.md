# 100 — Closeout: contributor credit restoration, 2026-09-03

## Outcome

DONE. All three deliverables shipped.

`CREDITS.md` and the co-author gate landed on `dev` as `7a529a2e8` (PR #3318,
squash-merged with `--admin`, every check green on the exact head). Credit
sections were appended to six release bodies afterwards, in that order, so the
`CREDITS.md` link in each note resolves.

## What was found

27 landing commits carry an uncredited origin — 26 contributor pull requests
across `v2.23.0` through `v2.40.0`, plus one still only on `dev`.

Two scans, both re-runnable, and they disagreed in useful ways:

- Commit-side: `origin/dev` bodies matching the carry verbs, joined against
  their own trailers. 23 matched, 12 name an author in prose with no trailer.
- PR-side: maintainer closure comments on the 119 closed-unmerged external pull
  requests since #2400, each landing commit checked for a trailer naming the
  original author.

Fourteen PR-side hits were false positives. Three resolved by walking the merge
range instead of the squash commit. Eleven resolved once login was matched
against git identity — that failure mode then became the gate's rule 3, and its
own regression test.

## What the process caught

**The privacy scan, twice.** A comment explaining why login matching is
insufficient quoted a contributor's real git email out of the scan data, and a
test fixture used a literal noreply address. Both were caught by
`bun run privacy:scan` rather than by review. Illustrating a rule about
attribution by publishing someone's address is a bad trade.

**The test suite, on a defect the plan did not anticipate.** The first
implementation took a fixed 80-character window after each carry verb.
`tests` caught it missing the second number in "Reimplements #2797 and #2796",
and the fix — a sentence bound — turned out to matter more than the bug: a
fixed window would have pulled the issue out of `53c09a247`'s real
"Supersedes #3193. Fixes #3192." into the carry set, demanding a trailer for
someone who reported a bug.

**`tests/ci-workflows.test.ts`, on a vacuous filter.** Adding the new read to
the write-audit exclusion list, the first attempt appended it after a comma
instead of an `&&`, turning the whole predicate into a comma expression that
always returned its last operand. Every filter case would have passed
vacuously. The suite failed immediately.

**Review, on four real holes.** All four made the gate quietly weaker rather
than louder: unmatched verb inflections (`Reimplementing`, `Carrying`,
`Rebasing`), cross-repository references resolved against the wrong repository,
substring identity matching where "Ann" is satisfied by "Joanne", and
`pr-hygiene.yml` not subscribing to `edited` — so an author who added the
trailer exactly as instructed would have seen nothing change.

## What is deliberately not in `CREDITS.md`

#3020 and #2675 were closed with a landing commit and no statement of what was
taken. They are named in a closing paragraph rather than a table row: inventing
a "what landed" cell would be the same inaccuracy the file exists to correct.

## Constraint honored

No repository-wide local suite at any point. Verification was
`node --test .github/scripts/*.test.cjs`, `bun test tests/ci-workflows.test.ts`,
`bun run test:changed`, `privacy:scan`, `typecheck`, and the exact-head GitHub
rollup.
