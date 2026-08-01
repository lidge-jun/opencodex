# Cycle 3: Explicit WebSocket Lifetime Policy

## Goal

Make the Bun WebSocket lifetime policy explicit for Windows stability follow-up work, without changing passthrough protocol behavior.

## Scope

- Add a named server-side WebSocket idle-timeout constant in `src/server.ts`.
- Configure `Bun.serve({ websocket: { idleTimeout: ... } })` explicitly instead of relying on Bun defaults.
- Keep existing HTTP `idleTimeout: 255` behavior unchanged.
- Add focused regression coverage that fails if the WebSocket block loses the explicit idle-timeout setting.

## Non-goals

- Do not redesign WebSocket protocol framing.
- Do not add a new heartbeat protocol in this cycle.
- Do not change Cursor/provider routing or auth behavior.

## Verification

- `bun test tests/ws-endpoint.test.ts tests/server-auth.test.ts`
- `bun x tsc --noEmit`
