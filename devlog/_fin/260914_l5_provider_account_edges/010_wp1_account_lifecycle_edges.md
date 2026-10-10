# 010 — wp1: 계정 수명주기 경계 (#4503, #3781)

## MODIFY: `src/oauth/devin.ts` — `resolveDevinApiServer`

현재는 `getCredential(providerId)`를 **리터럴 슬롯 키**로 읽는다. 병합
마이그레이션(`runDevinProviderMergeStartupMigration`)은 `providers["devin"]`을
동기로 저장한 뒤 `void rekeyProviderCredentials("devin-cli","devin")`을 detached로
던진다. 그래서 config 행은 이미 `devin`인데 credential은 아직 `devin-cli` 슬롯에
있는 창이 생기고, rekey가 실패하거나 collision으로 거부되면 그 상태가 그 프로세스
동안 계속된다. 그 사이 `getCredential("devin")`은 undefined라 EU/FedStart 테넌트가
configured baseUrl 또는 `DEVIN_DEFAULT_API_SERVER`(US)로 떨어진다.

계약:

1. 요청받은 providerId의 **리터럴 슬롯을 먼저** 본다. 아직 `devin-cli`로 남아 있는
   config 행은 자기 슬롯을 읽어야 하므로, 앞단에서 id를 정규화하면 오히려 틀린
   슬롯을 읽는다. 기존 주석의 그 논거는 유지하고 확장한다.
2. 리터럴 슬롯에 쓸 만한 `apiBaseUrl`이 없을 때만 `DEPRECATED_OAUTH_PROVIDER_ALIASES`가
   묶어 둔 슬롯을 **양방향**으로 더 본다 (`devin` → `devin-cli`, `devin-cli` → `devin`).
   두 번째 문자열 리터럴을 박지 않고 alias 맵에서 유도해, 맵이 단일 출처로 남게 한다.
3. 후보는 모두 `validateDevinApiBaseUrl`을 통과해야 한다. alias 슬롯을 리터럴보다
   더 신뢰하지 않는다.
4. 이후 순서는 그대로: configured baseUrl → `DEVIN_DEFAULT_API_SERVER`.
5. 시그니처와 기존 호출부는 불변.

## MODIFY: `src/providers/quota.ts` — Antigravity 블록만

`probeAntigravityUsageQuota`의 summary 프로브는 바인딩도 본문도 없는 빈 catch로 받아서
분류된 진단을 통째로 버린다. summary가 outbound 정책(`destination_blocked`)이나 DNS(`dns_failed`)로
막히는 건 정확히 이 이슈가 말하는 Fake-IP 증상인데, fallback까지 실패하면 사용자에게는
더 두루뭉술한 쪽(`upstream_error`, `response_unusable`)만 보인다.

summary의 분류 결과를 기억해 두고, fallback도 unavailable로 끝났을 때 summary 쪽이
네트워크 정책 진단이고 fallback 쪽이 아니면 summary 진단을 택한다. 보존 조건:
fallback이 성공하면 첫 실패는 완전히 지워진다, summary의 즉시 반환
(`redirect_blocked`/`access_denied`)은 그대로, `legacy` 채널의 모양과
`rejects.toBe(error)` 동일성은 건드리지 않는다, 진단 값은 닫힌
`QUOTA_FAILURE_CODES` 밖으로 나가지 않는다.

## 회귀 테스트

새 테스트 파일은 만들지 않는다 (test-layout 게이트와 그 fixture를 건드리지 않기 위해).

- `tests/providers/devin-login.test.ts` — 마이그레이션 창에서 `devin` 요청이
  `devin-cli` 슬롯의 테넌트 호스트를 읽는지, 리터럴 슬롯 우선순위가 유지되는지,
  잘못된 alias `apiBaseUrl`이 신뢰받지 않는지.
- `tests/providers/devin-adapter.test.ts` — 같은 보장을 어댑터가 실제로 디스패치하는
  호스트 수준에서.
- `tests/providers/provider-account-quota.test.ts` — 프록시 없이 Fake-IP DNS 응답이
  canonical 할당량 URL 두 개에 대해 허용되는지, 예외가 lookalike 호스트/다른 경로/쿼리
  추가/다른 프로바이더 이름으로 넓어지지 않는지, 무관한 private·metadata 응답은 여전히
  거부되고 안전한 `destination_blocked`로 보고되는지.
- `tests/responses/chat-completions-endpoint.test.ts` — #4503 부록. 직접
  `role:"tool"` 봉투에 실린 Pi-shape 이미지 파트 fixture.
