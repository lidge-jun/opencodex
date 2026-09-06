# 040 — Go hot-path routing decisions (ticket #30)

The new Go routing package is a pure state-snapshot kernel. The `routingcheck` sidecar subcommand runs it only for Bun differential tests; it is not a live sidecar route and the relay remains unchanged.

The differential imports TypeScript as the oracle. It creates an isolated home, writes account credentials with `saveCodexAccountCredential`, seeds quota with `updateAccountQuota`, and clears quota, health, thread, rotation, and key-cooldown state around each vector. It calls `resolveCodexAccountForThread` for quota selection and a real 429 cooldown created by `recordCodexUpstreamOutcome`; key vectors call `rotateKeyOn429` and `getKeyCooldownUntil`. Each TypeScript decision is compared with JSON from the Go executable.

Covered matrix: quota strategy active threshold rotation to lowest known usage; hard quota cooldown exclusion where another account is eligible; and key-pool 429 ring selection plus numeric Retry-After cooldown. The Go parser rejects non-TypeScript numeric forms such as `1e3`, `+5`, and `0x10`.

Not yet covered or claimed: round-robin smooth-weight/sticky-success state, fill-first runtime cursor, unknown and plan-window quota scoring, all-unavailable sentinel behavior, priorities, affinity, reauth, scoped cooldowns, and soft avoid. A later parent-authorized state bridge must carry these state snapshots and successors before those paths can flip.

The engine is intentionally not wired into the direct relay. The relay returns its first upstream 429, while TypeScript executes `rotateProviderTransportOn429` later in `handleResponses`, after owning route and config persistence. A Go retry returned 200 where the TypeScript oracle returned 429, so that wiring was reverted.
