# 020 — 패치 계획 O-1: Anthropic OAuth 지속성 (#209)

- 소스 RCA: `004_rca_o_oauth_persistence_manual_code.md` O-1 절 (리뷰어 검증 완료)
- 위험도: 중간 (자격 증명 라이프사이클 — 회귀 시 로그인 반복/계정 잠금 UX 악화)
- 선행 조건: 없음. **주의**: #183(수동 코드)은 별도 단위 `022`로 분리됨(리뷰어 blocker 반영 — 별도 위협 모델).
- **구현 완료 (2026-07-22)**: anthropic.ts:37 AnthropicTokenError(status+oauthError); index.ts:286 refreshAnthropicAccountWithLock(xAI 패턴 이식 — refresh-intent lock + generation CAS + 구조화 종단 분류 + local-cli adoption/lazy 복구); :357 anthropic 분기; local-token-detect.ts CLAUDE_CONFIG_DIR 우선. bounded retry는 연기(transient는 마킹 없이 요청 실패 — 수용 문구 허용). 검증: oauth-refresh+anthropic-hardening+xai-oauth-retry 28 pass, oauth-store-multi 13 pass, `bun x tsc --noEmit` exit 0. 커밋: WP-impl-4.

## 목표

재부팅/동시 실행 후 Anthropic 계정이 잘못 `needsReauth`로 영구 마킹되는 것을 막는다:
(a) terminal 에러만 마킹, (b) generation-safe 마킹, (c) local-cli 회전 토큰 소유권 정의.

## 파일 변경 맵

| 파일 | 작업 | 내용 |
|------|------|------|
| `src/oauth/anthropic.ts` | MODIFY | 구조화 토큰 에러 타입 (HTTP status + parsed OAuth error) |
| `src/oauth/index.ts` | MODIFY | terminal 분류 정밀화 + generation-safe 마킹 + local-cli 재읽기 |
| `src/oauth/local-token-detect.ts` | MODIFY(소폭) | 재읽기 헬퍼 노출 (필요시) |
| `tests/oauth-refresh.test.ts` | MODIFY | transient-vs-terminal 분류 + generation CAS 회귀 |
| `tests/anthropic-hardening.test.ts` | MODIFY | `AnthropicTokenError` status/oauthError 파싱 회귀 |

**참조 기준(xAI 이미-구현 패턴):** 아래 diff는 `refreshXaiAccountWithLock`(`src/oauth/index.ts:272`)와
`XaiTokenRequestError`/`terminal()`(`:250` 인접)의 검증된 구조를 Anthropic(및 generic 경로)로 이식한다.
CAS 프리미티브는 이미 존재: `mergeAccountCredential(...expectedGeneration)`(`src/oauth/store.ts:338`),
`markAccountNeedsReauthIfGeneration`(`store.ts:339`), `createOAuthRefreshIntentLock`(`store.ts:85`).

## Diff 1 — 구조화 에러 분류 (`anthropic.ts:37-55`, `index.ts:250`)

현행 종단 판정은 에러 **메시지 substring**이다.

Before (`src/oauth/index.ts:250`, 실측):

```ts
/** Terminal refresh failures (revoked/rotated-away grants) — retrying cannot succeed. */
function isTerminalRefreshError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("invalid_grant")
    || msg.includes("refresh_token_reused")
    || msg.includes("revoked")
    || msg.includes("access_denied")
    || msg.includes("expired_token");
}
```

현행 Anthropic refresh는 HTTP 상태를 문자열에 흘려 넣기만 한다.

Before (`src/oauth/anthropic.ts:45`, 실측 — `postJson`):

```ts
  if (!response.ok) {
    throw new Error(`Anthropic OAuth HTTP ${response.status}: ${responseBody}`);
  }
```

After — 구조화 에러 타입 도입(`anthropic.ts`):

```ts
export class AnthropicTokenError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | undefined,   // fetch 실패면 undefined
    readonly oauthError: string | undefined,   // 파싱된 body.error (invalid_grant 등)
  ) { super(message); }
}
```

`postJson`의 `!response.ok` 분기를 `AnthropicTokenError(msg, response.status, parsedBody?.error)`
throw로 교체(본문 JSON 파싱은 best-effort). `refreshAnthropicToken`(`anthropic.ts:148`)은 그대로
`postJson`을 호출하므로 시그니처 변경 없음.

분류 규칙 (`index.ts`의 `terminal()`을 xAI처럼 타입 인지로 확장, `:250` 인접):

