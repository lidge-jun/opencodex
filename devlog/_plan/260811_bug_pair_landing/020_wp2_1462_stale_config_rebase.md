# 020 — wp2: #1273 / #1462, stale full-config writes

## The defect (#1273, defect 2)

A long-running process holds an older in-memory configuration. When it saves,
it writes that whole remembered document, so providers and custom models
deleted on disk in the meantime come back.

## What the contributor did (`2f9225915`)

`src/config.ts`: captures a full config baseline when the long-lived config is
armed, adds ID-indexed three-way merging for `customModels`, rebases live config
fields against the current persisted config before serialization, and refreshes
the baseline after a save. The rebase read is correctly placed:
`withConfigMutationLockSync()` at `src/config.ts:2988`, `readRawConfigJson()` at
2992, `persistConfigUnlocked()` at 3027-3031 — all inside one lock, so
cooperating writers are fully serialized.

Verified working: an unchanged stale provider deleted on disk is removed; an
unchanged stale custom-model row deleted on disk is removed by the ID merge at
2826-2835; disjoint object fields and disjoint custom-model row fields merge
correctly. The two added tests are genuine red-then-green regressions — the
file scores 32 pass / 2 fail against unfixed `dev` and 34 pass / 0 fail on the
PR head.

## Blocker (ours): delete-vs-live-edit still resurrects

The fix only covers rows that were *untouched* in memory. When both sides
changed and the persisted side is a deletion, `src/config.ts:2884-2896` sees a
persisted `MISSING_CONFIG_VALUE`, which is not a plain record, so recursion is
skipped and the function returns `live`. Custom models reach the same rule
through 2829-2834.

A probe at the exact PR head deleted a provider and a custom model on disk while
changing those rows in memory:

```json
{"providerResurrected":true,"customModelResurrected":true,
 "providerApiKey":"rotated","customModelId":"two-live-edit"}
```

So the headline scenario of #1273 — a deletion coming back — still happens as
soon as the stale process also touched the row. An API key rotation in the
dashboard is enough to trigger it. This is not a corner case; it is the same bug
one edit away.

## The fix

Handle delete-vs-edit explicitly in the merge rather than falling through to
`live`. The persisted deletion wins: a row absent from the current persisted
document is not resurrected by a stale in-memory edit, because the deletion is
the newer intent and the edit was made against a document that no longer
describes reality.

That choice deserves stating rather than assuming: the alternative is to raise a
conflict. Silently keeping a stale edit is the one option that is definitely
wrong, since it is exactly the reported bug. Preferring the deletion is
consistent with the merge's existing treatment of untouched deleted rows, so the
behavior does not depend on whether the stale process happened to touch the row.

## Regressions

In `tests/config-user-edits.test.ts`, two cases the contributor's tests miss:

1. a provider deleted on disk while the live config edits that provider's own
   fields (rotate `apiKey`, not just `disabledModels`) stays deleted;
2. a custom model deleted on disk while the live config edits that same model
   row stays deleted.

Both must be red against the PR head, not merely against clean `dev` — the
point is that they catch what the contributor's fix does not.

## Known limitation to record, not fix

A non-cooperating writer (a text editor writing `config.json` directly) does not
take the SQLite lock and can write between the read at 2992 and the atomic
replace in `persistConfigUnlocked()`. The lock serializes repository writers; it
cannot serialize an arbitrary filesystem write. Out of scope for this pair —
worth a note in `structure/`, not a redesign here.

## Verification

- `bun test tests/config-user-edits.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## Landing

Cherry-pick `2f9225915` preserving `Yuxin-Qiao` as author, then a second commit
for the delete-vs-edit rule and its two regressions.
