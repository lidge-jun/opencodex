# 22 - Phase 20C Plan: Account Lifecycle Completion

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Complete the remaining Patch 2 account-lifecycle security work after Phase 20A/20B:

- bind pool auth contexts to a credential generation;
- fail closed when a WebSocket or thread tries to reuse a deleted/replaced generation;
- invalidate open WebSockets for a deleted account;
- add a process-shared refresh lock around refresh-token rotation so two proxy processes sharing `OPENCODEX_HOME` do not use the same rotating refresh token concurrently;
- preserve the existing legacy credential compatibility and safe non-PII logging behavior.

This is still Patch 2. Local API authentication/safe DTOs remain Patch 3.

## External Security Notes

- RFC 9700 OAuth 2.0 Security BCP treats refresh-token rotation and replay detection as part of OAuth client hardening. For this project, that means stale or concurrent refresh completions must not overwrite newer credential state.
- OWASP API guidance treats API authentication as a separate control from browser-origin/CSRF checks. This phase does not implement Patch 3 API auth yet, but it must not make that future boundary harder.
- Bun WebSocket docs confirm `Bun.serve({ websocket: { open(ws), message(ws), close(ws) } })` and typed `ws.data` from `server.upgrade(req, { data })`, so a small socket registry can safely attach in `open` and detach in `close`.

## Acceptance Criteria

- `getValidCodexToken()` returns the live credential generation together with token material.
- A pool `CodexAuthContext` includes `generation`.
- `isCodexAuthContextUsable()` returns false when the account is deleted, replaced, tombstoned, missing, or marked reauth after the context was created.
- A WebSocket bound to a stale pool generation fails closed on the next request instead of reusing its old bearer header.
- Deleting an account aborts and closes any currently tracked WebSockets bound to that account.
- Refresh-token network calls for the same local account are guarded by:
  - the existing in-process single-flight map;
  - a config-directory lock file that serializes expired-token refreshes across processes;
  - a fresh post-lock credential read before using a refresh token.
- A second process that waits behind a refresh lock reuses the credential already refreshed by the first process if it became fresh while waiting.
- A stale refresh lock can be reclaimed after a bounded stale window.
- No public config/account DTO or request log starts exposing access tokens, refresh tokens, emails, or raw local account ids.

## File Plan

### MODIFY `src/types.ts`

No new exported public config type is required. Keep `CodexAccountCredentialRecord` from Phase 20B unchanged.

### MODIFY `src/codex-account-store.ts`

Add imports:

```ts
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
```

Keep the public projection API stable.

Add constants:

```ts
const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_WAIT_MS = REFRESH_LOCK_STALE_MS + 5_000;
const REFRESH_LOCK_POLL_MS = 50;
```

Add helpers:

```ts
function codexRefreshLockPath(id: string): string;
function sleep(ms: number): Promise<void>;
async function withCodexRefreshFileLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
export function isCodexAccountGenerationLive(id: string, generation: number): boolean;
export class CodexCredentialRefreshLockTimeoutError extends Error;
```

Lock details:

- lock filename uses `sha256(id)` so raw aliases are not written into filenames;
- `openSync(path, "wx", 0o600)` acquires;
- lock file contains only JSON `{ acquiredAt, pid }`;
- stale lock detection parses `acquiredAt`; malformed or older-than-stale locks can be unlinked and retried;
- wait loop errors with `CodexCredentialRefreshLockTimeoutError` after the wait budget, not `TokenRefreshError`, so lock contention does not mark an account reauth-needed;
- `REFRESH_LOCK_WAIT_MS` is longer than `REFRESH_LOCK_STALE_MS` so a crashed holder can become reclaimable before waiters give up;
- `finally` closes the fd and removes the lock file.

Change `CodexTokenResult` to:

```ts
type CodexTokenResult = { accessToken: string; chatgptAccountId: string; generation: number };
```

Change `getValidCodexToken()`:

1. Read the current record.
2. If credential is still fresh, return token material plus current generation without taking the file lock.
3. If expired, keep the existing `refreshLocks` in-process single-flight.
4. Inside the refresh promise, acquire `withCodexRefreshFileLock(id, ...)`.
5. Re-read the record inside the file lock.
6. If another process already refreshed it, return the fresh token plus that newer generation.
7. Otherwise refresh with the current refresh token.
8. Persist with `saveCodexAccountCredentialIfGeneration()`.
9. Return generation `startGeneration + 1`.

