# Phase 2: Passthrough Token Override (20-29)

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

PABCD 2턴: adapter/ws-bridge에서 계정 토큰 교체 + 세션 어피니티

## Scope

- src/adapters/openai-responses.ts — buildRequest에 override 주입
- src/ws-bridge.ts — selectForwardHeaders에 override 파라미터
- src/server.ts — 세션 어피니티 Map + override 주입 로직

## Depends on

Phase 1 완료 (CodexAccount types + codex-account-store.ts)

## Files

### MODIFY src/adapters/openai-responses.ts (81 lines → ~106 lines)

buildRequest의 `if (provider.authMode === "forward")` 블록 끝에 추가:

```ts
// BEFORE (현재 코드, line 54-61):
if (provider.authMode === "forward") {
  url = `${provider.baseUrl}/responses`;
  if (provider.headers) Object.assign(headers, provider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = incoming?.headers.get(h);
    if (v) headers[h] = v;
  }
}

// AFTER:
if (provider.authMode === "forward") {
  url = `${provider.baseUrl}/responses`;
  if (provider.headers) Object.assign(headers, provider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = incoming?.headers.get(h);
    if (v) headers[h] = v;
  }
  // Multi-account: server.ts injects override when a pool account is active.
  const override = (provider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
  if (override) {
    headers["authorization"] = `Bearer ${override.accessToken}`;
    headers["chatgpt-account-id"] = override.chatgptAccountId;
  }
}
```

왜 `_codexAccountOverride`인가: adapter는 stateless. config/store를 import하지 않는다.
server.ts가 요청마다 provider를 clone하면서 override를 주입한다.

### MODIFY src/ws-bridge.ts (362 lines → ~377 lines)

selectForwardHeaders 시그니처 확장:

```ts
// BEFORE (line 28):
export function selectForwardHeaders(headers: Headers): Headers {

// AFTER:
export function selectForwardHeaders(
  headers: Headers,
  codexOverride?: { accessToken: string; chatgptAccountId: string },
): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (codexOverride) {
    selected.set("authorization", `Bearer ${codexOverride.accessToken}`);
    selected.set("chatgpt-account-id", codexOverride.chatgptAccountId);
  }
  return selected;
}
```

기존 호출부 (server.ts line 742)는 두번째 인자 없으면 undefined → 기존 동작 유지.

### MODIFY src/server.ts — 세션 어피니티 + override 주입

server.ts 상단에 in-memory state 추가:

```ts
// request handler 바깥, module scope:
const threadAccountMap = new Map<string, string>();

function resolveCodexAccountForThread(
  threadId: string | null,
  config: OcxConfig,
): string | null {
  // 1. 기존 thread에 할당된 계정 있으면 유지 (session affinity)
  if (threadId && threadAccountMap.has(threadId)) {
    return threadAccountMap.get(threadId)!;
  }
  // 2. activeCodexAccountId 설정 있으면 사용
  const active = config.activeCodexAccountId;
  if (!active) return null; // null = passthrough as-is (main account)
  // 3. 새 thread에 계정 할당
  if (threadId) threadAccountMap.set(threadId, active);
  return active;
}
```

/v1/responses POST handler (line ~160 근처)에서 forward-mode일 때:

```ts
// route.provider.authMode === "forward" 조건 추가:
if (route.provider.authMode === "forward") {
  const threadId = req.headers.get("x-codex-parent-thread-id");
  const accountId = resolveCodexAccountForThread(threadId, config);
  if (accountId) {
    const { getValidCodexToken } = await import("./codex-account-store");
    const override = await getValidCodexToken(accountId);
    route.provider = { ...route.provider, _codexAccountOverride: override } as any;
  }
}
```

WebSocket upgrade (line ~742)에서도 동일:

```ts
// 현재:
if (server.upgrade(req, { data: { headers: selectForwardHeaders(req.headers) } }))

// 변경:
const wsThreadId = req.headers.get("x-codex-parent-thread-id");
const wsAccountId = resolveCodexAccountForThread(wsThreadId, config);
let wsOverride: { accessToken: string; chatgptAccountId: string } | undefined;
if (wsAccountId) {
  const { getValidCodexToken } = await import("./codex-account-store");
  wsOverride = await getValidCodexToken(wsAccountId);
}
if (server.upgrade(req, { data: { headers: selectForwardHeaders(req.headers, wsOverride) } }))
```

## Verification

- bun run typecheck
- 기존 passthrough 테스트 회귀 없음
- NEW test: override 주입 시 authorization/chatgpt-account-id 교체 확인
- NEW test: threadAccountMap 어피니티 (같은 thread-id → 같은 account)

## Commits

```
feat: inject codex account override in passthrough adapter
feat: add session affinity for multi-account thread mapping
```
