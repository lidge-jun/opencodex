# 10 - Phase 10 Execution: Fail-Closed Codex Auth Context

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Implement the first security slice from `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md`: when routing selects a Codex pool account, HTTP, WebSocket, passthrough adapter, vision sidecar, and web-search sidecar must either use that exact pool credential or fail closed. They must not silently fall back to inbound/main credentials.

This slice intentionally does not implement Phase 20 generation/tombstones, Phase 30 local API auth, or Phase 50 outcome taxonomy.

## File Plan

### NEW `src/codex-auth-context.ts`

Add the request-level account boundary owner:

```ts
export type CodexAuthContext =
  | { kind: "main"; accountId: null }
  | {
      kind: "pool";
      accountId: string;
      accessToken: string;
      chatgptAccountId: string;
    };
```

Functions:

- `resolveCodexAuthContext(headers, config)`:
  - selects the Codex account boundary from `x-codex-parent-thread-id` and `resolveCodexAccountForThread()` before any forward auth headers are copied;
  - runs independently of the routed provider, because non-forward routed providers may still use the forward ChatGPT backend through vision/web-search sidecars;
  - returns `main` only when no pool account is selected;
  - calls `getValidCodexToken()` for selected pool accounts;
  - on token failure, marks reauth and throws `CodexAuthContextError`.
- `applyCodexAuthContextToProvider(provider, ctx)`:
  - returns a runtime provider copy;
  - adds `_codexAccountOverride` and `_codexAccountRequired` only when `ctx.kind === "pool"` and the provider uses the forward `openai-responses` path.
- `headersForCodexAuthContext(incomingHeaders, ctx)`:
  - main: preserves current selected forward headers;
  - pool: returns selected headers with pool token/account id and no fallback.
- `CodexAuthContextError`:
  - carries a safe message and account id for internal state updates;
  - maps in `server.ts` to a fail-closed 401 `authentication_error` before any upstream fetch.

### MODIFY `src/codex-auth-context.ts` Runtime Type

Keep persisted `OcxProviderConfig` free of token-bearing runtime fields. Add a local runtime extension type:

```ts
export type OcxRuntimeProviderConfig = OcxProviderConfig & {
  _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
  _codexAccountRequired?: boolean;
};
```

Do not add `_codexAccountOverride` or `_codexAccountRequired` to persisted `OcxProviderConfig`.

### MODIFY `src/server.ts`

Before:

```ts
let selectedCodexAccountId: string | null = null;
if (route.provider.authMode === "forward") {
  selectedCodexAccountId = resolveCodexAccountForThread(...);
  try { route.provider = { ...route.provider, _codexAccountOverride: override }; }
  catch { markAccountNeedsReauth(...); selectedCodexAccountId = null; }
}
```

After:

```ts
const authCtx = options.authContext ?? await resolveCodexAuthContext(req.headers, config);
const selectedForwardHeaders = options.selectedForwardHeaders ?? headersForCodexAuthContext(req.headers, authCtx);
route.provider = applyCodexAuthContextToProvider(route.provider, authCtx);
logCtx.provider = formatCodexProviderForLog(route.providerName, authCtx.kind === "pool" ? authCtx.accountId : null, config);
```

Extend `handleResponses()` options with:

```ts
{
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  authContext?: CodexAuthContext;
  selectedForwardHeaders?: Headers;
}
```

Rules:

- normal HTTP resolves `authCtx` once before adapter or sidecar code can copy forward headers;
- WebSocket frames use the `authContext` and `selectedForwardHeaders` stored at upgrade time and must not call `resolveCodexAuthContext()` again;
- all forward-auth consumers receive `selectedForwardHeaders`, never raw `req.headers`, once `authCtx.kind === "pool"`;
- catch `CodexAuthContextError` in HTTP and return a fail-closed 401 before upstream fetch;
- use the pool account id for quota/upstream outcome recording only for Codex forward/passthrough upstream responses, not unrelated non-forward provider responses.

WebSocket:

- resolve auth context at upgrade;
- fail upgrade if selected pool token fails;
- store both `authContext` and `headersForCodexAuthContext(req.headers, authCtx)` in `WsData`;
- pass stored `authContext` and `selectedForwardHeaders` to `handleResponses()` for each frame so frame handling cannot re-route to another account.

### MODIFY `src/ws-bridge.ts`

- Keep `selectForwardHeaders()` backward-compatible for main/inbound mode.
- Add `selectForwardHeadersForAuthContext(headers, ctx)` as a thin delegate to `headersForCodexAuthContext()` or implement identical rules from the same `FORWARD_HEADERS` allowlist.
- In pool mode, inbound `authorization` and inbound `chatgpt-account-id` must never be used as fallback values.
- Extend `WsData` with optional `authContext`.

### MODIFY `src/adapters/openai-responses.ts`

Before:

```ts
for (const h of FORWARD_HEADERS) copy inbound headers;
if (override) replace auth;
```

After:

Rules:

- if `_codexAccountRequired` is true and `_codexAccountOverride` is missing, throw before copying any inbound `FORWARD_HEADERS`;
- if `_codexAccountRequired` is true and an override exists, set `authorization` and `chatgpt-account-id` from the override, never from inbound headers;
- main mode without `_codexAccountRequired` keeps the current header-forwarding behavior.

Main mode without `_codexAccountRequired` stays backward-compatible.

### MODIFY `src/vision/index.ts`, `src/vision/describe.ts`

- `planVisionSidecar()` should accept `CodexAuthContext` plus `selectedForwardHeaders`.
- Activation condition:
  - main mode requires selected headers with `authorization`;
  - pool mode requires `authCtx.kind === "pool"` and uses the pool-selected headers even if raw inbound headers are missing or belong to main.
