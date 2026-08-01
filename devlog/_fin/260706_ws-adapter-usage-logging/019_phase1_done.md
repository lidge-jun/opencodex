# Phase 1 — D summary

Terminal outcome: DONE.

## Shipped

- `src/ws-bridge.ts`: WebSocket SSE pumping now exposes each non-`[DONE]` payload
  to an observation hook before forwarding. Successful JSON fallback responses that
  are synthesized into Responses events use the same observation path.
- `src/server.ts`: WebSocket `response.create` wires observed payloads into
  `inspectResponseLogSsePayload`, and terminal events finalize logs with
  `terminalStatus` plus `closeReason: "terminal"`.
- `tests/ws-endpoint.test.ts`: covers SSE payload observation and JSON fallback
  payload observation.
- `tests/server-auth.test.ts`: covers routed Anthropic WebSocket usage logging with
  cache read/create tokens and terminal metadata.

## A-gate result

`gpt-5.5` reviewer verdict: PASS.

Reviewer residual risk folded into B:

- Successful JSON fallback in `sendResponseToWebSocket` emitted terminal events but
  did not feed synthesized payloads to usage observation. This was not the live
  Anthropic incident path because the WebSocket handler forces `stream: true`, but it
  had the same re-framing-without-observation shape.

Remaining non-blocking note:

- Client-cancel fallback can still record 499 without `closeReason: "client_cancel"`.
  This is outside the reported 200/completed usage issue and does not affect cache
  token reporting.

## Verification

- `bun run typecheck` — pass (`bun x tsc --noEmit`, exit 0)
- `bun test tests/adapter-usage.test.ts tests/request-log.test.ts tests/ws-endpoint.test.ts tests/server-auth.test.ts` — pass, 99 tests / 0 fail / 287 expects

## Lifecycle guard

During this cxc-loop patch pass, no `ocx restart`, `ocx stop`, `ocx start`,
`ocx ensure`, or `ocx sync` command was run. Tests started only their own
ephemeral Bun servers on random ports.
