# Child-initiated linked updates — draft unit

**Status:** depends on the signed supply, destination grant and durable update
operation in `060`. Home-initiated SSH alone does not cover this link direction.
Do not treat the current `transport-unsupported` state as final parity.

## Outcome and proposed transport

For a Child-initiated link with no Home-to-Child SSH exec route, the proposed
Child would poll its authenticated Home connection for a request addressed to
its locally approved update grant. The existing passive management relay stays
read-only. A separate versioned exchange would carry bounded signed requests
and results; the Child would check its grant, policy, candidate, installer
ownership and idle admission before any effect. Home could request but not
approve or widen the destination grant. Existing link sync would remain a
separate operation and status.

The existing Home listener combines its route allowlists in
`src/server/index/optional-listeners.ts:90` and admits the configured link key
before dispatch (`src/server/index/serve-options.ts:387`). The Child's
`fetchBoundLinkRelay` authenticates the Home and sends on the same socket
(`src/client/link-relay-transport.ts:240`); the existing parity reporter is a
bounded Child-to-Home POST example (`src/client/link-home.ts:344`). These are
transport precedents, not update authorization. In particular, the Home
management relay remains a separate read-only allowlist.

Proposed exchange uses two exact Home link-listener routes, both POST with no
query, upgrade or redirects: `/v1/link-update/poll` and
`/v1/link-update/result`. Add an update-specific route predicate and dispatch
sibling; do not add either route to `link-management` or the Child's local data
ingress. Before the handler, retain the current link-key admission and require
its configured key ID to match the current link record. The handler then
verifies the separately enrolled destination response key and grant/binding
epochs from `060`; link-key possession alone cannot select or acknowledge an
operation. Unknown route, old peer, missing grant, revoked binding, stale key or
unreadable state returns unavailable and causes no update effect.

`ocx.link-update.poll/1` contains `requestId`, random `nonce`, `issuedAt`,
`notAfter`, `childId`, `installationId`, `linkId`, `linkBindingEpoch`,
`grantId`, `grantEpoch` and the latest observed operation ID/revision or null.
The destination signs the exact bytes with its enrolled response key using a
separate poll domain; the bounded envelope follows `060`. A valid response is
`ocx.link-update.poll-result/1` with the poll request digest and nonce,
destination/grant bindings, server time and either null or one already journaled
Home-signed `ocx.link-update.envelope/1`. The Home signs the exact response
bytes with its enrolled update key. The Child verifies the response, then the
contained request's independent Home signature, action, expiry, local grant,
policy, exact candidate and current binding before recording or performing it.
The Home may not use the poll response to widen the destination grant.

`/result` carries a destination-signed `ocx.link-update.result/1` from `060`,
including the originating request digest, nonce, operation and revision; the
Home stores it only after signature, admitted key, current binding and journal
intent all match. Repeated identical results are idempotent; a conflicting
revision is refused. Return only a bounded acknowledgement bound to that result
digest. Limit each envelope and response to 64 KiB, decoded payload to 32 KiB,
input/read time to five seconds, and signed request validity to five minutes.
No endpoint returns local paths, credentials or arbitrary execution commands.

The destination poller starts only for an active Child-initiated connection
with a locally enabled grant. Use one in-flight poll, a 30-second normal
interval and bounded 5/15/30/60-second retry backoff; stop on disconnect, runtime
shutdown or revoked grant. Reconnect first reconciles its durable operation and
binding before polling again. A lost poll response is retried with a fresh poll
nonce; a delivered operation is deduplicated by its journal identity, not
re-executed. Accepted installation work is handed to the same destination-owned
worker and recovery contract as `060`, independent of the tunnel lifetime.
No status changes to healthy until the destination observes the exact installed
target and owned serving runtime. Exact worker startup and platform survival
remain a proof requirement, especially for Windows channel containment.

| Operation | Proposed path | Required change |
| --- | --- | --- |
| NEW | `src/link/update-exchange.ts`, `src/client/link-update-poller.ts` | Dedicated authenticated POST poll/result exchange and Child-owned bounded poller. The poll reads only a previously journaled request; result publication uses its own authorized operation, not management relay writes. |
| MODIFY | `src/server/index/optional-listeners.ts`, `src/server/index/serve-options.ts` (extract an owned sibling if ratcheted), `src/remote/features.ts` | Admit the two exact exchange paths only on the authenticated Home link listener, dispatch with the configured key identity and advertise the capability only when implemented. Preserve existing connection-bound relay authentication and passive-read routes. Unknown peers and absent grants remain unavailable. |
| MODIFY | Destination and fleet journals from `060` | Persist request intent and outcome across Home/Child restart; reconcile the same operation after response loss, expiry or reconnect. Recheck binding epochs, local policy and owner before commit. |
| MODIFY | `src/server/management/link-update-routes.ts`, `gui/src/remote-link-update-api.ts`, `gui/src/components/remote-link-update-panel.tsx` | Project Child-pull operations through the same `060` versioned dashboard status/action/readback DTOs; add old-peer, disconnect, reconnect, Retry A→B with lost reply and uncertain-result cases without granting the passive relay write authority. |
| NEW | `tests/clients/link-update-child-initiated.test.ts`, `tests/server/link-update-exchange.test.ts` | Isolated linked homes, fake transports and signed test artifacts: no grant, stale link, duplicate delivery, lost responses, busy/unknown runtime, cancellation, crash recovery and separate sync results. Register both domain files in the two test-layout maps. |
| MODIFY | `structure/remote-link.md`, `structure/remote-messaging.md`, relevant user docs and all affected translations | Record implemented transport, policy, prerequisites and actionable unsupported cases. |

## Activation and evidence

Prove that a Child with no locally approved grant receives no installation
authority, that Home cannot change Child policy, and that duplicate or late
requests cannot start a second install. A signed exact candidate and future
compatibility proof are necessary but not sufficient: the Child independently
rechecks its own owner, current policy and idle reservation. A reconnect or
credential change invalidates stale operation bindings. Network loss leaves
accepted work under its destination-owned recovery; status is not reported
healthy until exact target and runtime health are observed.

Use fake links, isolated homes, test keys and a local mock feed. Run failing-
first focused protocol, grant, replay and recovery tests; then typecheck,
privacy/structure, Lab boundary, layout and exact-head CI. Obtain a separate
independent security PASS. The exchange uses the `060` `U → O → A → N → L → C
→ J` order: poll/result network I/O holds none of those locks; the destination
checks and commits journal/binding state in short transactions and reacquires
activation authority before mutation. This proposed order and destination
worker survival still require call-graph, crash and platform proof before audit.

Baseline on 2026-11-07: `bun test tests/server/sidebar-routes.test.ts
tests/server/link-management-relay.test.ts` passed 31 tests (exit 0). The relay
suite starts isolated loopback listeners and verifies that existing management
reads remain passive and reject writes. It does not exercise the proposed
update exchange. The two new test files in the file map do not exist yet; run
them with `bun test tests/clients/link-update-child-initiated.test.ts
tests/server/link-update-exchange.test.ts` only after creating and registering
them, and record initial red and final green separately.
