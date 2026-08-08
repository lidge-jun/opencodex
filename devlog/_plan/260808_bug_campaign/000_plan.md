# 260808 — 전량 버그 이슈/PR 캠페인: 로드맵

Base: `origin/dev@a259d63dc` (2026-08-08 커트오프, 감사 후 재동결).
Cycle: docs-first. 이 유닛은 계획만 쓴다. 프로덕션 코드는 다음 사이클부터.

> 감사(A) 이력: 독립 감사를 5라운드 돌렸다(블로커 9, 5, 5, 4, 3건). 전부
> 반영했고 반박한 항목은 없다. 주요 교정은 close 판정 2건 철회(#1176, #1024),
> 인벤토리 재동결과 라벨 기반 게이트 도입, WP3 스택 해체(#1255 머지),
> 활성화 시나리오 보강, 의존성 순서 정정이다. 인용 13건은 감사에서 전부
> 정확한 것으로 확인됐다.
>
> 감사 중에도 라이브 상태가 계속 움직였다 — PR #1263, #1264, #1265, #1266이
> 새로 열리고 #1255, #1257이 머지됐으며 이슈 3건이 닫혔다. 문서를 한 시점에
> 얼려두는 대신 WP1의 라이브 갱신 게이트가 실행 직전에 차이를 흡수한다.

## 이 유닛이 존재하는 이유

열린 이슈 중 버그 계열이 25건, 열린 PR 중 버그 계열이 28건이다(#1266 포함,
종결분 제외). 그중 #1265는 `main` 타겟 릴리스 경로라 배제하므로 **실제 처리
대상은 27건**이다. 지난
캠페인들이 개별 항목을 처리했지만 이번에는 커트오프 시점의 **전량**에 터미널
처분을 내린다. 처분은 셋 중 하나다: 리베이스 후 공동커밋으로 재발행, 위양성
판정 후 close, 업스트림 차단 등으로 tracking 유지.

방식은 사용자가 지정했다. 기여자에게 체크리스트 완료를 요청해 기다리는 대신
**maintainer가 직접 `origin/dev` 위로 리베이스하고 새 PR을 연다.** 원작자는
`Co-authored-by` 트레일러와 PR 본문 멘션으로 보존한다.

## 선행 발견: CI 승인 병목이 재발했다

처분을 논하기 전에 구조적 사실 하나를 기록한다. `action_required` 상태로 멈춘
워크플로 런이 52개 브랜치에 걸쳐 쌓여 있고, 그중 **열린 PR 26건이 CI 승인 대기로
막혀 있다.**

이것이 "기여자들이 CI를 안 돌렸다"처럼 보이는 현상의 실제 원인이다.
`enforce-target`의 준비완료 게이트는 head의 `ci` 체크가 green임을 확인해야
draft를 벗기는데, 애초에 실행 허가를 받지 못한 런은 green이 될 수 없다. 작성자가
무엇을 하든 draft에서 나올 수 없는 구조다.

따라서 **열린 PR에 속한 런의 승인이 모든 처분의 선행조건**이다. 52개 브랜치
전부를 승인할 필요는 없다 — 대부분 이미 머지됐거나 버려진 브랜치다.

막힌 PR 26건: #1260 #1259 #1258 #1256 #1249 #1244 #1240 #1235 #1228 #1226 #1224
#1212 #1210 #1209 #1205 #1202 #1195 #1192 #1189 #1187 #1185 #1184 #1178 #1169
#1109 #1010.

## 처분 요약

모든 판정은 PR 설명이 아니라 diff와 현행 트리를 읽어 도출했다. 근거는
`003_disposition_matrix.md`에 file:line으로 남긴다.

### 재발행 대상 (리베이스 + 공동커밋)

| 대상 | 원작자 | 근거 요약 |
|---|---|---|
| #1189 history index stream tail | luvs01 | `src/routing/history/indexer.ts:195` 이 미인덱스 tail 전체를 `Buffer.allocUnsafe`로 할당 |
| #1187 routing analytics malformed | luvs01 | `src/routing/analytics.ts:153` 가 비배열 `attempts`에 런타임 검증 없이 접근 |
| #1184 command-code own lookups | luvs01 | `src/adapters/command-code.ts:321,350` 이 프로토타입 상속 키를 그대로 해석 |
| #1258 reasoning-effort trace 경계 | luvs01 | `src/routing/trace.ts:468-474` 가 앞부분만 검증하고 전체 배열을 순회 |
| #1256 usage 시작 hydration 경계 | luvs01 | `src/usage/log.ts:658-664` 가 파일 전체를 `Buffer.alloc` |
| #1195 unbound quota 증거 | luvs01 | `src/router.ts:516-533` 이 미바인딩 계정을 대체 주입 |
| #1202 history lock 오탐 | Yuxin-Qiao | `src/codex/inject.ts:1036-1041` 이 모든 실패를 lock 문구로 수렴 |
| #1169 codex-shim readiness | TyroneXie | `src/cli/index.ts:1151-1155` 가 라우팅 확인 없이 green 출력 |
| #1192 bounded SSE 확장 | luvs01 | `src/server/responses-json-events.ts:24-51` 이 전 프레임을 한 문자열로 결합 |
| #1249 빈 data 프레임 | Yuxin-Qiao | `src/adapters/openai-chat.ts:951-963` 에 빈 페이로드 가드 부재 |
| #1163 combo 카탈로그 폴백 | eachann1024 | `src/codex/catalog/aggregation.ts:102-136` 이 결측 멤버와 빈 ladder를 구분 못함 |
| #1226 DeepSeek 컨텍스트 창 | iF2007 | `src/providers/registry.ts:1295-1306` 에 jawcodeBundle 부재 |
| #1224 프로바이더별 컨텍스트 캡 | iF2007 | `src/server/management/provider-routes.ts:644-655` 가 `setAll` 무관하게 전역 적용 |
| #1178 Antigravity 라이브 발견 | iF2007 | `src/providers/registry.ts:1290` 이 `liveModels: false` 고정 |
| #1244 desktop picker 라우팅 보존 | Wibias | `src/codex/catalog/sync.ts:543-549` 가 슬래시 유무로만 라우팅 행 인식 |
| #1185 Windows shard 어서션 | luvs01 | `tests/ci-workflows.test.ts:166-169` 의 약한 부분문자열 매칭 |

### 재작업 필요

| 대상 | 문제 |
|---|---|
| #1240 SSE null 프레임 | 결함은 실재하나 **종료 동작이 틀렸다.** 리포터 정정에 따르면 `data: null` 은 유효 청크 사이에 나타난다. 종료하면 뒤따르는 finish 청크와 `[DONE]` 을 버린다. 비레코드 분기를 `continue` 로 바꿔야 한다 |
| #1259 CI 페이지네이션 증거 | 코드는 정상. `hygiene` 실패 사유는 `unsponsored_surface` — 보호된 워크플로 표면을 건드려 maintainer 보안 검토와 `maintainer-sponsored` 라벨이 필요하다 |

### 위양성 — close 대상

| 대상 | 근거 |
|---|---|
| #1155 web-search buffered 정책 | 고치려는 경로가 현재 도달 불가. DeepSeek이 `0b8e608c0` 에서 bounded-JSON 정책을 폐기했고, 프로덕션 레지스트리에 opt-in 항목이 없다. `src/web-search/loop.ts:364` 는 항상 `stream: true` |
| #1119 routed reasoning 계약 (maintainer 본인 PR) | 유일한 코드 훅이 낡은 테스트 추가인데, 주장하는 계약이 이미 `tests/codex-catalog.test.ts:2391-2451` 에 존재 |
| 이슈 #1100 routed effort 미전파 | `tests/codex-catalog.test.ts:2391-2451` 에 회귀 커버리지 존재. 구현은 `aa8851f38`, `2f242bb7c`, `07e7525b8` |
| 이슈 #1128 remote compaction | `src/server/responses/compact.ts:651-665` 가 이미 내부적으로 `stream: false` |
| 이슈 #1102 wildcard bind | 이미 구현·전달됨. `src/server/index.ts:499-540`, 실소켓 테스트 `tests/loopback-listener-integration.test.ts:108-122` |

### 직접 수정 대상 (PR 없는 이슈)

| 이슈 | 수정 위치 |
|---|---|
| #1219 SSE null 프레임 | `openai-chat.ts:961-972`, `google.ts:500-510`, `anthropic.ts:987-995`, `web-search/parse.ts:158-163` — 4곳 모두 |
| #1213 Claude Desktop 카탈로그 교체 | `gui/src/pages/ClaudeDesktop.tsx:477` 에 사전 경고/확인 부재 |
| #1229 namespaced 라우팅 모델 거부 | `src/codex/inject.ts:107-114` 가 `model_provider = "openai"` 유지 |
| #1145 opencode-zen rate limit | `src/providers/registry.ts:2023` 키드 항목에 note 부재 |
| #241 desktop picker 누락 | #1244 가 구현 후보. `src/codex/convergence.ts:191-198` 도 슬래시 기준 |
| #1059 Windows 전체 스위트 | `.github/workflows/ci.yml:413-438` dispatch-only. 최근 실제 디스패치 `31095755263` 은 4개 shard 전부 실패 |

### tracking 유지

| 이슈 | 사유 |
|---|---|
| #417 | 업스트림 `openai/codex#35161` 여전히 OPEN |
| #92 | 업스트림 `openai/codex#32031` 여전히 OPEN. dev는 조용한 전달 대신 명시적 실패로 완화만 함 |
| #1162 Cursor Claude 계열 | 정적 코드로는 핸드셰이크 원인 증명 불가. 대조 wire 캡처 필요 |
| #904, #796, #418 | 재현 캡처 부재. needs-info 유지 |

## work-phase 맵 (의존성 순)

phase 경계는 시스템의 빌드 순서를 따른다. 효율이나 난이도로 자르지 않는다.

| WP | 내용 | 선행 |
|---|---|---|
| WP0 | 이 문서군 (docs-only) | — |
| WP1 | CI 승인 해제(27건) + 무충돌 소형 13건 재발행 | WP0 |
| WP2 | SSE/스트리밍: #1219 수정 위에 #1249, #1205 | WP1 |
| WP3 | CI 워크플로 독립 2건 (#1259, #1185) | WP1, #1265 확인 |
| WP4 | 카탈로그 순차 (#1224, #1226, #1178, #1244, #1163, #1228, #1266) | WP1 |
| WP5 | PR 없는 이슈 직접 수정 | WP1 (#1145만 WP4) |
| WP6 | 처분 집행 (close 3건, tracking 11건) | WP4 |

WP3이 스택이 아닌 이유: 초안의 스택 루트 #1255가 `d55b903d8` 로 머지되어 현재
`origin/dev` 그 자체가 됐다. 남은 둘은 훅을 공유하지 않아 각각 독립 PR이다.

WP6의 close 3건: PR #1155, PR #1119, 이슈 #1128. 초안의 이슈 close 3건 중
#1100과 #1102는 캠페인 중 외부에서 닫혀 대상에서 빠졌다.

WP4가 순차인 이유: 일곱 PR이 `src/providers/registry.ts`, `src/codex/catalog/*`,
`src/types.ts`, `tests/codex-catalog.test.ts` 를 공유한다. 스택으로 쌓기보다
한 건 착지 후 다음 건을 리베이스하는 편이 캐스케이드 사고를 줄인다.

WP5의 선행 정정: 초안은 WP5 전체가 WP2를 기다린다고 했으나 실제 파일 겹침이
없어 불필요한 직렬화였다. 실제 겹침은 050-6(#1145)이 `src/providers/registry.ts`
를 #1226/#1178과 공유하는 것 하나뿐이며, 이 항목만 WP4 뒤에 온다.

050-5(#1218)도 `src/codex/catalog/metadata.ts` 를 #1244와 공유했으나, 해당
이슈가 2026-08-08T03:40:15Z에 외부에서 닫혀 **실행 대상에서 제외**됐다. 따라서
이 의존은 더 이상 존재하지 않는다.

## 검증 선행조건

이 체크아웃에서 `bun run typecheck` 가 `bun-types` 부재로 exit 1이다(감사 실측).
어떤 work-phase든 검증 명령 전에 `bun install` 을 먼저 돌린다. 그것 없이 나온
결과는 증거로 쓰지 않는다.
