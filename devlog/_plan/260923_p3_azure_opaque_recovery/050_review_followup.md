# 050 — Review follow-up on PR #5639 (wp-5)

Hosted CI on 873c0e04a1 passed every required job. Automated review raised four findings, all
verified against source before changing anything.

| Finding | Verdict | Change |
| --- | --- | --- |
| Docs said no 5xx is retried; `shouldAttemptOpaqueBlobRecovery` admits the exact encrypted function-output 502 | Valid | English subsection names the one 502 exception |
| Locale `proxy-formats.md` pages lacked the new subsection while their adapter notes described it | Valid | Translated subsection appended to all seven locales |
| (duplicate of the 502 finding) | Valid | Same change |
| A proven route switch strips the blob but keeps the `rs_*` id; with `store` omitted Azure answers `Item with id … not found`, and recovery cannot run because the body no longer carries a blob | Valid | See below |

## Proven switch across stores

The reviewer proposed a second single-shot recovery keyed on the "Item not found" answer. That adds
a rejection identity and a round trip, and this lane keeps recovery to the existing opaque-state
identities. The id is foreign exactly when the item store changed, and the serving record already
knows that: its tuple is provider, durable destination, adapter, model, durable credential.

- `reasoningReplayItemStoreChanged(scope)` in `src/responses/reasoning-replay-cache.ts` compares the
  durable destination and credential of the last serving route with the current one.
- `bindRouteReasoningReplayScope` sets the id-drop flag, renamed `_dropForeignReasoningItemIds`, when
  the serving identity changed and the store changed. A model or adapter change on the same
  destination and credential still strips the blob and keeps the id, which that store can resolve.
- The existing passthrough test that sets `_stripReasoningEncryptedContent` directly is untouched.

New cases in `tests/responses/responses-azure-opaque-blob-recovery.test.ts`, on both adapters: a
session first served by the other provider moves over with one clean send; a model change on the
same destination keeps the id and drops the blob.
