# 260923 P3 — Azure OpenAI opaque reasoning recovery (#5583)

## Problem

Moving an existing Responses conversation onto an `azure-openai` provider replays reasoning state
the previous provider minted. Azure answers `400 invalid_encrypted_content`, and the proxy never
recovers, although the same rejection on `openai-responses` gets one sanitized resend.

Two defects, both confirmed from source on `origin/dev` e9643875f0:

1. **Gate by name.** `src/server/responses/core-opaque-recovery.ts` admits recovery only when
   `adapterName === "openai-responses"`, in `shouldAttemptOpaqueBlobRecovery` and in
   `opaqueBlobRejectionBodyForRecovery`. `createAzureAdapter` spreads the Responses passthrough
   and renames it `azure-openai`, and both dispatchers pass `adapter.name` into the gate
   (`passthrough-dispatch.ts` HTTP and streamed recovery, `adapter-dispatch.ts`). The adapter
   registry already declares the relationship: `azure` and `azure-openai` carry
   `contractParent: "openai-responses"`, and `resolvedAdapterWire()` resolves it.
2. **The item id survives the blob.** Recovery sets `_stripReasoningEncryptedContent`; the
   passthrough's `sanitizeReasoningInputContent` then deletes `encrypted_content`, but
   `stripInvalidItemIds` keeps a well-formed `rs_*` id and `stripItemIdsWhenUnstored` removes ids
   only when `store === false`. With `store` omitted or true, the resend still names an item the
   previous identity stored, and a stateful Responses destination resolves it against its own store:
   `Item with id 'rs_…' not found.` The reporter observed exactly this; the code path confirms it.

## Decisions

- Gate on the wire the registry declares (`resolvedAdapterWire(adapterName) === "openai-responses"`),
  keeping the `adapterName` argument. A future wrapper that declares the same `contractParent` is
  covered by construction; `openai-chat` and every other wire stay excluded.
- Drop the reasoning item `id` together with the blob only after the destination itself rejected
  foreign opaque state: the recovery rebuild (`prepareOpaqueBlobRecovery`) and the five-minute
  rejection memo that strips pre-flight on later turns. A new request flag
  `_dropForeignReasoningItemIds` carries that signal. A plain proven route switch keeps its
  current behaviour (blob removed, item and id kept), which an existing passthrough test pins.
- Keep the item and its summary, as openai-responses recovery already does; only the two opaque
  fields minted by the rejected identity go.
- Recovery stays narrow: status, rejection identities, the single-shot guard and the send budget
  are unchanged.

Out of scope, recorded for the coordinator: `transientRetryPolicyFor` and the Lab
`upstreamProtocolForAdapter` table also key on adapter names and treat `azure-openai`
differently from its declared Responses contract. Neither affects this recovery path.

## Work-phases

| Id | Doc | Outcome |
| --- | --- | --- |
| wp-1 | this file | Roadmap locked (docs only) |
| wp-2 | [010_source.md](010_source.md) | Contract gate and rejected-id drop |
| wp-3 | [020_tests.md](020_tests.md) | Sibling regression file, layout registration |
| wp-4 | [030_docs.md](030_docs.md) | structure and docs-site sync |
| wp-5 | [040_delivery.md](040_delivery.md) | One PR to dev, exact-head CI |

Review follow-up inside wp-5: [050_review_followup.md](050_review_followup.md).

## Verification policy

Local checks: NOT RUN (lane rule: no local suite, focused tests, typecheck, build, install or
proxy). Evidence is static source reading plus hosted CI on the exact PR head SHA.

## Audit (wp-1 A)

An independent read-only audit confirmed every claim above from source: the two name gates
(`core-opaque-recovery.ts` `shouldAttemptOpaqueBlobRecovery` and
`opaqueBlobRejectionBodyForRecovery`), the `contractParent` declarations and
`resolvedAdapterWire`, the surviving `rs_*` id when `store` is not `false`, and the import edge
already present through `request-prepare.ts`. No existing recovery or memo test carries a reasoning
id, so the rejected-id drop changes no current expectation. Two adjacent name checks sit outside the
recovery path and stay unchanged: `mandatoryResponsesReasoningReplayUnavailable` in
`core-replay.ts` (combo plaintext eligibility) and the OAuth-pool 429 scope rebind in
`passthrough-dispatch.ts`, which a key-auth Azure provider never reaches. Verdict: PASS.
