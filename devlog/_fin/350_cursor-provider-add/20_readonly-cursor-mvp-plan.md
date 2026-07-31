# 350.20 — PLAN: Cursor read-only MVP via PABCD

Date: 2026-06-26

## Goal

Implement a Cursor provider MVP in opencodex that can route normal text turns through Cursor while keeping the native Cursor exec bridge read-only by default.

Safety boundary:

- Allowed exec cases: `requestContextArgs`, `readArgs`, `lsArgs`, `grepArgs`.
- Denied exec cases: `writeArgs`, `deleteArgs`, `shellArgs`, `shellStreamArgs`, `diagnosticsArgs`, `mcpArgs`, `fetchArgs`, `recordScreenArgs`, `computerUseArgs`, and unknown cases.
- Verification may use static/type checks and OCX read-only requests only. No destructive Cursor experiments.

## Existing source of truth reused

- `devlog/350_cursor-provider-add/00_overview.md`
- `devlog/350_cursor-provider-add/01_cursor-anatomy.md`
- `devlog/350_cursor-provider-add/02_opencodex-fit.md`
- `devlog/350_cursor-provider-add/04_risks-and-decisions.md`
- `devlog/350_cursor-provider-add/10_impl_transport.md`
- `devlog/350_cursor-provider-add/11_impl_oauth.md`
- `devlog/350_cursor-provider-add/12_impl_adapter-runturn.md`
- `devlog/350_cursor-provider-add/13_impl_discovery-models.md`
- `devlog/350_cursor-provider-add/14_impl_integration-config-tests.md`

## Threat model

Trust boundary: Cursor model/server can ask the local host to execute native tool requests.

Protected assets:

- User filesystem.
- Shell environment and credentials.
- Local MCP servers.
- Codex/opencodex config and OAuth tokens.

Main risk: Cursor server-originated exec requests gaining write/delete/shell/MCP capability.

Mitigation: default-deny exec policy, allowlist only read-only handlers, never implement shell/write/delete in this MVP, and verify with read-only requests only.

## Planned file changes

### MODIFY `src/adapters/base.ts`

Add optional `runTurn` hook and `abortSignal` metadata.

Before:

```ts
export interface IncomingMeta {
  headers: Headers;
}

export interface ProviderAdapter {
  name: string;

  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };

  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
}
```

After:

```ts
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
  workspaceRoot?: string;
}

export interface ProviderAdapter {
  name: string;

  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };

  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
  runTurn?(
    parsed: OcxParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
```

### NEW `src/adapters/run-turn-queue.ts`

Purpose: adapt callback-pushed `AdapterEvent`s from bidirectional transports into an `AsyncIterable<AdapterEvent>` for `bridgeToResponsesSSE`, and collect events for non-streaming JSON responses.

Exports:

- `AdapterEventQueue`
- `createAdapterEventQueue()`

### MODIFY `src/server.ts`

Changes:

- Import `createCursorAdapter`.
- Import `createAdapterEventQueue`.
- Add `case "cursor"` to `resolveAdapter`.
- Add helper `buildToolBridgeMaps(parsed)`.
- Before the regular `buildRequest` / `fetch` path, detect `adapter.runTurn` and bridge it into existing streaming/non-streaming Responses output.

Behavior:

- Existing adapters remain on the current fetch path.
- `runTurn` adapters own their transport.
- Client cancellation aborts the `runTurn` metadata signal and closes the queue.
- `runTurn` dispatch happens before web-search sidecar and before any branch that calls `adapter.buildRequest`, because Cursor cannot use the normal REST/SSE fetch path.
- `workspaceRoot` is resolved once per request from provider config and passed to `runTurn`; if no trusted root is configured, read-only exec handlers must deny all filesystem access.

### MODIFY `src/types.ts`

Add Cursor-specific local safety config to `OcxProviderConfig`.

```ts
export interface OcxProviderConfig {
  // ...
  cursorWorkspaceRoot?: string;
  cursorReadOnlyExec?: boolean;
}
```

Semantics:

