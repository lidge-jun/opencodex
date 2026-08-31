# 003 — audit round 2: five findings, all upheld, including one of my own errors

Same reviewer, resumed. It was asked to audit only the amendments. Verdict FAIL again.
All five stand.

## 1. My `rg` was broken, and the reviewer caught it

I told the reviewer `RollbackHistory` does not exist in this tree. It does:
`gui/src/pages/integrations/RollbackHistory.tsx`. My search was
`rg -n 'RollbackHistory' gui/src --include='*.tsx' -l`, and ripgrep rejected
`--include` as an unknown flag — that is a **glob**, and ripgrep spells it `-g`. The
command errored out and I read the empty result as absence.

This is worth recording because the failure mode is silent: a tool that exits non-zero
on an unknown flag produces no matches, and no matches looks exactly like a confirmed
negative. A negative search result is only evidence when the command actually ran.

The residual stands as the reviewer originally framed it: the restore trigger is the
per-row button in `RollbackHistory.tsx:55-58`, which the collapsed case removes from the
DOM, so `restoreFocusRef.current?.focus?.()` has nothing to focus.

## 2. Citation off by five lines

The self-documenting comment is at `RestoreDialog.tsx:49-50`, inside the effect cleanup,
not `:64-66`, which is the `submit` body. Fixed in `002`.

## 3. #3063 now touches two train-owned files

This one is a live-state change, not a reading error. When lane D judged #3063 it
reported two files. `gh pr diff 3063 --name-only` now returns five:

```
src/adapters/openai-responses.ts
src/bridge.ts
src/server/responses/compact.ts
src/types/request.ts
tests/server-combo-failover-e2e.test.ts
```

The first two are exactly what the train's #3089 rewrites. #3063 therefore inherits the
same constraint as #3066 and moves out of wp7 into wp5, which is the train-blocked
phase. It also shares `src/server/responses/compact.ts` with #3038 — harmless, because
#3038 is being closed, but it means wp5 owns the whole compact/metadata surface.

This is the concrete argument for refreshing PR file lists at the phase that merges
them rather than at the scan: a PR is a moving target and this one moved during wp0.

## 4. #3000 and #2989 collide with each other

Both edit `src/oauth/index.ts` and `tests/oauth-refresh.test.ts`. #2989 is a merge and
#3000 is a rewrite, so wp6 merges #2989 first and the #2999 rewrite rebases onto it.
Recorded as an explicit intra-phase order, not left to chance.

## 5. 001's table still said the old thing

`001` is the living verdict table and still carried `#3059 CLOSE_INVALID / wp1` after
`002` moved it. A synthesis document that corrects a table without editing the table
leaves two contradicting sources, and the later phase reads the table. Fixed.

## Amended order after round 2

wp1 → wp2 → wp3 → wp4 → wp7 (#3078, #3053-after-wp2) → wp6 (#2989, then #2999 rewrite;
#3003 after train #3020) → wp5 (#3066, #3063, close #3038 — all after train #3089) →
wp9 (#3070, #1527, #3021, #3059) → wp8.
