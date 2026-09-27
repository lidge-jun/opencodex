# ADR-6021 — Kiro status-read ownership

- Contract owner: [GUI and management API](../gui-and-management-api.md#authentication-boundaries)

## Decision record

- Purpose and intent: Let Kiro device-login reconciliation survive dialog unmount without allowing a stalled response body to outlive the documented read and flow deadlines.
- Existing implementation and constraints: The hook consumed an original `Response` while the detached finalizer consumed a clone. The 45-second race ended when headers arrived, so either body could then wait forever. The already-sent status request must still be able to prove a terminal credential commit after Cancel; simply aborting it on unmount would lose that evidence and permit a later 404 to win.
- Alternatives considered: Abort the hook request and start a fresh finalizer request; retain cloned responses but race each `json()` call; transfer one operation that owns transport, body, parsing and cancellation.
- Chosen approach: Create one status-read operation before dispatch. It owns fetch, a bounded 64 KiB body reader, JSON decoding and public-view validation under one 45-second timer. Closing the dialog transfers that operation to the module-scoped finalizer. The finalizer separately caps its wait by the remaining flow deadline, cancels an inherited reader when that bound wins, and clamps retry sleep to the remaining time.
- Why this approach: One reader preserves terminal-reply precedence without duplicate body consumers. Explicit stream ownership lets timeout settle independently of cooperative transport abort and releases the finalizer singleflight even when EOF never arrives.
- Benefits, costs and impact: Status reads have deterministic memory and lifetime bounds, and a delayed terminal EOF can still reconcile after unmount. The helper is intentionally scoped to status polling; initial-login and cancellation response bodies retain their existing behavior. A status body larger than 64 KiB is treated as retryable invalid input rather than retained.