- `cursorWorkspaceRoot` is a local absolute path configured by the user/admin. It is never accepted from the incoming model request.
- `cursorReadOnlyExec` defaults to `false` until Phase 3 is implemented. When true, only read/ls/grep are candidates for allowlisting and still require `cursorWorkspaceRoot`.
- No mutation-capable Cursor exec option is added in this MVP.

### NEW `src/adapters/cursor/framing.ts`

Purpose: Connect frame encode/decode for Cursor HTTP/2 streaming.

Exports:

- `CONNECT_END_STREAM_FLAG`
- `encodeConnectFrame(payload, flags?)`
- `decodeConnectFrames(buffer)`
- `parseConnectEndStream(payload)`

### NEW `src/adapters/cursor/transport.ts`

Purpose: Cursor HTTP/2 Connect transport wrapper.

Exports:

- `CursorTransport`
- `createCursorTransport(options)`

Behavior:

- Opens POST stream to Cursor Run-style endpoint.
- Writes framed protobuf client messages.
- Emits decoded server frames as async iterable.
- Supports abort/close.
- Does not implement exec policy; it only transports messages.

### NEW `src/adapters/cursor/discovery.ts`

Purpose: Cursor-specific model discovery for `src/codex-catalog.ts`.

Exports:

- `fetchCursorUsableModels(options)`
- Cursor model normalization helpers scoped to this module.

Behavior:

- Uses Cursor `GetUsableModels` over HTTP/2/protobuf.
- Returns `null` on discovery failure so catalog can fall back to static seed/stale cache.
- Never calls REST `/models`.

### NEW `src/adapters/cursor/exec-policy.ts`

Purpose: single owner for native exec safety.

Exports:

- `CURSOR_READONLY_EXEC_CASES`
- `CURSOR_DENIED_EXEC_CASES`
- `isCursorReadonlyExecCase(execCase)`
- `cursorExecDeniedMessage(execCase)`

Policy:

- Allow `requestContextArgs` handshake with empty valid context.
- Allow `readArgs`, `lsArgs`, `grepArgs` only when a trusted `workspaceRoot` exists.
- Resolve both `workspaceRoot` and requested target paths with `realpath`.
- Reject absent root, symlink escape, path traversal, binary files, oversized files, and denied secret/config paths.
- Deny all mutation, shell, diagnostics, MCP, fetch, screen, computer-use, and unknown exec cases.

### NEW `src/adapters/cursor/read-only-handlers.ts`

Purpose: audited implementation for read-only native Cursor exec replies.

Handlers:

- `handleRequestContextArgs`: returns empty rules/tools/repos.
- `handleReadArgs`: reads text files only within trusted root, with max byte cap and binary detection.
- `handleLsArgs`: lists directories only within trusted root, with entry cap and symlink escape rejection.
- `handleGrepArgs`: runs bounded file search using repository-local logic, not shell, with timeout and result cap.

Non-goals:

- No write.
- No delete.
- No shell.
- No MCP invocation.

### NEW `src/adapters/cursor/message-mapper.ts`

Purpose: map Cursor protobuf server messages to opencodex `AdapterEvent`s and route KV/exec replies through the transport.

Responsibilities:

- `interactionUpdate.textDelta` -> `text_delta`.
- `interactionUpdate.thinkingDelta` -> `thinking_delta`.
- turn end -> `done`.
- `kvServerMessage` -> in-memory blob get/set replies.
- `execServerMessage` -> read-only exec policy/handlers.

### NEW `src/adapters/cursor/request-builder.ts`

Purpose: build a minimal Cursor `AgentRunRequest` from `OcxParsedRequest`.

Scope:

- Text-only user/assistant history first.
- Blob store for system/history payloads needed by KV handshake.
- Stable per-turn conversation id unless caller supplies one later.

### NEW `src/adapters/cursor.ts`

Purpose: adapter factory.

Behavior:

- `buildRequest` and `parseStream` remain inert.
- `runTurn` resolves bearer token from OAuth/key/forwarded auth, builds Cursor request, creates transport, maps server messages to `AdapterEvent`.
- All exec requests go through `exec-policy.ts`.

### NEW `src/oauth/cursor.ts`

Purpose: Cursor PKCE login and token refresh.

