# 037 — Go hot-path routing decisions (ticket #30)

The Go increment adds a pure state-snapshot decision package for quota account selection, hard/soft cooldown admission, and API-key-pool 429 failover. The routingcheck sidecar subcommand exposes that engine to the Bun differential harness; it is not a live sidecar route.

The differential vectors prove both issue acceptance points for identical supplied state: quota/account selection agrees, cooldown admission returns the same candidate or earliest unavailable time, and key failover selects the same next eligible key and Retry-After cooldown.

The engine is intentionally not wired into hotpath_relay.go. Ticket #27's direct relay performs one upstream request and returns its first 429. TypeScript performs key rotation later in src/server/responses/core.ts through rotateProviderTransportOn429 after handleResponses owns the route and config persistence. A trial direct Go retry returned 200 where the TypeScript oracle returned 429, so it was reverted.

A later flip needs a body-bound parent bridge claim carrying the selected route, volatile quota/cooldown snapshot, and retry/persistence authority, or a Go-owned equivalent store. Until then the TS front door remains the owner of credentials, live account state, and observable retry execution; the Go engine is the checked decision kernel for that bridge.
