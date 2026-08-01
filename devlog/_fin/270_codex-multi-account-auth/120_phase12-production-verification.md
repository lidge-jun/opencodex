# Phase 12: Production-Level Verification (120-129)

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

PABCD 12턴: Phase 11 수정 후 프로덕션 수준 검증

## Objective

Phase 11에서 수정된 OAuth flow가 **실제 환경에서 E2E로 작동**하는지 검증한다.
참고 레포들의 테스트/검증 패턴을 적용한다.

## Reference Verification Patterns

| Repo | 검증 방식 |
|------|----------|
| codex-multi-auth | Unit + integration + E2E, health check, rotation test |
| codex-lb | Dashboard health, model catalog, usage tracking |
| term-llm | Manual OAuth flow + security review (sam.saffron 방식) |
| codex-oauth | AuthManager auto-refresh cycle |

## Verification Stages

### Stage 1: OAuth Flow E2E (수동)

**1.1 Login Flow**
```
1. 서버 시작: bun run dev
2. 브라우저: http://localhost:10100 → Codex Auth 탭
3. "+ Add" → "Log in with ChatGPT" 클릭
4. 브라우저 새 탭: auth.openai.com 로그인 페이지 표시 확인
5. ChatGPT 로그인 완료
6. 콜백: http://127.0.0.1:19191/callback?code=...&state=... 수신
7. "Login complete" 페이지 표시
8. GUI: 새 계정이 pool에 표시됨 (email, plan, quota bar)
```

**1.2 Token Exchange 검증**
```bash
# 서버 로그에서 확인:
# - POST auth.openai.com/oauth/token 200 OK
# - access_token, refresh_token, id_token 수신
# - JWT에서 account_id 추출 성공
```

**1.3 실패 시나리오 (redirect URI 문제)**

만약 `:19191`이 거부되면:
```
에러: "redirect_uri_mismatch" 또는 "invalid_redirect_uri"
해결: CALLBACK_PORT를 1455로 변경, CALLBACK_PATH를 /auth/callback으로 변경
```

### Stage 2: Token Refresh Cycle

**2.1 자동 갱신 테스트**
```
1. OAuth로 계정 추가 (Stage 1 완료 후)
2. codex-accounts.json에서 expiresAt를 현재 시간으로 수정 (만료 강제)
3. 해당 계정을 active로 설정
4. Codex App에서 메시지 전송
5. server.ts가 getValidCodexToken → expired → refresh → 성공
6. codex-accounts.json의 expiresAt가 갱신됨
```

**2.2 Refresh 실패 복구**
```
1. codex-accounts.json의 refreshToken을 "invalid" 로 수정
2. 메시지 전송
3. getValidCodexToken → refresh 실패 → throw
4. server.ts catch → fallback to main passthrough
5. 메시지 정상 전달 (main account으로)
6. GUI: 해당 계정에 경고 표시 (실패했지만 서비스는 유지)
```

**2.3 Concurrent Refresh Lock**
```
1. 동시에 2개 요청 전송 (같은 expired 계정)
2. 첫 번째 요청이 refresh lock 획득
3. 두 번째 요청이 같은 Promise 대기
4. 하나의 refresh만 실행됨 (refresh_token 무효화 방지)
```

### Stage 3: Multi-Account Rotation

**3.1 Session Affinity**
```
1. Pool 계정 2개 추가 (A, B)
2. A를 active로 설정
3. thread-1에서 메시지 전송 → A 사용
4. B를 active로 변경
5. thread-1에서 메시지 전송 → 여전히 A (affinity)
6. thread-2에서 메시지 전송 → B 사용
```

**3.2 Auto-Switch**
```
1. A를 active, threshold 80%
2. A의 weeklyPercent를 85%로 설정 (updateAccountQuota)
3. 새 thread에서 메시지 전송
4. resolveCodexAccountForThread → B로 자동 전환
5. config.json의 activeCodexAccountId가 B로 변경됨
```

**3.3 All at Threshold**
```
1. A, B 모두 weeklyPercent 90%
2. 새 thread → 현재 active 유지 (무한 순환 방지)
3. 서비스 중단 없음
```

### Stage 4: Passthrough Injection

**4.1 Header Rewrite 확인**
```bash
# 서버에서 upstream 요청 가로채기 (debug 로그):
# Before: Authorization: Bearer <main-token>
#         ChatGPT-Account-Id: <main-id>
# After:  Authorization: Bearer <pool-token>
#         ChatGPT-Account-Id: <pool-id>
```

