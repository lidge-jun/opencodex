# 004 — RCA O: OAuth 지속성(#209) + codex-auth 수동 코드 입력(#183)

- 이슈: #209 (Anthropic needsReauth after Windows reboot), #183 (codex-auth 수동 붙여넣기 누락)
- 조사: sol 서브트랙 O-1(#209) / O-2(#183), 2026-07-22 dev 트리 실측

## O-2 (#183) — codex-auth 수동 코드 입력 누락

### 증상

provider OAuth 모달에는 리다이렉트 URL/코드 붙여넣기 폴백이 있는데, Codex 계정 추가 모달에는
"로그인 링크 복사 / 스피너 / 취소"만 있다. 헤드리스/원격 환경에서 localhost 콜백이 안 열리면
Codex 계정 추가를 완료할 방법이 없다.

### 표면 맵 (파일:라인)

- provider 모달: `gui/src/components/AddProviderModal.tsx:269` submitManualCode → POST `/api/oauth/login/code`; 대기 UI 입력창 `:349`. 클래식 Providers 페이지도 동일 구현(`gui/src/pages/Providers.tsx:63,655,1091`).
- 백엔드 generic 엔드포인트: `src/server/management-api.ts:1406` — `isPublicOAuthProvider` 필수, 4096자 제한, `submitManualLoginCode(provider, input)`.
- **chatgpt는 public OAuth에서 명시 제외**: `src/oauth/index.ts:124` `return name !== "chatgpt" && isOAuthProvider(name)` → `/api/oauth/login/code`에 chatgpt를 보내면 400.
- Codex 모달: `gui/src/components/AddCodexAccountModal.tsx:82` (`/api/codex-auth/login` 시작 + `login-status` 폴링), 대기 뷰 `:240` — 수동 입력 상태/핸들러 없음.
- Codex 백엔드: `src/codex/auth-api.ts:566` startLoginFlow("chatgpt"); status/cancel `:766,774`; **`/api/codex-auth/login/code` 엔드포인트 부재**.
- 하위 공유 OAuth 레이어는 chatgpt 포함 수동 입력 이미 지원: `src/oauth/index.ts:632,638,542`, `src/oauth/callback-server.ts:232` (Promise.race).

### 판정

**(b) — Codex-auth HTTP API 미지원 + GUI 누락. API와 GUI 둘 다 수정 필요.**
이슈 본문의 "순수 GUI 갭" 결론은 절반만 맞다. (c) 정책 차단 아님 — 정책 게이트(`auth-api.ts:134,138,392`)는
raw 토큰 import 차단이지, 진행 중 PKCE 플로우에 콜백을 제출하는 것과 무관.

### 수정 방향 (020 패치 단위 입력)

- 신규 `POST /api/codex-auth/login/code` `{flowId, input}` — pending `codexAuthLoginState` 매칭, 4096자 제한, `submitManualLoginCode("chatgpt", input)` 경유. flowId 바인딩으로 stale 모달 주입 방지.
- `AddCodexAccountModal.tsx`에 oauth-waiting 상태의 입력창 + 제출 + 성공/취소/만료 시 상태 클리어.
- state 검증은 공유 레이어 유지(`oauth/index.ts:512,553`, `callback-server.ts:239`); raw code 예외는 문법적 raw code에 한정.
- 보안: 붙여넣은 값 로그 금지, React state 잔존 금지, autoComplete off, pending 플로우에서만 수용.
- 테스트: 정상 제출/flowId 오류/만료/oversize/state mismatch/취소 레이스 + raw-import 정책 불변 확인.

## O-1 (#209) — Anthropic needsReauth 재부팅 후 재발

### 증상

Windows 재부팅 후 access/refresh 토큰이 auth.json에 온전히 남아 있는데, 만료된 access 토큰의
refresh가 실패하며 `needsReauth: true`가 영속화되고 Anthropic 모델이 사라진다(v2.7.26 기준).
핵심 단서: 리포트의 credential `source: local-cli` — Claude Code의 회전 토큰을 import한 상태.

### 라이프사이클 맵 (파일:라인)

- 저장: `~/.opencodex/auth.json` (`src/config.ts:268`, `src/oauth/store.ts:30`); temp+rename 원자 쓰기(`config.ts:72`), 프로세스 내 직렬화 + 크로스 프로세스 락(`store.ts:185`) — **단 락이 외부 Anthropic refresh 요청까지 소유권을 유지하지는 않음**
- 획득: 기본 로그인이 Windows `~/.claude/.credentials.json`에서 Claude Code 자격을 import하고 `source:"local-cli"` 라벨 (`src/oauth/local-token-detect.ts:82`, `src/oauth/anthropic.ts:119`); refresh는 회전된 refresh token 수용·영속 (`anthropic.ts:148`)
- 트리거: 1분 조기 만료 판정(`src/oauth/index.ts:193`) + Anthropic 자체 5분 차감(`anthropic.ts:59`) = 실효 ~6분 조기; 모델 리스팅이 토큰 리졸버를 불러 대시보드 로드 즉시 refresh 가능(`index.ts:330`)
- needsReauth SET: generic refresh 에러 텍스트에 `invalid_grant|refresh_token_reused|revoked|access_denied|expired_token` 포함 시 영구 마킹 (`index.ts:250,309`); **xAI만** generation-aware `markAccountNeedsReauthIfGeneration` 사용(`index.ts:272`) — Anthropic은 비-generation 경로
- CLEAR: 성공적 credential 쓰기 시에만 (`store.ts:225,248,291,338`); `markAccountNeedsReauth(false)`는 프로덕션 호출자 없음(`store.ts:329`). 마킹 후 자동 재시도·해제 경로 없음 — guardian은 마킹 계정을 영구 스킵(`token-guardian.ts:128`), Anthropic guardian 정책은 disabled(`index.ts:71`)

### 원인 가설 (순위)

1. **(고신뢰) Claude Code 공유 refresh-token 회전 레이스** — OpenCodex가 같은 회전 토큰의 사본을 보유; Claude Code가 먼저 refresh하면 OpenCodex의 이전 토큰은 single-use 무효 → 다음 refresh가 invalid_grant → 영구 마킹. 삭제 후 재추가가 즉시 낫는 이유: 최신 Claude Code 자격을 다시 import하기 때문. xAI에는 local-CLI 재읽기/adopt/detach + refresh-intent 락이 있는데 Anthropic에는 없음(`index.ts:260`).
2. (중) OpenCodex 동시 refresh 경쟁 — per-account 크로스 프로세스 refresh 락·generation CAS 부재(`index.ts:195,274`); 패자가 신규 generation 위에 무조건 마킹 가능.
3. (중저) upstream의 실제 거절/차단 — 코드 자체가 서버측 차단 가능성 경고(`index.ts:71`); 리포트에 refresh 응답 로그가 없어 판별 불가.
4. (저) 부팅 시 네트워크 미가용 — Task Scheduler가 네트워크 무관 즉시 시작(`service.ts:416`)이지만 fetch 실패는 terminal substring 불일치라 마킹으로 직행하지 않음.

### 모델이 사라지는 이유

v2.7.26의 `/api/models`는 refresh 에러를 `undefined`로 삼켜(`index.ts:330`) OAuth 무토큰 provider를 `[]`로.
현 dev는 이미 개선: 무토큰이어도 static 카탈로그 반환(`src/codex/catalog.ts:1269`).
web-search/vision 사이드카는 의도적으로 마킹 계정 제외 유지(`web-search/index.ts:79`, `vision/index.ts:102`).

### 수정 방향 (020 패치 단위 입력)

1. Anthropic 구조화 에러 분류: HTTP status + 파싱된 OAuth `error` 기반 — 확인된 invalid_grant/reuse/revocation만 마킹, 네트워크/timeout/5xx/rate limit은 재시도 가능 유지 (`anthropic.ts:37`, `index.ts:250`).
2. generation-safe 마킹 일반화: xAI 패턴(refresh-intent 락 → 재읽기 → `mergeAccountCredential(expectedGeneration)` → `markAccountNeedsReauthIfGeneration`)을 generic OAuth로 이식.
3. local-cli 소유권 정의: refresh 전 `~/.claude/.credentials.json` 재읽기·최신 generation adopt(xAI식), 또는 import를 일회성 handoff로 보고 즉시 detach.
4. transient 실패 bounded retry(지터 백오프), needsReauth 미설정.
5. 마킹된 local-cli 계정의 lazy 복구: Claude Code 저장소 1회 재읽기로 신규 generation 발견 시 merge+클리어.
6. GUI Re-login은 dev에서 이미 account-bound 지원(`management-api.ts:1363`, `index.ts:449`) — 증상 완화일 뿐 회전 소유권·generation 안전이 본질.

### Open Questions (트리에서 증명 불가)

재부팅 직후 Anthropic 토큰 엔드포인트의 실제 status/error, Claude Code 선행 실행 여부,
실패 후 두 저장소의 refresh token 세대 차이, 브라우저 로그인(source:oauth)으로 재현되는지.
