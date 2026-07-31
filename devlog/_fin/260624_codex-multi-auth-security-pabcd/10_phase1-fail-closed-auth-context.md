# 10 - Phase 1: Fail-Closed Auth Context

Status: implementation-ready plan.

## Objective

Once routing selects a pool account, upstream traffic must either authenticate as that exact pool account or fail closed. It must never silently use inbound/main credentials.

## Planned Changes

### NEW `src/codex-auth-context.ts`

Add a small module that owns request-level auth context.

Types:

```ts
export type CodexAuthContext =
  | { kind: "main" }
  | {
      kind: "pool";
      accountId: string;
      accessToken: string;
      chatgptAccountId: string;
      providerLabel: string;
    };

export type CodexSocketBinding =
  | { kind: "main" }
  | { kind: "pool"; accountId: string; generation: number };
```

Functions:

- `resolveCodexAuthContext(req, config, providerName)`:
  - reads `x-codex-parent-thread-id`;
  - uses `resolveCodexAccountForThread()`;
  - returns `{ kind: "main" }` if no active pool account exists;
  - calls `getValidCodexToken(accountId)` when a pool account is selected;
  - on credential failure, marks reauth and throws a typed fail-closed error.
- `applyCodexAuthContextToProvider(provider, ctx)`:
  - injects `_codexAccountOverride` only for `ctx.kind === "pool"`.

Add `handleResponses(..., options?: { authContext?: CodexAuthContext; socketBinding?: CodexSocketBinding })` or equivalent so WebSocket frames can carry the upgrade-time account decision instead of re-routing per frame.

### MODIFY `src/server.ts`

Replace the current `selectedCodexAccountId` block with `CodexAuthContext`.

Before:

```ts
selectedCodexAccountId = resolveCodexAccountForThread(threadId, config);
try { ... } catch { markAccountNeedsReauth(...); selectedCodexAccountId = null; }
```

After:

```ts
const authCtx = await resolveCodexAuthContext(req, config, route.providerName);
route.provider = applyCodexAuthContextToProvider(route.provider, authCtx);
logCtx.provider = formatCodexProviderFromAuthContext(route.providerName, authCtx, config);
```

Quota and upstream outcome recording must use the auth context, not a separate selected id.

### MODIFY `src/ws-bridge.ts`

Stop storing generic inbound auth as the durable WS account decision when a pool account is selected.

Add:

- `selectForwardHeadersForAuthContext(headers, ctx)`;
- `WsData.socketBinding` for `{ kind: "main" }` or `{ kind: "pool"; accountId; generation }`;
- frame handling must call `handleResponses()` with the socket binding/auth context so the frame cannot silently choose another account;
- no fallback to inbound main when `ctx.kind === "pool"`.

### MODIFY `src/adapters/openai-responses.ts`

If provider metadata says a pool account is required, `buildRequest()` must reject when `_codexAccountOverride` is missing. This creates a second guardrail in addition to `server.ts`.

### MODIFY Sidecar Upstream Calls

Pool-bound turns can also trigger auxiliary upstream calls. These must consume `CodexAuthContext`, not raw inbound request headers.

Affected modules/functions:

- `src/server.ts` sidecar planning/response integration around vision and web-search calls;
- `src/vision/index.ts` `planVisionSidecar()`;
- `src/vision/describe.ts` `describeImagesInPlace()`;
- `src/web-search/index.ts` `planWebSearch()`;
- `src/web-search/executor.ts` `runWebSearch()`;
- `src/web-search/loop.ts` `runWithWebSearch()`.

Rules:

- for `ctx.kind === "pool"`, sidecars must use the same selected pool credential/account id or fail closed/disable the sidecar for that turn;
- sidecars must not copy inbound `authorization` or `chatgpt-account-id` when a pool account is selected;
- adapter-level pool-required checks also apply to sidecar providers.

### Tests

Update/add:

- `tests/passthrough-override.test.ts`
- `tests/ws-endpoint.test.ts`
- new `tests/codex-auth-context.test.ts`

Required cases:

- HTTP: active pool + inbound main auth + failed pool token = no upstream call using main.
- HTTP: successful pool token = upstream uses pool token and account id.
- WS: active pool + failed token = upgrade or frame fails closed.
- Adapter: pool-required provider with missing `_codexAccountOverride` rejects before copying inbound auth.
- Vision sidecar: active pool + inbound main auth + missing/failed pool token = no sidecar fetch using main auth.
- Web-search sidecar: active pool + inbound main auth + missing/failed pool token = no sidecar fetch using main auth.
- Logs/quota/health use actual context.

## Verification

```bash
bun test tests/passthrough-override.test.ts tests/ws-endpoint.test.ts tests/codex-auth-context.test.ts
bun run typecheck
```
