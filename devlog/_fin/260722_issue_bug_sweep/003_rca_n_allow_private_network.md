# 003 — RCA N: built-in cloud preset의 allowPrivateNetwork opt-in 미노출 (#212, #175 경계)

- 이슈: #212 (open). #175는 dev 커밋 109b7672로 해결(GUI custom/local 토글·API PATCH·CLI 플래그) — close 후보 추적만.
- 조사: sol 레인 (2026-07-22, 현재 dev 트리 실측)
- 성격: **GUI 도달성 버그** — destination-policy 백엔드는 정상 동작.

## 증상

Clash/Mihomo fake-ip 모드에서 `api.deepseek.com`이 `198.18.1.6`(benchmark 대역)으로 해석되면
built-in DeepSeek preset 추가가 400으로 거부되는데, Add Provider 모달의 opt-in 체크박스는
`(isCustom || isLocal)`일 때만 렌더되어 클라우드 preset 사용자는 탈출구가 없다.

## 거부 경로 (파일:라인)

1. `198.18.0.0/15` benchmark 분류: `src/lib/destination-policy.ts:49,64`
2. 리터럴 목적지 거부(레지스트리 허용 또는 `provider.allowPrivateNetwork===true` 예외): `destination-policy.ts:113`
3. 호스트네임은 쓰기 시점 DNS 해석 후 A/AAAA별 분류: `destination-policy.ts:137`, benchmark 에러 방출: `:159`
4. opt-in 바이패스는 DNS 조회 전에 적용: `destination-policy.ts:152` (private/loopback/link-local/benchmark 전체에 적용)
5. config 스키마 수용: `src/config.ts:290` (로드 시 동기 검증 `:367`)
6. POST 생성 검증: `src/server/management-api.ts:535`(리터럴, `auth-cors.ts:220`) → `:548` DNS-resolved 체크 → 실패 시 400(`:551`) → 성공 시에만 persist(`:560,562`)

## Preset 분류와 노출 범위

| 카테고리 | 판별 | opt-in 노출 |
|----------|------|-------------|
| Reserved forward (`openai`) | `provider-payload.ts:19`, canonical seed 강제(`auth-cors.ts:206,238`) | **제외 유지** — form 필드 무시되는 불변 시드, forward 경계 보호 |
| Built-in cloud (DeepSeek 등) | `derive.ts:187`, `registry.ts:658` | **노출 필요 (현재 갭)** |
| Custom | `derive.ts:279`, `AddProviderModal.tsx:301` | 이미 노출 |
| Local (ollama/vllm/lmstudio) | `AddProviderModal.tsx:302`, `registry.ts:654` allowPrivateNetworkByDefault | 이미 노출 |

## 워크어라운드 실효성

- POST 실패 시 provider는 생성되지 않음 (persist 이전 400) → PATCH 경로로 직접 못 감.
- 가능: (a) proxy fake-ip-filter에 호스트 추가(권장), (b) CLI `ocx provider add --allow-private-network`,
  (c) 통과 가능한 baseUrl로 생성 후 PATCH 2회(어색하지만 가능, `management-api.ts:668,679`).

## 수정 방향 (011 패치 단위 입력)

- `gui/src/components/AddProviderModal.tsx:478`의 가드를 `(isCustom || isLocal)` → `!isReservedForward`로 완화.
- 미사용 i18n 힌트 `modal.allowPrivateNetworkHint`를 체크박스 옆에 렌더 (en.ts:481, ko.ts:443, zh.ts:443, de.ts:426, ru.ts:483 존재 확인).
- 보안 불변식: 기본 false — 초기 custom 폼 초기화 `AddProviderModal.tsx:54`, preset 선택 리셋 `:147` (011 테스트는 두 경로 모두 커버할 것); 에러 후 자동 활성화 금지, POST payload는 체크 시에만 포함(`provider-payload.ts:53`), reserved 제외 유지, metadata 목적지 무조건 차단(`destination-policy.ts:117,163`).
- 위협 노트: 백엔드 능력 추가는 아니고 GUI 활성화 표면 확대. per-provider 명시적·기본 off·metadata 불가 유지.

## 테스트 커버리지

- 기존: `tests/destination-policy-resolved.test.ts:11,33,66`, `tests/server-auth.test.ts:664,724,754`.
- 추가 필요: built-in preset 기본 unchecked, 체크 시 POST body 포함, reserved 미노출, 힌트 렌더, 가시성 predicate 테스트(현재 AddProviderModal 전용 테스트 부재).
