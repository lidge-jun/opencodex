# 004 — audit round 3: four findings, all upheld, and one external unblock

Same reviewer, third pass. Verdict FAIL. Three findings are document drift; the fourth
is a real collision and comes with news that changes the schedule.

## The news: #3089 already merged

`gh pr view 3089` → `MERGED 2026-08-31T16:47:15Z` at `a0d386b49`, and `origin/dev` now has
it at the tip. The train's #3071 fix landed while wp0 was being audited, so wp5's
external blocker is gone before wp5 ever ran. Train PR #3020 is still `OPEN`, so #3003's
blocker stands.

A blocker that dissolves on its own is the argument for keeping the wp5 ordering rule
as "re-read state at the phase" rather than "wait for a fact recorded at scan time."

## 4. #3066 and #3063 collide with each other

Both edit `src/adapters/openai-responses.ts`. wp5 listed them as two merges with one
shared external blocker and no order between them. With #3089 merged, both can now land
on the same file in either order, which is exactly when an unordered pair bites.

**wp5 order: #3066 first** (it is the narrower change — one strip call inside the
existing noncanonical block), then #3063 rebases onto that head, then #3038 closes
without merging. #3063 ∩ #3038 on `compact.ts` is therefore harmless.

This pair was found by the reviewer pairing every scoped PR's file list against every
other, which is the check that caught #3063's growth in round 2 as well. It is now a
standing step, not a one-off.

## 1-3. Document drift

- `002` still carried `RestoreDialog.tsx:64-66` while `003` claimed it was corrected. The
  claim was true of `001` and false of `002`. Fixed, with the `:49-50` / `:64-66` distinction
  spelled out so it cannot drift back.
- `001`'s prose still said "#3059 and #1419 held up" and "only #2813 is currently
  declared unsolvable", contradicting its own rewritten rows two paragraphs above.
  Fixed.
- `002`'s phase order was the pre-round-2 sequence. It is now explicitly marked
  superseded rather than silently rewritten, so the amendment history stays readable.

All three are the same defect: correcting a table without correcting the prose that
summarizes it. The reviewer read the prose. So will the next phase.

## Confirmed disjoint

#3067 ∩ #3039 share `src/service.ts` but at `@@ -1935` and `@@ -660`, and wp4 already
orders them reimplement-then-merge. No other in-round or train overlap is unaccounted
for.

## Order after round 3

wp1 → wp2 → wp3 → wp4 → wp7 (#3078; #3053 after wp2) → wp6 (#2989, then #2999/#3000,
then #3003 after train #3020) → wp5 (#3066, then #3063, then close #3038) → wp9 (#3070,
#1527, #3021, #3059) → wp8.
