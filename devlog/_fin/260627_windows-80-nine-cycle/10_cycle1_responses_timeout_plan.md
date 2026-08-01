# 260627 Cycle 1 — Responses Timeout Disable Plan

## Purpose

Disable Bun's per-request timeout for long-lived HTTP `/v1/responses` POST requests only. This addresses Windows quiet SSE stalls without changing `/api/*`, `/healthz`, `/v1/models`, static GUI, or WebSocket upgrade behavior.

## Planned Diff

### MODIFY `src/server.ts`

Add an exported helper near the server lifecycle helpers:

```ts
export function disableResponsesRequestTimeout(req: Request, server: Pick<Server, "timeout"> | undefined): boolean {
  try {
    server?.timeout(req, 0);
    return !!server;
  } catch {
    return false;
  }
}
```

Update the Bun fetch signature from:

```ts
async fetch(req): Promise<Response> {
```

to:

```ts
async fetch(req, requestServer): Promise<Response> {
```

Inside the HTTP POST `/v1/responses` branch, before auth/origin/upstream work:

```ts
disableResponsesRequestTimeout(req, requestServer);
```

Do not call this helper in the WebSocket upgrade branch.

### MODIFY `tests/server-auth.test.ts`

Import `disableResponsesRequestTimeout` from `../src/server` and add unit tests:

- returns true and calls `server.timeout(req, 0)` when a server object is present;
- returns false and does not throw when the server object is missing;
- returns false and does not throw when the runtime timeout call throws.

## Verification

```bash
bun test tests/server-auth.test.ts tests/bridge-lifecycle.test.ts
bun x tsc --noEmit
```

## Acceptance Criteria

- `/v1/responses` HTTP POST has a timeout-disable hook before long-running work.
- The helper is safe on runtimes where the timeout API is absent or throws.
- No management/static/model/WebSocket behavior changes.
- Focused tests and typecheck pass.
