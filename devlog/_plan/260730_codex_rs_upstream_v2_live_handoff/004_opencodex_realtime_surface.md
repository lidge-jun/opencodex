# 004 — OpenCodex realtime / live surface as it stands

Research only. No diffs. Read at branch `dev`, HEAD `959e9ff11`.

## Files that own this surface

| File | Lines | Role |
|---|---|---|
| `src/server/live.ts` | 548 | Live/realtime relay: target parsing, upstream URL construction, call creation |
| `src/server/index.ts` | 948 | Route registration, websocket upgrade, transparent frame relay |
| `src/server/ws-bridge.ts` | 446 | Websocket state and Responses reframing; no URL logic |
| `src/server/auth-cors.ts` | 437 | Admission, origin policy, protocol-header allowlist |

## What OpenCodex already does

It already has the canonical constant:

```
LIVE_SIDEBAND_API_ROOT = "https://api.openai.com/v1"   // live.ts:56
```

It already parses all three sideband target styles in `parseLiveSidebandTarget`
(`live.ts:179`): `/v1/live/{callId}` as `frameless-path`,
`/v1/realtime/calls/{callId}` as `realtime-calls-path`, and `/v1/realtime?call_id=`.
So the Frameless `/live` transport is recognized, not rejected.

It already routes `POST /v1/live` and `POST /v1/realtime/calls` (`index.ts:670`), and
relays sideband frames byte-for-byte in both directions without inspecting event type
(`index.ts:164` and `index.ts:764`). `OpenAI-Alpha` is in the CORS protocol-header
allowlist (`auth-cors.ts:123`), so `quicksilver=v2` passes through.

Because the relay is byte-transparent, V3 `delegation.*` frames already flow without
change. There is no event-type switch that would reject them.

## Where it diverges from upstream

`buildLiveSidebandUpstreamWsUrl` (`live.ts:204`) branches on `usesBackendShape`, which
is `baseUrl.includes("/backend-api")`:

- backend-shaped provider → canonical `LIVE_SIDEBAND_API_ROOT` (matches upstream)
- otherwise → derived from `providerBaseUrl` with only a trailing `/v1` stripped

Three concrete gaps follow:

1. **Canonical host is conditional.** Upstream always uses the Realtime API host for
   WebRTC sideband joins unless explicitly overridden. OpenCodex uses it only for the
   backend shape, so an API-key provider with a non-OpenAI base receives the sideband
   connection at that base.
2. **No explicit override.** `experimental_realtime_ws_base_url` has no OpenCodex
   equivalent; searching the four files finds nothing. There is therefore no way to
   express "canonical by default, this host for local development", which is exactly
   the precedence upstream ships.
3. **Provider query parameters are not excluded.** The code strips a trailing `/v1`
   from a string; it never parses the URL or clears `search`. A query-bearing provider
   base carries its query into the constructed sideband URL, which upstream explicitly
   stopped doing.

## What is absent (and whether it matters)

`delegation.*`, `initialItems` / `initial_items`, and `thread/realtime/start` do not
appear anywhere in the surface. For a byte-transparent relay this is mostly fine:
frames pass through regardless. It matters only if OpenCodex chooses to emulate
app-server-side validation, which would mean reproducing the four `initialItems`
error strings from `002` §B3.

Call creation does handle a `session` multipart field: it parses the JSON and forwards
it unchanged (`live.ts:262`), without recognizing the bootstrap schema, seeding items,
or enforcing limits. Pass-through is the correct default here; the bootstrap payload is
the provider's contract, not the proxy's.

## Risk summary

| # | Risk | Evidence |
|---|---|---|
| 1 | Sideband joins can target a non-canonical host for API-key providers | `live.ts:204` branch, `live.ts:223` derived form |
| 2 | No override knob for local development or tests | absence across all four files |
| 3 | Provider query params leak into sideband URLs | `live.ts:209` string-only trimming |
| 4 | No V3 protocol semantics, only transport | `live.ts:179` parse, `index.ts:164` relay |
| 5 | OpenCodex computes the target itself, so upstream's URL policy change directly affects the computed destination | `index.ts:714` → `liveUpstreamUrl` → `new WebSocket(url)` |

Risks 1-3 are addressed by work-phase 4 (`040`). Risk 4 is deliberately left alone:
transparent relay is the right behavior until OpenCodex hosts v3 session semantics
itself. Risk 5 is context, not a defect.