### MODIFY `src/codex-auth-context.ts`

Change pool context:

```ts
{
  kind: "pool";
  accountId: string;
  generation: number;
  accessToken: string;
  chatgptAccountId: string;
}
```

`resolveCodexAuthContext()` copies `generation` from `getValidCodexToken()`.

When `getValidCodexToken()` throws `CodexCredentialRefreshLockTimeoutError`, return a fail-closed `CodexAuthContextError` but do not call `markAccountNeedsReauth(accountId)`. This mirrors the generation-conflict path: lock contention is not proof that the stored credential is revoked.

`isCodexAuthContextUsable()` checks both:

- `isCodexAccountUsable(config, ctx.accountId)`;
- `isCodexAccountGenerationLive(ctx.accountId, ctx.generation)`.

This makes stale WebSocket contexts fail closed even if they still hold selected forward headers.

### NEW `src/codex-websocket-registry.ts`

Create a tiny runtime registry:

```ts
import type { ServerWebSocket } from "bun";
import type { WsData } from "./ws-bridge";

export function registerCodexWebSocket(ws: ServerWebSocket<WsData>): void;
export function unregisterCodexWebSocket(ws: ServerWebSocket<WsData>): void;
export function invalidateCodexWebSocketsForAccount(accountId: string): number;
export function getTrackedCodexWebSocketCountForAccount(accountId: string): number;
export function clearCodexWebSocketRegistry(): void;
```

Behavior:

- only pool-bound sockets are tracked;
- registry key is account id in memory only, never logged;
- invalidation calls `ws.data.cancel?.()` and then `ws.close(4001, "Codex account invalidated")`;
- invalidation removes sockets from the registry even if `close()` throws;
- `clearCodexWebSocketRegistry()` is test-only cleanup.

### MODIFY `src/server.ts`

Import registry:

```ts
import { registerCodexWebSocket, unregisterCodexWebSocket } from "./codex-websocket-registry";
```

In `websocket` handlers:

```ts
open(ws) {
  registerCodexWebSocket(ws);
},
close(ws) {
  unregisterCodexWebSocket(ws);
  ws.data.cancel?.();
},
```

Keep existing message path. The generation check in `handleResponses()` is the fail-closed guard for stale contexts.

### MODIFY `src/codex-account-lifecycle.ts`

Import:

```ts
import { invalidateCodexWebSocketsForAccount } from "./codex-websocket-registry";
```

In `deleteCodexAccount()`:

1. tombstone credential;
2. remove config/active selection;
3. purge quota/health/reauth/affinity;
4. invalidate sockets bound to the account.

No returned API shape changes are required.

### MODIFY `src/codex-auth-api.ts`

In `fetchPoolAccountQuota()`, treat `CodexCredentialRefreshLockTimeoutError` the same way as a generation conflict:

```ts
return { quota: existing ?? null, needsReauth: false };
```

`TokenRefreshError` remains the only refresh-store exception in this area that can set `needsReauth: true`.

### MODIFY Tests

Update `tests/codex-account-store.test.ts`:

- fresh token result includes generation;
- refreshed token result includes bumped generation;
- waiting behind a simulated file lock re-reads and returns another process's already-refreshed credential without calling fetch;
- stale lock is reclaimed.

Update `tests/codex-auth-context.test.ts`:

- resolved pool context includes generation;
- replacing a credential after context resolution makes `isCodexAuthContextUsable()` false;
- deleting/tombstoning after context resolution makes `isCodexAuthContextUsable()` false;
- generation conflict still does not mark reauth.
- refresh-lock timeout does not mark reauth.

Update `tests/codex-auth-api.test.ts`:

- quota refresh lock timeout returns `needsReauth: false`.
- generation conflict still returns `needsReauth: false`.

Add `tests/codex-websocket-registry.test.ts`:

- registers only pool sockets;
- unregister removes socket;
- invalidating an account aborts and closes all sockets for that account;
- invalidating one account does not touch sockets for another account;
- registry uses no durable logs and exposes only counts.

Update any existing tests that construct `CodexAuthContext` literals by adding `generation`.

