# 030 — wp3: 표면 동기화 (GUI / docs / structure / 테스트 잔여)

## GUI

- `gui/src/provider-icons.ts:17-24,140-141` — `"devin-cli"` 아이콘/표시명 매핑 제거
  (alias가 GUI에 새로 생길 일은 없다; 저장된 구 config는 마이그레이션이 정리).
- `gui/src/pages/providers-shared.ts:59-60` — `"devin-cli": "Devin CLI"` 라벨 제거.
- `gui/public/provider-icons/README.md:107-118` — provenance 노트 갱신.

## docs-site (8개 로케일)

- `reference/adapters.md`: `## devin-cli` 섹션 제거하고 `## devin` 섹션을 통합 설명으로
  (import-first + browser fallback, retired-ACP 노트 유지). en:425-480, fr:147-155,
  ko:213-221, ja:178-186, ru:238-246, tr:311-319, zh-cn:197-205, zh-tw:169-177.
- `guides/providers.md`: `ocx login devin-cli` 행 제거, `devin` 행 갱신.
  en:179,195-196 / fr:114,129-130 / ko:101,116-117 / ja:103,118-119 / ru:112,127-128 /
  tr:127,142-143 / zh-cn:94,110-111 / zh-tw:100,115-116.
- `fr/guides/integrations.md`, `fr/reference/proxy-formats.md` 파일레벨 히트 확인.

## structure/ (소유 문서 동반 갱신 의무)

- `structure/adapters/registry.md:21-36,121` — devin-cli id 아래 ACP 제거 서사와
  `projectDevinCliAuthMode` 설명을 통합 후 상태로 갱신.
- `structure/runtime.md:286`, `structure/transports/inventory.md:97`,
  `structure/providers/xai-grok.md:92` — `src/oauth/devin-cli.ts` 경로 언급 갱신
  (파일 이동 시).
- `bun run structure:check` 통과 필수 (소유 영역 변경 시 doc 동반 규칙).

## 가격/사용량

- `src/usage/expected-prices.ts` — **변경 없음** (양쪽 id 유지, wp0 조사 근거).
- `tests/usage/usage-cost.test.ts` — **변경 없음** (121 카운트/양쪽 튜플 그대로).

## 테스트 잔여

- `tests/providers/devin-cli-authmode-migration.test.ts` — 기존 ACP 마이그레이션은 유지.
  단 registry에서 `devin-cli` 행이 사라지면 `projectDevinCliAuthMode`의 registry lookup
  가드(`entry.authKind !== "oauth"` early return)가 inert해진다 — 가드를 alias-aware로
  바꾸거나, authMode 정규화를 신규 merge 마이그레이션에 흡수하고 기존 파일은 ACP adapter
  리라이트만 남긴다. wp2에서 확정.
- `src/providers/stale-context-window-migration.ts:46-55` — `{provider:"devin"}` 시드
  10개 모델이 구 로스터 기준인지 확인, 신 로스터로 보강할지 결정.
- `src/routing/compatibility/behavior.ts:17`, `src/server/request-log.ts:1194`,
  `src/codex/catalog/provider-fetch.ts:1706` — 전부 adapter 키라 무수정.

## 스킬/CLI 표면

- `skills/ocx/` 히트 없음 (조사 완료). `ocx login devin-cli` 언급 문서가 있으면
  deprecation 언급 추가.

## 결과 기록 (2026-09-13)

wp-core 빌드에서 함께 랜딩했다 (커밋 66ca5131d): GUI 매핑 2파일 + 아이콘 README,
docs-site 8개 로케일의 adapters.md/providers.md, structure 문서 4곳의 경로 재지정.
expected-prices.ts와 usage-cost.test.ts는 설계대로 무수정 — 양쪽 id의 오버레이를 유지해
리터럴 `devin-cli`로 키잉된 과거 사용량이 계속 가격이 잡힌다. fr의 파일레벨 히트 2곳은
`devinés`/`devine`(불어 "추측한") 오탐이었다.
