# 02 — 검증 기록

## 게이트 결과 (2026-07-13)

- `bun x tsc --noEmit`: PASS
- `bun test tests/xai-transport.test.ts`: 11 pass / 0 fail (conv-id 파생·안정성, key 모드 무클론 identity, 빈/공백 키, mixed-case conv-id·CLI 헤더 오버라이드, oauth/key 양 모드, reasoning_content 재전송, 레지스트리 preserve 목록)
- 전체 `bun test`: 2386 pass / 6 fail — 실패 6건은 tests/oauth-refresh.test.ts + tests/oauth-status-privacy.test.ts 전체-실행 간섭 플레이크로, **순정 dev(f37304e0)에서도 동일 재현**(2375/6) 및 단독 실행 시 양쪽 모두 10/10 PASS. 이번 변경과 무관(기존 이슈).

## C-게이트 리뷰 (sol Hegel, 독립 리뷰어)

- 1차: NEAR-PASS — MINOR 2건.
  - MINOR-1: OAuth CLI 기본 헤더(x-grok-client-version 등)가 사용자 mixed-case 오버라이드와 중복 병합될 수 있음 → **수정 랜딩** (`withoutUserOverridden()` + mixed-case 테스트).
  - MINOR-2: 429 회전 후 conv-id 재부착의 통합 테스트 부재 → **잔여 수용** (회전 경로는 리뷰어가 정적 검증 완료, 단위 커버리지는 존재).
- 리뷰어 정적 확인: parsed TDZ 없음(responses.ts:453-460), 비-xai identity 반환으로 wire override 회귀 없음, registry→router 병합 경로 확인, conv-id는 sha256 32-hex만 전송·원문 키 로그 유출 없음, privacy scan PASS.

## 라이브 스모크 — PASS (로그인 후 재검증, 2026-07-13)

- 최초 검증은 양 턴 403 `personal-team-blocked:spending-limit`로 막혔다. cli-chat-proxy.grok.com과 api.x.ai 직접 호출이 같은 상태를 반환해 당시에는 계정 한도 문제로 판정했다.
- xAI 재로그인 후 dev 서버 :10199와 설치된 v2.7.9 서버 :10100에서 각각 같은 대화와 `prompt_cache_key`로 2회 요청했다.
- 두 경로 모두 HTTP 200. 1차 요청은 `cached_tokens=128`, 2차 요청은 `cached_tokens=1152`를 보고했다.
- 프로덕션 `/api/logs`도 두 요청을 `usageStatus=reported`와 `cacheReadInputTokens=128 → 1152`로 기록했다.
- 별도 멀티턴 검증에서는 1차 응답의 message+reasoning 항목을 2차 입력에 재전송했다. 두 턴 모두 HTTP 200, 문맥값 `nonce-73` 보존, 캐시 읽기 `128 → 768`을 확인했다.
- 판정: xAI OAuth 구독 전송, 실제 캐시 사용, 멀티턴 reasoning 재전송, 캐시 사용량 파싱과 로그 표기까지 라이브 PASS. `x-grok-conv-id` 헤더 생성·부착은 단위 테스트로 검증했으며, 캐시 증가가 이 헤더 하나 때문에 발생했다는 인과 효과까지 라이브에서 분리 측정한 것은 아니다.
- 증적: `.codexclaw/evidence/019f519e-cb5e-7ee1-8a89-47cbd7d6e185/qa/grok-cache-live/`

## 부수 관찰

- ~/.opencodex/config.json이 이미 87바이트 정크(port:1, defaultProvider:"none")로 깨져 있었음(260712 15:26Z 계열 .invalid 백업들). dev loadConfig 폴백이 기본 설정으로 복구함 — 프로덕션(10100)은 메모리 스냅샷으로 계속 정상 동작. 사용자 풀 설정 백업은 config.json.bak-260709 (17KB).