Known current pool-context literal files to update:

- `tests/codex-auth-context.test.ts`
- `tests/sidecar-abort.test.ts`
- `tests/web-search.test.ts`

Server-level stale WebSocket behavior is covered by the same `handleResponses()` guard path because WebSocket frames pass `options.authContext` into `handleResponses()`. Add a focused unit assertion for `isCodexAuthContextUsable()` after replacement/deletion in this phase, and rely on existing `tests/ws-endpoint.test.ts` plus full-suite coverage to catch WebSocket type/path regressions.

## Verification

Run:

```bash
bun test tests/codex-account-store.test.ts tests/codex-auth-context.test.ts tests/codex-websocket-registry.test.ts tests/codex-auth-api.test.ts tests/ws-endpoint.test.ts
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
```

## Implementation Evidence

Changed source:

- `src/codex-account-store.ts`
- `src/codex-auth-context.ts`
- `src/codex-auth-api.ts`
- `src/codex-websocket-registry.ts`
- `src/server.ts`
- `src/codex-account-lifecycle.ts`

Changed tests:

- `tests/codex-account-store.test.ts`
- `tests/codex-auth-context.test.ts`
- `tests/codex-auth-api.test.ts`
- `tests/codex-websocket-registry.test.ts`
- `tests/sidecar-abort.test.ts`
- `tests/web-search.test.ts`

Implemented behavior:

- `getValidCodexToken()` now returns credential generation with token material.
- Expired-token refreshes use the in-process single-flight map plus a config-directory lock file keyed by `sha256(accountId)`.
- Refresh lock waiters re-read credential state after acquiring the file lock and reuse a fresh credential produced by another process instead of reusing the old refresh token.
- Stale refresh lock files are reclaimable.
- Lock timeout uses `CodexCredentialRefreshLockTimeoutError`, not `TokenRefreshError`, so lock contention does not mark an account reauth-needed.
- Pool auth contexts carry `generation`; stale generation contexts fail `isCodexAuthContextUsable()`.
- Deleting an account invalidates registered pool WebSockets through cancel + close.

## Verification Results

Fresh local verification on 2026-06-24:

```bash
bun run typecheck
```

Result: `tsc --noEmit` passed.

```bash
bun test tests/codex-account-store.test.ts tests/codex-auth-context.test.ts tests/codex-websocket-registry.test.ts tests/codex-auth-api.test.ts tests/ws-endpoint.test.ts tests/sidecar-abort.test.ts tests/web-search.test.ts
```

Result: 90 pass, 0 fail.

```bash
bun test tests
```

Result: 276 pass, 0 fail.

```bash
cd gui && bun run build
```

Result: production build passed.

```bash
git diff --check
```

Result: no whitespace errors.

Independent build verification is still pending for this phase.

## Independent Verification

Backend read-only verification result: DONE.

Evidence:

- `bun x tsc --noEmit`: exit 0.
- Focused verifier tests: 60 pass, 0 fail.
- Verified source paths:
  - `src/codex-account-store.ts`
  - `src/codex-auth-context.ts`
  - `src/codex-auth-api.ts`
  - `src/codex-account-lifecycle.ts`
  - `src/codex-websocket-registry.ts`
  - `src/server.ts`
- Verified test paths:
  - `tests/codex-account-store.test.ts`
  - `tests/codex-auth-context.test.ts`
  - `tests/codex-auth-api.test.ts`
  - `tests/codex-websocket-registry.test.ts`

Residual risks accepted for this phase:

- No end-to-end test waits for the full 65 second lock-timeout path; the non-reauth classifier and stale-lock/wait-behind-lock behavior are tested without slow sleeps.
- Bun WebSocket `open`/`close` hook wiring is verified by typecheck and code inspection; registry behavior itself is unit-tested.

## Deferred After This Phase

- Patch 3: local management/data-plane API authentication and safe DTOs.
- Patch 4: manual import identity validation or disable-by-default behavior.
- Patch 5: outcome taxonomy and quota freshness.
- P1 WebSocket cleanup beyond this phase: remove raw bearer material from long-lived socket data entirely by resolving pool token material per turn.

## Commit Boundary

One implementation commit for Phase 20C account lifecycle completion. Do not mix in Patch 3 API authentication or Patch 4 manual import changes.