**4.2 Quota Header Capture**
```bash
# upstream 응답 헤더에서 확인:
# x-codex-primary-used-percent: 12.5
# x-codex-secondary-used-percent: 45.0
# → updateAccountQuota 호출 → GUI quota bar 갱신
```

### Stage 5: Security Audit

**5.1 Token Exposure**
```bash
# API 응답에서 토큰 미노출 확인:
curl -s localhost:10100/api/codex-auth/accounts | jq '.accounts[].hasCredential'
# true/false만, accessToken/refreshToken 없음
```

**5.2 File Permissions**
```bash
stat -f "%Lp" ~/.opencodex/codex-accounts.json
# 600 (owner read/write only)
```

**5.3 CSRF Protection**
```
1. OAuth state 파라미터가 callback에서 검증됨
2. state mismatch → "State mismatch - possible CSRF attack" 에러
```

**5.4 Input Validation**
```bash
# Oversized input:
curl -X POST localhost:10100/api/codex-auth/accounts \
  -H "Content-Type: application/json" \
  -d '{"id":"a]...65chars...","email":"x","accessToken":"t","refreshToken":"r","chatgptAccountId":"c"}'
# → 400 "Input too large"
```

### Stage 6: Test Suite

**6.1 새 테스트 추가 목록**

```ts
// tests/chatgpt-oauth.test.ts
describe("ChatGPT OAuth", () => {
  test("extractAccountId from id_token (level 1: chatgpt_account_id)");
  test("extractAccountId from namespaced claim (level 2)");
  test("extractAccountId from organizations (level 3)");
  test("extractAccountId returns undefined on invalid JWT");
  test("extractEmail from JWT payload");
  test("credsFromToken extracts all fields including accountId");
  test("refreshChatGPTToken uses form-urlencoded");
  test("exchangeToken uses form-urlencoded");
  test("constants match auth.openai.com endpoints");
});

// tests/session-affinity.test.ts
describe("session affinity", () => {
  test("same thread-id returns same account");
  test("new thread uses activeCodexAccountId");
  test("deleted account falls back to null");
  test("auto-switch triggers at threshold");
  test("auto-switch skips when all at threshold");
});

// tests/codex-account-store.test.ts (확장)
describe("token refresh", () => {
  test("uses form-urlencoded content-type");
  test("concurrent refresh returns same promise (lock)");
  test("updates codex-accounts.json on successful refresh");
});
```

**6.2 테스트 목표**
- OAuth: 9 tests
- Session affinity: 5 tests
- Account store 확장: 3 tests
- 기존: 12 tests
- **Total: 29+ tests**

### Stage 7: GUI Verification

```
1. Main Account 표시: email, plan, quota bars
2. Pool accounts 표시: email, quota, active badge
3. Add modal: Import (JSON paste) + OAuth (browser login)
4. OAuth 진행 중: spinner + "Waiting for browser login..." 표시
5. OAuth 완료: 자동 닫힘 + 계정 목록 새로고침
6. OAuth 에러: 에러 메시지 + 재시도 버튼
7. Delete: 확인 dialog → 삭제 → active 리셋
8. Switch: 클릭 → toast "Switched to ..."
9. Auto-switch threshold: 슬라이더 → 즉시 저장
```

## Pass Criteria

| 항목 | 기준 |
|------|------|
| OAuth Login | auth.openai.com 로그인 → token 수신 → pool 등록 |
| Token Refresh | expired → auto refresh → 서비스 유지 |
| Multi-Account | affinity + auto-switch + fallback 정상 |
| Security | 토큰 미노출, 파일 0600, CSRF 검증 |
| Tests | 29+ tests 전체 통과 |
| GUI | 전체 flow 브라우저 검증 |
| Typecheck | `bun run typecheck` clean |
| Build | `gui build` success |

## Known Risks

1. **redirect_uri 거부**: `app_EMoamEEZ73f0CkXaXp7hrann`가 `:19191`을 허용하지 않을 수 있음.
   Fallback: `:1455/auth/callback`으로 변경.

2. **country/region 제한**: [GitHub issue #14215](https://github.com/openai/codex/issues/14215)에서
   `auth.openai.com/oauth/token`이 특정 지역에서 403 반환 보고됨.
   한국에서 테스트해야 함.

3. **Rate limit**: 짧은 시간에 여러 refresh 요청 시 429 가능.
   `codex-multi-auth`는 cooldown 패턴 적용.

## Commits

```
test: add OAuth JWT extraction and session affinity tests
test: verify form-urlencoded token exchange
chore: document E2E verification results
```
