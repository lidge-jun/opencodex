# Codex provenance writer

Issue: #2622

## Placement and ordering

The writer runs in `src/codex/inject.ts` immediately after `withCodexWriteLock`
returns an acquired apply or remove transaction. At that point the native files
and the coordinator row carrying the transaction id have committed. The call
uses only `updateIntegrationRecord`; it does not perform its own read, merge, or
write.

The ledger append is best-effort. Provenance is optional in the v1 record, and a
non-CAS JSON failure must not turn a committed native transaction into a reported
failure. If the process crashes after the transaction commit and before the
ledger append, the native transaction remains admitted and the ledger has no
matching entry. That ordering is safe because absence grants no restore authority
and existing acceptance treats absence as unavailable evidence; writing before
the transaction commit could instead leave provenance for a transaction that
never committed.

## Entry shape

One admitted transaction appends entries for the native artifacts it may mutate:
`config`, `generated-profile`, and `injection-journal`. Every entry contains the
transaction id, one shared observation timestamp, the exact pre-transaction
baseline (`absent` or SHA-256 plus base64 bytes), and the SHA-256 post-image or
`null` when the artifact is absent after the transaction.

Existing version-1 records without provenance remain valid. The update spreads
the old record and appends to its existing entries; `updateIntegrationRecord`
remains responsible for preserving unknown record, ledger, entry, artifact, and
baseline extensions and for refusing malformed bytes.

## Lifecycle

The record stays under the owned OpenCodex home at `integrations/codex.json`.
`ocx uninstall` already removes that owned home, so this ledger does not add an
external artifact or a removal precondition.
