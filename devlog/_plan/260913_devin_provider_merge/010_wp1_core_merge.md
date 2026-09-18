# 010 — wp1: 코어 병합 (canonical `devin`이 import-first 로그인을 소유)

## MODIFY: `src/providers/registry.ts`

- `devin-cli` 엔트리(1334-1351) 제거.
- `devin` 엔트리 갱신:
  - `models` ← union 시드: devin-cli 신세대 로스터를 기본으로 하고 devin 구세대 전용 id
    (`swe-1-7-lightning`, `gpt-5-6-luna`, `gpt-5-6-terra`, `claude-opus-4-8`, `glm-5-2`,
    `kimi-k2-7`, `grok-4-5`)를 합친다. liveModels라 degraded-mode 전용이지만 오버레이에
    행이 있는 id가 빠지면 fallback 카탈로그에서 무가격 모델이 된다.
  - `defaultModel: "swe-2"`.
  - `note`를 통합 설명으로 교체: 설치된 Devin CLI 자격을 먼저 임포트하고 없으면 Auth0
    브라우저 사인인으로 폴백한다는 취지.
  - `label`은 "Cognition (Devin/Windsurf)" 유지 (GUI 라벨은 wp3에서 결정).

## MODIFY: `src/oauth/index.ts`

- `"devin-cli"` OAUTH_PROVIDERS 엔트리는 **alias def로 유지**: registry 행이 사라지므로
  `oauthConfig("devin-cli")` eager 평가가 죽는다 — `providerConfig`/`defaultModel`을
  `oauthConfig("devin")`/`oauthDefaultModel("devin")`으로 바꾼 얇은 엔트리로 두고
  `login`은 canonical `loginDevin`에 위임. 이렇게 해야:
  - `ocx login devin-cli`가 usage wall로 안 떨어지고 devin 로그인으로 라우트된다.
  - 마이그레이션 전/실패 상태에서도 `isPublicOAuthProvider("devin-cli")`가 참이라
    logout/status/reauth 경로가 400으로 죽지 않는다.
  - `resolveRefreshPolicy("devin-cli")`가 `disabled`를 유지한다 (제거하면 lazy-only로
    회귀해 refresh 불가능한 durable key에 refresh를 시도 → needsReauth 오표시, James 지적).
  - 단, 대시보드 Accounts 탭에 `devin-cli`가 별도 행으로 보이는 문제가 생기면
    OAUTH_PROVIDERS 표면 노출 쪽을 확인 (wp1 구현 중 결정).
- `devin` 엔트리의 `login`을 `(ctrl, opts) => loginDevin(ctrl, opts)`로 교체.

## MODIFY: `src/oauth/devin.ts` + `src/oauth/devin-cli.ts`

- `loginDevin(ctrl, opts?)`을 import-first로 재작성:
  ```
  if (opts?.forceLogin !== true) {
    outcome = readDevinCliCredentialOutcome()
    "ok"          → imported credential (source: "local-cli")
    "unreadable"/"incomplete" → throw (기존 메시지)
    "missing"     → fall through
  }
  return loginDevinBrowser(ctrl, DEFAULT_REGION)
  ```
- 임포트 로직은 `src/oauth/devin/cli-import.ts`(가칭)로 이동해 `devin.ts`가 import.
  `devin-cli.ts`는 thin re-export로 남기거나 삭제 — `devin-cli-login.test.ts`와
  structure 문서 4곳이 경로를 참조하므로 wp3에서 같이 정리. deprecated id를 암시하는
  최상위 파일명은 없애는 쪽이 깔끔하다.
- `refreshDevinCliToken`은 `refreshDevinToken`과 동일 의미(throw invalid_grant)로 통합.
- `resolveDevinApiServer(configuredBaseUrl, providerId)`: `devin-cli` → `devin` 정규화해
  같은 자격 슬롯을 읽게 한다 (마이그레이션 전 인메모리 상태 대비).

## MODIFY: `src/server/management/oauth-account-routes.ts:92`

- `isDevinCloudDirectProvider`는 양쪽 id를 계속 인정 (alias 기간 동안 구 슬롯 클리어 필요).

## MODIFY: `src/adapters/devin.ts:333-341`

- `credentialProviderId`가 `devin-cli`이면 `devin`으로 정규화 (마이그레이션 전 config가
  남아있는 동안 어댑터가 구 슬롯을 읽지 않게).

## 테스트 (wp1 범위)

- `tests/providers/devin-cli-login.test.ts` → 병합 로그인 테스트로 개명/재작성
  (import 성공, missing→browser 폴백, unreadable/incomplete throw, forceLogin→browser).
- `tests/providers/devin-adapter.test.ts` — `devin-cli` 레지스트리 참조 제거 반영.
- 신규/개명 테스트 파일은 `scripts/test-layout/layout.json` explicit +
  `tests/fixtures/test-layout-expected.json` 양쪽 등록.
