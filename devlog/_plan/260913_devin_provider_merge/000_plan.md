# 000 — devin 프로바이더 통합 플랜 (devin-cli → devin)

## 배경

레지스트리에 Cognition 계정 프로바이더가 두 개다.

- `devin` (`src/providers/registry.ts:1353`) — Auth0 브라우저 사인인 → 붙여넣은 토큰을
  RegisterUser로 교환. 시드 로스터는 구세대 (`swe-1-7` 기본, `gpt-5-6-luna/terra`,
  `claude-opus-4-8`, `glm-5-2`, `kimi-k2-7`, `grok-4-5`).
- `devin-cli` (`registry.ts:1334`) — 설치된 Devin CLI의 `credentials.toml`을 임포트.
  CLI 자체가 PKCE로 `devin auth login`을 완료해 두기 때문에 브라우저를 열 필요가 없다.
  시드는 신세대 (`swe-2` 기본, `gpt-6-astra`, `claude-opus-5`, `glm-5-3`, `kimi-k3`,
  `gemini-3-8-flash`, `grok-4-6`).

둘은 같은 `devin` 어댑터, 같은 `server.codeium.com` api-server, 같은
`devin-session-token$<JWT>` 자격을 쓴다. 계정 소스만 다를 뿐 프로바이더가 둘일 이유가 없고,
PKCE를 완료한 CLI 자격이 더 새 로스터와 더 간단한 로그인을 가진다.

## 결정

**canonical id는 `devin`.** `devin-cli`의 import-first 로그인을 `devin`이 흡수하고,
`devin-cli`는 deprecated alias로만 남긴다.

- `loginDevin` = CLI 자격 임포트 우선 → `missing`이면 기존 브라우저 Auth0 플로우로 폴백.
  `unreadable`/`incomplete`은 폴백 없이 throw (파일이 있는데 깨진 상태를 브라우저 로그인이
  고쳐주지 않는다). `forceLogin`이면 임포트를 건너뛰고 브라우저 플로우 — CLI와 다른 계정으로
  로그인하는 경우 + management route가 이미 addAccount/reauth에 forceLogin을 세팅한다
  (`oauth-account-routes.ts:190-193`).
- `devin-cli` 레지스트리 엔트리는 제거하고, 스타트업 마이그레이션이 저장된 상태를
  `devin-cli` → `devin`으로 리라이트한다 (fail-closed + 백업, Alibaba 포스처).
- **제거는 한 묶음으로**: `oauthConfig("devin-cli")`가 모듈 로드 시점에 eager 평가돼서
  레지스트리 행만 지우면 `src/oauth/index.ts` import 자체가 죽는다 (James 조사).
  레지스트리 행과 OAUTH_PROVIDERS 엔트리를 같은 변경에서 정리한다.
- 요금 오버레이는 양쪽 id를 **유지**한다. 과거 사용량 행이 리터럴 `devin-cli`로 키잉돼 있어서
  (`src/usage/cost.ts:190-201`은 configured provider id를 그대로 씀) 지우면 과거 사용량이
  무가격이 된다. `usage-cost.test.ts`의 121 카운트와 양쪽 튜플은 그대로.

## 왜 병합 로그인인가 (devin 브라우저 플로우를 버리지 않는 이유)

`devin`의 브라우저 플로우는 CLI 미설치 사용자의 유일한 로그인 경로다. 순수 rename이면
CLI 없는 사용자는 로그인 자체가 불가능해진다. import-first + browser-fallback이면
CLI 사용자는 여전히 무(無)브라우저고, 나머지는 기존 플로우를 그대로 쓴다.
kiro가 이미 이 모양이다 (`src/oauth/kiro.ts:335-390`).

## 워크 페이즈

- `010_wp1_core_merge.md` — 레지스트리/OAuth 병합: `devin`이 import-first+browser-fallback
  로그인을 소유, `devin-cli` 엔트리/OAuth def/디스패치 정리, alias 해석.
- `020_wp2_migration.md` — 스타트업 마이그레이션: config.providers 키 이동 +
  `rewriteProviderReferences` (+ `routingProfiles` 갭 보강) + auth.json 자격 슬롯 rekey.
- `030_wp3_surface_sync.md` — GUI 라벨/아이콘, docs-site 8개 로케일, structure/ 문서,
  테스트 갱신.
- `040_wp4_pr.md` — PR 생성, 리뷰 게이트, 머지.

## 조사 근거 (2026-09-13, 병렬 swe-2 서브에이전트 4대)

- 인벤토리(Aristotle): 리터럴 id는 registry/oauth/index/adapters/registry/
  oauth-account-routes/request-log/provider-fetch/behavior/expected-prices/GUI/docs/tests에
  분산. 어댑터 내부와 `DevinCli*` 식별자는 경로 유도라 id 리터럴이 아님.
- OAuth plumbing(James): 디스패치는 `runLogin`(index.ts:1583) 하나로 수렴. registry 행만
  지우면 `oauthConfig` eager 평가가 모듈 로드를 죽임. refresh policy 회귀
  (`disabled`→`lazy-only`)와 needsReauth 못 푸는 문제 지적.
- 마이그레이션(Banach): `rewriteProviderReferences`(`provider-id-rewrite.ts:35`)가
  대부분의 cross-config 참조를 커버. **갭: `routingProfiles[].candidates[].provider`
  미커버** — 리라이터 확장 필요. auth.json rekey 헬퍼는 없음, 신규 작성.
- 가격/테스트(Boyle): `resolveMatchedPrice`가 configured provider id를 verbatim 사용 →
  양쪽 오버레이 유지. 시드는 devin-cli 신세대 채택 + `defaultModel: "swe-2"`.
