# Phase 5: Tests & Hardening (50-59)

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

PABCD 5턴: 테스트 커버리지 + 보안 검증 + 엣지 케이스

## Scope

- tests/codex-account-store.test.ts — NEW: store CRUD tests
- tests/codex-auth-api.test.ts — NEW: API endpoint tests
- tests/passthrough-override.test.ts — NEW: token replacement tests
- 보안 hardening 검증

## Test Plan

### 1. codex-account-store.test.ts

```ts
describe("codex-account-store", () => {
  test("save and load credential round-trip");
  test("remove credential deletes entry");
  test("listCodexAccountIds returns stored ids");
  test("getValidCodexToken returns cached token when not expired");
  test("getValidCodexToken throws when account not found");
  test("codex-accounts.json has 0o600 permissions");
});
```

### 2. passthrough-override.test.ts

```ts
describe("passthrough token override", () => {
  test("buildRequest uses original auth when no override");
  test("buildRequest replaces authorization when _codexAccountOverride present");
  test("buildRequest replaces chatgpt-account-id when override present");
  test("selectForwardHeaders applies override after forwarding");
  test("selectForwardHeaders works without override (backward compat)");
});
```

### 3. session-affinity.test.ts

```ts
describe("session affinity", () => {
  test("same thread-id returns same account on repeat calls");
  test("new thread-id uses activeCodexAccountId from config");
  test("null activeCodexAccountId returns null (passthrough)");
  test("auto-switch triggers at threshold for new threads");
  test("auto-switch does not affect existing thread mapping");
});
```

### 4. codex-auth-api.test.ts

```ts
describe("codex-auth API", () => {
  test("GET /api/codex-auth/accounts returns account list");
  test("POST /api/codex-auth/accounts adds account");
  test("POST /api/codex-auth/accounts rejects missing fields");
  test("DELETE /api/codex-auth/accounts removes account");
  test("PUT /api/codex-auth/active sets active account");
  test("PUT /api/codex-auth/active with null resets to main");
  test("GET /api/codex-auth/quota returns quota map");
});
```

## Security Hardening Checklist

- [ ] codex-accounts.json chmod 0o600 on every write
- [ ] Tokens never returned in GET /api/codex-auth/accounts (email, plan, quota only)
- [ ] Management API follows isLocalOrigin check (inherited from server.ts delegation)
- [ ] Token refresh uses HTTPS only
- [ ] In-memory threadAccountMap is process-scoped, no disk leak
- [ ] accountQuota Map is in-memory only
- [ ] Import auth.json validates structure before saving

## Edge Cases

1. **Account removed while session active**: threadAccountMap still holds reference.
   → getValidCodexToken throws → fall back to main passthrough. Need catch in server.ts.

2. **Token refresh fails**: account might be revoked.
   → Catch, mark account unhealthy, fall back to next pool account or main.

3. **Multiple Codex App instances**: different App windows share the same thread-id space.
   → OK, threadAccountMap is keyed by thread-id, not window.

4. **Server restart**: threadAccountMap clears.
   → New requests for existing threads get re-assigned. Acceptable — cache was already
   reset for the new process anyway.

5. **All pool accounts at threshold**: no account under limit.
   → Stay on current (least-bad). Don't cycle endlessly.

## Verification

- bun test tests/ 전체 통과
- bun run typecheck
- chmod 검증 (stat codex-accounts.json)
- curl smoke test for API endpoints

## Commits

```
test: add codex account store CRUD tests
test: add passthrough token override tests
test: add session affinity tests
test: add codex-auth API endpoint tests
fix: handle removed account gracefully in session affinity
```
