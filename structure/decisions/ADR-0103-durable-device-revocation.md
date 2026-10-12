# ADR-0103 — decision recorded under "Durable device revocation"

- Contract owner: [remote-workspace.md](../remote-workspace.md#durable-device-revocation)

## Decision Log

- Purpose and intent: Make the enrollment store the authority for a completed device revocation.
- Existing implementation and constraints: The Hub uses a synchronous store and an in-memory
  connection registry. Closing a connection is an externally visible effect that cannot be undone.
- Alternatives considered: Restore an enrollment after closing its connection; retain a separate
  pending-revocation tombstone; save a candidate enrollment list before publishing it.
- Chosen approach: Save the filtered state first, then publish it and close the connection.
- Why this approach: The synchronous store requires no await or intermediate admission window.
  A failed operation keeps its original authority and can be retried through the same API.
- Benefits, drawbacks, and impact: Successful revocation survives reload without a new persisted
  schema. A failed save deliberately leaves enrollment and connection active; the caller receives
  the storage error and must retry. This change does not alter other Hub mutation methods or RPC.