Source: port from jawcode `packages/ai/src/utils/oauth/cursor.ts`.

Exports:

- `generateCursorAuthParams`
- `pollCursorAuth`
- `loginCursor`
- `refreshCursorToken`
- `isCursorTokenExpiringSoon`

### MODIFY `src/oauth/index.ts`

Add `cursor` to `OAUTH_PROVIDERS`.

### MODIFY `src/providers/registry.ts`

Add Cursor provider registry entry.

Constraints:

- `authKind: "oauth"`.
- `adapter: "cursor"`.
- `baseUrl: "https://api2.cursor.sh"`.
- Static seed models come from jawcode Cursor metadata where available. If reliable seed extraction is incomplete, ship a minimal non-featured provider entry and document live discovery as required.
- Do not set `cursorWorkspaceRoot` in the registry seed. It must be local user config.

### MODIFY `src/codex-catalog.ts`

Add `adapter === "cursor"` branch in model discovery.

Behavior:

- Do not call REST `/models` for Cursor.
- Use `fetchCursorUsableModels` from `src/adapters/cursor/discovery.ts` when OAuth token exists.
- Fall back to static seed models when logged out or discovery fails.

### MODIFY `src/index.ts`

Export `createCursorAdapter`.

### MODIFY `package.json`

Add protobuf runtime as a required dependency.

Expected dependency:

- `@bufbuild/protobuf`

Only add `@bufbuild/protoc-gen-es` if generation is added to this repo; do not add it for a pure vendored runtime file.

### NEW `src/adapters/cursor/gen/agent_pb.ts`

Purpose: vendored generated Cursor protobuf contracts from jawcode.

Rule:

- Keep generated code isolated under `src/adapters/cursor/gen`.
- Do not hand-edit generated message structures.
- The jawcode generated file is about 15k lines. If the project file-size rule is enforced for generated artifacts, replace this with a generated-at-build or minimal-schema strategy before committing. Do not hide a generated mega-file as hand-authored source.

### Tests / verification files

Add or update focused tests only for safe/read-only behavior:

- `tests/cursor-framing.test.ts`
- `tests/cursor-exec-policy.test.ts`
- `tests/cursor-readonly-handlers.test.ts`
- `tests/cursor-oauth.test.ts`
- `tests/run-turn-queue.test.ts`
- `tests/cursor-discovery.test.ts`
- `tests/cursor-server-dispatch.test.ts`

Live verification:

- Use OCX read-only request only after static checks pass and credentials are available.
- Do not test `write`, `delete`, `shell`, `shellStream`, `diagnostics`, `mcp`, `fetch`, `recordScreen`, `computerUse`, or unknown denied cases by sending live Cursor requests.
- Safe tests may instantiate policy/handler functions locally with fixtures to prove denial without contacting Cursor.
- Live smoke can prove denied requests are not executed; it cannot prove Cursor never attempted one. Logs/policy counters should distinguish attempted-vs-executed.

## Build phases

### Phase 1: restore safe scaffold

- Add `runTurn` contract, queue, server dispatch, cursor adapter shell.
- Commit after static verification.

### Phase 2: protocol + OAuth

- Add Cursor OAuth.
- Vendor protobuf.
- Add framing/transport/discovery.
- Commit after static verification and mocked/non-live tests.

### Phase 3: read-only exec policy

- Add requestContext/read/ls/grep handlers.
- Deny every mutation/shell/MCP case.
- Commit after read-only tests.

### Phase 4: Cursor text turn integration

- Add request builder and message mapper.
- Wire adapter `runTurn`.
- Commit after typecheck and safe mocked tests.

### Phase 5: OCX read-only smoke

- Start opencodex locally.
- Configure Cursor provider only if credential exists or OAuth login can be completed safely.
- Send read-only prompt/request through OCX.
- Verify no write/delete/shell/MCP request is sent or executed.

## Explicitly out of scope

- Full Cursor write bridge.
- Shell/shellStream bridge.
- Delete bridge.
- MCP bridge.
- Computer-use bridge.
- Background shell.
- Screen recording.

Those require separate approval and a dedicated security review.
