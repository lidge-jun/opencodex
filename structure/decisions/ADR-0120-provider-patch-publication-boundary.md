# ADR-0120 — decision recorded under "Durable provider PATCH"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#durable-provider-patch)

## Decision Log

- Purpose and intent: Keep the live provider graph aligned with a published config while restoring
  the exact provider ordering when a write is refused before publication.
- Existing implementation and constraints: The synchronous save does more than replace a file.
  Registry refresh, generation updates and baseline adoption can throw after the rename. A memory
  rollback cannot undo that publication. Re-defining a deleted record key also changes its position.
- Alternatives considered: Treat every exception as a failed write; reread and compare the file on
  every failure; or carry the publication boundary explicitly. Replace the whole graph or restore
  original record descriptors in their original order.
- Chosen approach: Mark successful atomic rename before cleanup and tag later exceptions with a
  ConfigWritePublishedError retaining their cause. An already-identical file has the same committed
  state. Live-save bookkeeping preserves this distinction; provider PATCH only rolls back untagged
  errors. Rebuild reordered plain-record properties in place, keeping container and array identities.
- Why this approach: A reread can fail independently and cannot turn a published file back into an
  uncommitted candidate. The receipt describes the actual operation. In-place restoration preserves
  references held by routing, while descriptor replay alone cannot restore deleted-key order.
- Benefits, drawbacks, and impact: Pre-publication failures remain retryable without changing live
  provider state or route ordering. Post-publication failures still propagate and may leave refresh
  work pending, but do not falsely restore only memory. This does not make generation metadata or
  derived registries atomic with filesystem publication, and does not silently claim success.
