# Phase 8: E2E Hardening + Error Handling (80-89)

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

PABCD 8턴: 엣지 케이스 처리, 에러 복구, 보안 강화

## Scope

- src/codex-account-store.ts — token refresh 실패 시 graceful fallback
- src/server.ts — account removed while session active 처리
- src/codex-auth-api.ts — input validation 강화
- gui/src/pages/CodexAuth.tsx — error states, loading states

## Edge Cases to Handle

### 1. Token refresh fails (account revoked)
```ts
// codex-account-store.ts getValidCodexToken:
// 현재: throw on fetch failure
// 변경: catch → mark account unhealthy → return null
// server.ts에서: null → fall back to main passthrough
```

### 2. Account removed while session active
```ts
// server.ts resolveCodexAccountForThread:
// threadAccountMap has accountId → but account was deleted
// getValidCodexToken throws "not found" → catch → remove from map → fall back to main
```

### 3. Server restart clears threadAccountMap
- Acceptable: new process = new cache anyway
- 문서화만 하면 됨

### 4. All pool accounts at threshold
```ts
// auto-switch: 모든 계정이 threshold 이상
// → 현재 계정 유지 (least-bad). 무한 순환 방지
```

### 5. Invalid chatgptAccountId in import
```ts
// POST /api/codex-auth/accounts: chatgptAccountId 비어있으면
// → wham/usage fetch 시 empty string 전달 → 실패하지만 token은 유효
// → 첫 passthrough 시 upstream이 account-id를 요구하면 실패
// → 검증 추가: import 시 wham/usage로 1회 probe
```

### 6. Concurrent requests race on token refresh
```ts
// codex-account-store.ts:
// 두 요청이 동시에 expired token 발견 → 둘 다 refresh
// → 두번째 refresh가 첫번째의 refresh_token을 무효화할 수 있음
// → 해결: per-account refresh lock (Promise-based)
const refreshLocks = new Map<string, Promise<{accessToken:string;chatgptAccountId:string}>>();

export async function getValidCodexToken(id: string) {
  const existing = refreshLocks.get(id);
  if (existing) return existing;
  // ... normal flow, but wrap in lock
}
```

## GUI Error States

### CodexAuth.tsx
- API 실패 시: "Could not load account info" 메시지
- Import 후 probe 실패: "Token may be invalid" 경고 (하지만 저장은 됨)
- Main account wham/usage 실패: email="Codex App login", quota=null (현재 동작 유지)

## Security Hardening

- [ ] codex-accounts.json: 파일 생성 시 0o600 확인 (이미 구현)
- [ ] GET /api/codex-auth/accounts: 토큰 값 미노출 (이미 구현: hasCredential만)
- [ ] POST /api/codex-auth/accounts: input length 제한 (access_token < 10KB, id < 64 chars)
- [ ] POST /api/codex-auth/login: rate limit (동시 1개만)

## Verification

- token refresh failure → graceful fallback 테스트
- concurrent refresh lock 테스트
- import with invalid JSON → error message
- all accounts at threshold → no infinite loop
- 전체 테스트 통과

## Commits

```
fix: graceful fallback on token refresh failure
fix: handle deleted account in active session
feat: add refresh lock for concurrent token requests
feat: validate import input length
```
