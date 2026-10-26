# OCX-3: `/readyz` advertises peer features

Producer side of the GOAT hub design (goat-si/goat#684, ADR-0021, `261021_goatclaw_hub/000_design.md` §5 and
brief OCX-3). Peers decide compatibility from `features` instead of parsing versions.

## Current state

- `GET /readyz` (`src/server/index/serve-options.ts`) spreads `readyProtocolMetadata(config, req)` from
  `src/remote/protocol.ts` into its body. `RemoteReadyMetadata.features?: string[]` already exists and
  `parseRemoteReadyMetadata` validates it (at most 64 unique non-empty strings, each at most 80 chars, no control
  characters), but no producer fills it.
- Relay auth version: `LINK_RELAY_AUTH_VERSION = "2"` in `src/link/relay-auth.ts`.
- Management routes are declared in `MANAGEMENT_ROUTES` (`src/server/management/route-registry.ts`), pure data
  reconciled against dispatch source by `tests/server/management-route-registry.test.ts`.
- The Remote Link management relay read table is `LINK_MANAGEMENT_READ_PATHS` (`src/link/management-routes.ts`).
- No `x-opencodex-served-by` header is emitted yet (OCX-2).

## Change

1. New `src/remote/features.ts`: one ordered registry `PEER_FEATURES`, each entry an id plus a predicate over a
   `PeerFeatureSources` snapshot read from the owning modules. `servedPeerFeatures(sources?)` returns the ids
   whose predicate holds, in registry order.
   - `quota-pool/1`: `MANAGEMENT_ROUTES` declares `GET /api/quota-pool` (OCX-1 turns it on by declaring the route,
     which the registry reconciliation test already forces).
   - `link-management-relay`: `LINK_MANAGEMENT_READ_PATHS` is non-empty.
   - `served-by-header`: `SERVED_BY_HEADER_EMITTED`, the emitter's descriptor in a new
     `src/remote/served-by.ts` (`false` until OCX-2, which flips it in the change that emits the header).
     A live test on an isolated server keeps it honest: `x-opencodex-served-by` is present on the
     `/readyz`, `/healthz` and unknown-`/v1/*` responses exactly when `/readyz` advertises the feature.
   - `relay-auth/<LINK_RELAY_AUTH_VERSION>` (currently `relay-auth/2`): always.
2. `readyProtocolMetadata` adds `features: servedPeerFeatures()` (computed once; the sources are build constants).
3. Tests in a new `tests/server/readyz-features.test.ts` (registered in layout + expected fixture): registry
   presence/absence follows each source, ids are unique and survive `parseRemoteReadyMetadata`, the live
   `/readyz` body carries exactly the registry output and nothing account-shaped. Update the exact-shape
   assertions line-neutrally in `tests/server/proxy-liveness.test.ts` (two `readyProtocolMetadata` `toEqual`s)
   and `tests/server/server-live.test.ts:1442` (sorted key allowlist gains `features`; allowlist kept).
4. Docs: `structure/runtime.md` (owns `src/remote/`), `structure/remote-link.md` pointer for relay-auth,
   `docs-site` lifecycle `ocx ready` field list.

## Out of scope / open question

The Child machine listener (`src/client/machine-listener.ts`) answers its own `/readyz` with a different fixed
shape (`protocolVersion: 1`, no `features`). Whether a Child should advertise features, and which (it serves no
`/api/quota-pool` of its own), is a product decision reported back, not chosen here.

## Verification

typecheck; focused files (new test, proxy-liveness, management-route-registry, core-link-boundary,
core-lab-boundary, client-machine-listener, server-live); `bun run test:changed`; `bun run structure:check`;
`bun run privacy:scan`; full `bun run test` under `/usr/bin/lockf -t 3600 /tmp/ocx-heavy-test.lock`.