- `describeImagesInPlace()` / `describeImage()` should receive `selectedForwardHeaders`, not raw inbound headers.
- Pool token resolution failure happens before sidecar planning; after that, pool sidecars must use selected pool headers or not fetch at all.

### MODIFY `src/web-search/index.ts`, `src/web-search/executor.ts`, `src/web-search/loop.ts`

- `planWebSearch()` should accept `CodexAuthContext` plus `selectedForwardHeaders`.
- `runWithWebSearch()` and `runWebSearch()` should use `selectedForwardHeaders`.
- The routed-provider loop and sidecar search fetches must not copy inbound auth when `ctx.kind === "pool"`.

## Test Plan

Add/update:

- `tests/codex-auth-context.test.ts`
- `tests/passthrough-override.test.ts`
- `tests/web-search.test.ts`
- `tests/sidecar-abort.test.ts`
- `tests/ws-endpoint.test.ts`

Required cases:

- HTTP pool token failure with inbound main auth returns fail-closed error and no upstream request.
- HTTP successful pool token uses pool token/account id.
- adapter rejects pool-required provider without override before copying inbound auth.
- main forward mode without pool remains backward-compatible.
- WebSocket pool token failure rejects upgrade or frame path without main fallback.
- vision/web-search sidecars receive pool selected headers, not inbound main headers.
- routed non-forward request with active pool and web-search sidecar uses pool selected headers even when inbound/main auth is present.
- routed non-forward request with active pool and vision sidecar uses pool selected headers even when inbound/main auth is present.
- sidecar-needed routed request with selected pool token failure returns fail-closed and performs no sidecar fetch with inbound/main headers.
- WebSocket upgrade stores one immutable auth context; later frames do not re-run account selection or switch to another account.
- runtime `_codexAccount*` fields cannot be persisted through provider config APIs because they do not live on persisted `OcxProviderConfig`.

## Verification

```bash
git diff --check
bun run typecheck
bun test tests/codex-auth-context.test.ts tests/passthrough-override.test.ts tests/web-search.test.ts tests/sidecar-abort.test.ts tests/ws-endpoint.test.ts
bun test tests
cd gui && bun run build
```

## Implementation Evidence

Changed source:

- `src/codex-auth-context.ts`
- `src/server.ts`
- `src/adapters/openai-responses.ts`
- `src/ws-bridge.ts`
- `src/vision/index.ts`
- `src/vision/describe.ts`
- `src/web-search/index.ts`
- `src/web-search/executor.ts`
- `src/web-search/loop.ts`

Changed regression tests:

- `tests/codex-auth-context.test.ts`
- `tests/passthrough-override.test.ts`
- `tests/web-search.test.ts`
- `tests/sidecar-abort.test.ts`

Implemented behavior:

- selected Codex pool account auth is resolved before forward headers can be copied;
- failed pool token resolution marks reauthentication and returns fail-closed auth failure instead of dropping to inbound/main auth;
- passthrough adapter rejects a pool-required runtime provider when no pool override exists;
- WebSocket upgrade stores one auth context and selected forward header set for later frames;
- vision and web-search sidecars use selected forward headers instead of raw request headers;
- provider logs keep safe ordinal labels through `formatCodexProviderForLog()`.
- auth failure stderr logs avoid exact account ids and avoid propagating token-refresh error text;
- provider management saves strip runtime-only `_codexAccount*` fields before persistence.

## Verification Results

Fresh local verification on 2026-06-24:

```bash
bun test tests/codex-auth-context.test.ts tests/passthrough-override.test.ts tests/web-search.test.ts tests/sidecar-abort.test.ts tests/ws-endpoint.test.ts
```

Result: 39 pass, 0 fail.

After independent verification findings were fixed:

```bash
bun test tests/codex-auth-context.test.ts tests/passthrough-override.test.ts tests/web-search.test.ts tests/sidecar-abort.test.ts tests/ws-endpoint.test.ts
```

Result: 41 pass, 0 fail.

```bash
bun run typecheck
```

Result: `tsc --noEmit` passed.

```bash
bun test tests
```

Initial result: 253 pass, 0 fail.

After independent verification findings were fixed: 255 pass, 0 fail.

```bash
cd gui && bun run build
```

Result: production build passed.

```bash
git diff --check
```

Result: no whitespace errors.

## Independent Verification Follow-Up

Read-only Backend verification returned DONE for the core fail-closed behavior and raised follow-up issues:

- exact local account ids were present in stderr auth-failure logs;
- runtime `_codexAccount*` fields were type-only excluded but not stripped at provider-save boundaries;
- additional HTTP/WS integration coverage remains useful for future phases.

Fixed in this phase:

- `CodexAuthContextError` now exposes a generic message without embedding local account ids or token-refresh error text;
- HTTP and WebSocket auth-failure logs use safe provider/account ordinals rather than raw ids;
- `stripCodexRuntimeProviderFields()` removes token-bearing runtime metadata before provider persistence;
- regression tests assert the generic error message and runtime-field stripping.

Residual coverage note:

- Dedicated HTTP/WS integration tests for fail-closed upgrade/request behavior are still planned as part of later account-lifecycle and transport-hardening phases. Current Phase 10 has unit/adapter/sidecar coverage plus source-level independent verification for the WebSocket immutable context path.

## Commit Boundary

One implementation commit for Phase 10 after tests pass. Do not mix Phase 20 lifecycle or Phase 30 local API auth changes into this commit.