- 마킹(terminal): `httpStatus`가 400/401 계열이고 `oauthError`가 `invalid_grant`/reuse/revocation 확정값일 때만.
- 마킹 금지(transient): fetch 실패(undefined), timeout, 429, 5xx, malformed body — bounded retry(지터 백오프, 예: 3회) 후 이번 요청만 실패 처리.
- xAI의 `terminal(error)`(`index.ts:250` 인접)가 이미 `XaiTokenRequestError?.oauthError`를 검사하므로,
  동일 함수에 `error instanceof AnthropicTokenError` 분기를 추가한다. 기타 프로바이더는 기존 substring `isTerminalRefreshError` 유지(범위 밖).

## Diff 2 — generation-safe 마킹 (xAI 패턴 이식, `index.ts:272`, `store.ts:338-339`)

현행 generic 경로 종단 마킹은 generation 무관.

Before (`src/oauth/index.ts:316-319`, 실측 — `refreshAndPersistAccessToken` catch):

```ts
    if (isTerminalRefreshError(err)) {
      await markAccountNeedsReauth(provider, accountId, true);
      throw new OAuthLoginRequiredError(provider);
    }
    throw err;
```

After (방향): `provider === "anthropic"`를 xAI처럼 락 기반 경로로 분기 —
`if (provider === "xai") return refreshXaiAccountWithLock(...)`(`index.ts:290`) 옆에
`if (provider === "anthropic") return refreshAnthropicAccountWithLock(...)`를 추가하고, 그 함수는
`refreshXaiAccountWithLock`(`index.ts:272`)의 구조를 복제하되 `def.refresh`/`terminal` 판정만 Anthropic용으로:

1. per-provider/account refresh-intent 락 획득
2. 락 후 credential 재읽기 (다른 writer가 이미 회전했으면 그 값 채택하고 refresh 생략)
3. 성공 시 `mergeAccountCredential(..., { expectedGeneration })` — superseded면 저장 안 함
4. terminal 실패 시 `markAccountNeedsReauthIfGeneration(provider, accountId, generation)` — 잡은 generation이 이미 대체됐으면 no-op

## Diff 3 — local-cli 소유권 (xAI `authoritative()` 대응, `index.ts:260`)

xAI는 `authoritative(stored, active, now)`(`index.ts:260`)가 refresh 전 disk를 재읽어 신규 generation을
채택한다. Anthropic도 `source: "local-cli"` 계정에 한해 동형 헬퍼를 둔다:

- refresh 시도 전 `~/.claude/.credentials.json` 재읽기 — 저장된 것과 다른(신규) refresh token이면 그 자격을 adopt(merge)하고 자체 refresh 생략.
- terminal 실패로 마킹된 local-cli 계정: 다음 사용 시점에 1회 lazy 재읽기 → 신규 generation 발견 시 merge + 마킹 해제. 동일 generation 반복 재시도는 금지 (소모된 회전 토큰 재전송 방지 — 리뷰어 지적 반영).
- 재읽기에서도 동일 토큰이면: 마킹 유지(진짜 reauth 필요).
- 기존 Claude Code 자격 재읽기 헬퍼가 `local-token-detect.ts`에 있으면 재사용, 없으면 소폭 노출 추가.

## 명시적 비채택 / 범위 밖

- guardian 정책 변경(disabled 유지), 타 프로바이더 substring 분류 변경, GUI 변경(Re-login은 dev에 이미 존재 — `management-api.ts:1363`).

## 수용 기준 / 검증

- [ ] `tests/oauth-refresh.test.ts` 신규 케이스: (a) 5xx/timeout/fetch-fail은 마킹 안 함 + retry, (b) invalid_grant 400은 마킹, (c) generation 대체 후 늦은 실패는 no-op, (d) local-cli 신규 토큰 adopt 시 `def.refresh` 미호출, (e) 마킹된 local-cli lazy 복구 1회
- [ ] `tests/anthropic-hardening.test.ts`: `AnthropicTokenError.httpStatus`/`oauthError` 파싱
- [ ] `bun test tests/oauth-refresh.test.ts tests/anthropic-hardening.test.ts tests/xai-oauth-retry.test.ts` + `bun run typecheck` 통과
- [ ] 기존 xAI 경로 비회귀 (`tests/xai-oauth-retry.test.ts`, `tests/server-xai-oauth-401-replay.test.ts`)
