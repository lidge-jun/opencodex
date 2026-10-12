# 020 — Tests (wp-3)

New sibling file `tests/responses/responses-azure-opaque-blob-recovery.test.ts` (the existing
recovery file is 1,852 lines against the 2,000-line new-file threshold). Register it in
`scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json` under
`responses`.

Fixture: two key-auth providers, `azure` (`adapter: "azure-openai"`,
`https://azure.example.test/openai/v1`) and `responses` (`adapter: "openai-responses"`). The
conversation carries a reasoning item with `id: "rs_foreign_backend"`, a summary and a foreign
`encrypted_content`, with `store` omitted so ids are not stripped by the unstored rule.

Cases, parameterized over both adapters where the criterion says "the same test":

1. One recovered send: first body carries blob and `rs_*` id, rejection is the reported Azure
   `invalid_encrypted_content` body, second body carries neither, reasoning summary and user
   message survive, `sendCount` 2, `recoveryKinds` `["opaque-blob-rejection"]`.
2. Later turns: a fake upstream rejects blobs with the opaque identity and rejects a surviving
   `rs_*` id with `Item with id … not found`; three turns in one session give sends
   `[blob+id, clean, clean, clean]` and every turn returns 200 (memo path drops the id too).
3. Trigger unit: `shouldAttemptOpaqueBlobRecovery` accepts `azure` and `azure-openai`, rejects
   `openai-chat`, an unknown adapter, an ordinary 400, a 429 and 500/503 for `azure-openai`.
4. Path unit: `attemptOpaqueBlobRecovery` with an `azure-openai` 400 unrelated body, a 429 and a
   503 never calls `rebuild`; with the opaque rejection it calls it once and a second call on the
   same guard is skipped.
5. Budget: a request budget with one total send yields exactly one upstream send and no second
   send on Azure (the rebuild is refused by the shared ledger, not granted a fresh allowance).
6. Second rejection: repeated Azure rejection surfaces 400 after exactly two sends.

Constants are derived: rejection bodies are local fixtures; the wire name comes from
`resolvedAdapterWire`, not restated.
