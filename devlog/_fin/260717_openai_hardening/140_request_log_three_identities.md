# Cycle 140 — Request Log Three-identity Persistence

## Objective

Verify that `addFinalRequestLog` persists the three model identities for Pro requests:
`model` (selected virtual), `requestedModel` (namespaced caller id), `resolvedModel`
(upstream base). The usage JSONL also persists all three.

## Scope

- `RequestLogContext` carries `requestedModel`, `resolvedModel` fields
- `addFinalRequestLog` propagates all three to `RequestLogEntry` and `PersistedUsageEntry`
- Non-Pro requests: `requestedModel` = namespaced model, `resolvedModel` = upstream response model
- Pro requests: `model` = virtual, others as above
- `PersistedUsageEntry` includes `requestedModel` field

## Activation tests

- `tests/usage-log.test.ts` entries include `requestedModel`
- `tests/request-log.test.ts` Pro entries include all three identities
- Compact entries: `usageStatus: "unreported"` but identities preserved

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
