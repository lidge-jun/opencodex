# ADR-0104 — decision recorded under "Durable provider PATCH"

- Contract owner: [gui-and-management-api.md](../gui-and-management-api.md#durable-provider-patch)

## Decision Log

- Purpose and intent: Keep failed provider PATCH writes from changing live routing or configuration.
- Existing implementation and constraints: Synchronous persistence may rebase nested config records
  and arrays before writing. Routing retains references to live containers; config baselines and
  pending deletion intent attach to the original config identity. Destination checks are asynchronous.
- Alternatives considered: Roll back only the replaced provider; replace the full config with a
  structured clone; persist a detached candidate; restore the original graph's descriptors in place.
- Chosen approach: Take a descriptor snapshot of plain config containers inside the existing
  mutation lock, then mutate/save synchronously and restore on failure. Reuse the provenance helper
  for private deletion state. Keep field-mask replay inside the lock and all effects after save.
- Why this approach: Provider-only restoration cannot cover persistence rebases. Replacing a deep
  clone loses shared references and descriptors, and cannot retain function-valued runtime fixtures.
  Detached persistence changes live-baseline ownership and conflict semantics beyond this patch.
- Benefits, drawbacks, and impact: Every PATCH variant has the same failure boundary while successful
  replay, cache behavior and reconciliation order remain intact. Snapshot cost is linear in the live
  config graph and is paid only on management PATCH. The helper restores plain config containers,
  not arbitrary class internals, and relies on synchronous persistence. It is not a transaction for
  failures in post-save effects or a replacement for the store's atomic file publication contract.
