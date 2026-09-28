# ADR-4191 — decision recorded under "Ambiguous-resend gate"

- Contract owner: [transports/responses-failover.md](../transports/responses-failover.md#ambiguous-resend-gate)
- Recorded: 2026-09-26

## Decision record

- Purpose and intent: Recover an established Codex WebSocket that closes or errors before any semantic Responses event without replaying partially observed turns.
- Existing implementation and constraints: At dev `5518653a9a`, the implementation from `aed3bb8f42` already marks eligible socket deaths and asks the shared ambiguous-resend gate in passthrough dispatch. A successful WebSocket send can have started inference even if nothing came back. Liveness/prelude diagnostics and silence deadlines already exist independently.
- Alternatives considered: Add an unconditional SSE retry inside the exchange; add a second transport-local retry counter; replace requests after text-free response events; or retain the existing dispatch-owned replacement and strengthen regression coverage.
- Chosen approach: Keep the existing dispatch-owned HTTP-only replacement. Require the provider's `retryOnReset` policy, self-contained request judgment, unspent request-wide grant and available send budget. Record and charge the physical send at the ordinary boundary, after credential selection is revalidated. Extend deterministic coverage rather than add a duplicate transport path.
- Why: The exchange cannot independently authorize a new inference, reserve spend, refresh credentials or choose another account. The shared dispatch already owns those decisions and the request identity. Any semantic response event ends eligibility, including creation, tool and usage events before text. Quota control frames and pong events indicate liveness only.
- Advantages, costs and consequences: One default replacement remains available without weakening hosted-tool, cancellation, timeout, native-control or committed-output exclusions. The opt-in still accepts possible duplicate inference billing; absence of output does not prove non-execution. An explicit `replacements: 2` retains the existing shared-policy contract for a subsequent HTTP reset, rather than becoming a second WebSocket fallback. This change does not widen that policy or alter runtime behavior.
- Validation boundary: `tests/responses/ws-ambiguous-resend.test.ts` pins the behavior that landed in #5675 (`aed3bb8f42`); it runs in the hosted test shards. The fallback covers a socket that dies after the create frame and before the first Responses event; a death after output started stays a failed leg, because replaying it risks a second inference.
