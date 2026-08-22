# 040 — WP4: 카탈로그/레지스트리 순차 처리

선행: WP1. 절차: `003_republish_protocol.md`.

## 스택이 아니라 순차인 이유

일곱 PR이 `src/providers/registry.ts`, `src/codex/catalog/*`, `src/types.ts`,
`tests/codex-catalog.test.ts` 를 공유한다. 스택으로 쌓으면 하단이 바뀔 때마다
상단 전체를 다시 쌓아야 하는데, #1244가 52커밋 57파일이라 캐스케이드 비용이
감당이 안 된다.

대신 한 건 착지 후 dev 리베이스, 그다음 건 순으로 간다. 각 단계가 독립적으로
검증되므로 중간에 멈춰도 상태가 일관된다.

순서: `#1224`, `#1226`, `#1178`, `#1266`, `#1244`, `#1163`, `#1228`

앞의 셋이 카탈로그 코어와 프로바이더 발견을 정리하고, #1266이 그 위에서 Google
Vertex 재생 경로를, #1244가 Desktop picker 보존을, #1163이 combo 합성을 얹는다.
#1228을 맨 뒤에 두는 이유는 24파일 규모이면서 `registry.ts` 와 `types.ts` 를
앞선 전원과 공유하기 때문이다. #1266이 #1178 바로 뒤인 이유는 둘 다
Google/Antigravity 경로를 건드리기 때문이다.

### 충돌 매트릭스

| 쌍 | 공유 표면 | 처리 |
|---|---|---|
| 1224 x 1178 | `provider-routes.ts`, `types.ts` | 영역이 달라 텍스트 충돌은 낮지만 둘 다 프로바이더 관리 동작을 바꾼다. 1178을 1224 뒤에 |
| 1226 x 1178 | `registry.ts`, `codex-catalog.test.ts` | 별개 프로바이더 항목과 테스트 블록. 텍스트 충돌 낮음, 의미 회귀 위험 중간 |
| 1178 x 1244 | `provider-fetch.ts`, convergence/sync, `codex-catalog.test.ts`, `types.ts` | 최고 위험. 1178은 라이브 발견/인증/캐시 흐름을, 1244는 수집·보존된 모델이 카탈로그 합성에서 살아남는 방식을 바꾼다 |
| 1226 x 1244 | 카탈로그 테스트와 메타데이터 가정 | 1244가 카탈로그 소유권을 재편하므로 DeepSeek 메타데이터 복원 테스트를 반드시 보존 |

## 040-1 · #1224 프로바이더별 컨텍스트 캡

원작자 `xinweigao <xinwei.gao.7@yandex.com>` (13커밋, head `3e23b4b`)
원본 브랜치 `iF2007:fix/context-cap-per-provider`
새 브랜치 `codex/260808-context-cap-per-provider`

MODIFY `src/server/management/provider-routes.ts`

현재 `:644-655` 의 PUT이 `setAll` 값과 무관하게 항상
`setGlobalContextCapValue(config, body.value)` 를 호출하고 capped 프로바이더를
전부 지운다. 한 프로바이더의 캡만 바꾸려 해도 나머지 전부가 날아간다.

변경: `setAll` 이 참일 때만 전역 적용, 아니면 지정 프로바이더만 갱신.

MODIFY `src/providers/context-cap.ts`, `src/cli/models-runtime.ts`,
`gui/src/pages/Models.tsx`
MODIFY `docs-site` 5개 로케일의 `guides/model-routing.md`,
`reference/cli/providers-accounts.md`, `reference/configuration/providers.md`
MODIFY `tests/management-provider-validation.test.ts`, `tests/cli-headless-parity.test.ts`

GUI 스크린샷 필수 (`gui/src/pages/Models.tsx` 변경).

활성화 증거: `setAll: false` 로 한 프로바이더만 바꿨을 때 다른 프로바이더 캡이
보존되는지 어서션. 현재 코드에서는 red가 되어야 한다.

## 040-2 · #1226 DeepSeek V4 컨텍스트 창

원작자 `xinweigao <xinwei.gao.7@yandex.com>` (커밋 `a74325a`, `ad4459a`)
원본 브랜치 `iF2007:fix/deepseek-jawcode-metadata`
새 브랜치 `codex/260808-deepseek-jawcode-metadata`

MODIFY `src/providers/registry.ts` — `:1295-1306` 의 DeepSeek 항목에
`jawcodeBundle` 이 없고 `modelContextWindows` 가 `1_000_000` 이다. 라우팅된
재빌드에서 정확한 컨텍스트 창이 소실된다.

MODIFY `scripts/generate-jawcode-metadata.ts`, `src/generated/jawcode-model-metadata.ts`
MODIFY `tests/codex-catalog.test.ts`, `tests/provider-registry-parity.test.ts`

워크트리 충돌 주의: 현재 체크아웃에
`scripts/generate-jawcode-metadata.ts`, `src/generated/jawcode-model-metadata.ts`,
`tests/jawcode-metadata-sync.test.ts` 의 미커밋 변경과 미추적
`scripts/jawcode-models.json` 이 있다. 사용자의 작업물이므로 건드리지 않는다.
이 PR은 별도 워크트리에서 작업하거나, 해당 파일 상태를 사용자에게 확인한 뒤
진행한다. 이것이 이 phase의 유일한 차단 요인이다.

## 040-3 · #1178 Antigravity 라이브 모델 발견

원작자 `Xinwei Gao <xinweigao.1@bytedance.com>` (4커밋)
원본 브랜치 `iF2007:fix/antigravity-live-model-discovery`
새 브랜치 `codex/260808-antigravity-live-discovery`

MODIFY `src/providers/registry.ts` — `:1290` 의 `liveModels: false` 를 해제
MODIFY `src/providers/model-discovery.ts`, `model-discovery-limits.ts`,
`antigravity-models.ts`, `src/codex/model-cache.ts`,
`src/codex/catalog/provider-fetch.ts`, `src/codex/convergence-types.ts`
MODIFY `src/lib/pinned-http.ts`, `src/lib/provider-outbound.ts`, `src/oauth/index.ts`,
`src/server/management/oauth-account-routes.ts`, `provider-routes.ts`,
`src/server/responses/core.ts`, `src/config.ts`, `src/types.ts`
MODIFY docs 5개 로케일과 테스트 12개 파일

보안 민감 슬라이스다. OAuth 흐름, 아웃바운드 POST 하드닝, 캐시 동일성을
한꺼번에 바꾼다. AGENTS.md 기준 명시적 보안 검토 대상이다.

### 보안 게이트 (감사 블로커 5·9)

"검토 기록" 과 `privacy:scan` 만으로는 불충분하다. `MAINTAINERS.md:48-59` 가
요구하는 것은 명시적 검토, 담당자 지정, 출처 증거, 실패 경로 테스트다. PR을
열기 **전에** 아래 산출물을 모두 확보한다.

필수 산출물:

1. 지명된 검토자와 검토 완료 기록 (누가, 무엇을, 언제)
2. Antigravity 모델 발견 엔드포인트의 1차 출처 증거 (공식 문서 또는 프로바이더
   응답 캡처). 리버스 엔지니어링 추정만으로는 부족하다
3. 아래 다섯 활성화 시나리오의 실행 증거
4. `bun run privacy:scan` green

활성화 시나리오 — 각각 트리거와 관찰 대상을 명시한다:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| SSRF 차단 | 사설 IP·메타데이터 주소·리다이렉트 체인을 발견 URL로 주입 | 요청이 거부되고 아웃바운드가 발생하지 않음 |
| 고정 대상 허용 | 정당한 Antigravity 엔드포인트 | 요청이 정상 통과 |
| 토큰 비직렬화 | OAuth 토큰 보유 상태로 캐시·로그·에러 경로 전부 통과 | 어느 출력에도 토큰 문자열이 없음 |
| 캐시 계정 격리 | 계정 A와 B로 각각 발견 수행 | 서로의 모델 목록이 섞이지 않음 |
| OAuth 실패 | 토큰 만료·거부 응답 주입 | 정적 목록으로 안전하게 폴백, 크래시 없음 |

SSRF 차단과 토큰 비직렬화는 특히 중요하다. 둘 다 "정상 동작에서는 절대 발화하지
않는" 경로이므로, 테스트가 트리거하지 않으면 코드가 있어도 죽어 있는지 알 수 없다.

## 040-4 · #1244 Desktop picker 라우팅 모델 보존

원작자 `WZBbiao <16611004+WZBbiao@users.noreply.github.com>`,
`Wibias <37517432+Wibias@users.noreply.github.com>` (52커밋, head `67842aa`)
원본 브랜치 `lidge-jun:maintainer/supersede-1056-native-alias`
새 브랜치 `codex/260808-native-alias-picker`
해소 이슈 `#241`

MODIFY `src/codex/catalog/sync.ts`

현재 `:543-549` 의 보존 로직이 슬래시 유무로만 라우팅 행을 인식한다. Desktop
호환을 위해서는 bare native-alias 행(슬래시 없음)이 필요한데, 그런 행은 보존
대상에서 탈락한다. `src/codex/convergence.ts:191-198` 도 같은 기준이다.

변경: `opencodex_catalog_kind` 마커 기반으로 라우팅 행을 식별한다. 슬래시는
더 이상 판별 기준이 아니다.

57파일 전체 목록은 원본 PR 참조. 주요 축: `src/codex/catalog/*` 8파일,
`src/combos/*`, `src/server/management/*` 3파일, `gui/*` 3파일, docs 17파일,
tests 11파일, `structure/03_catalog-and-subagents.md`.

GUI 스크린샷 필수.

원본 리뷰에서 지적된 항목을 반드시 유지: 네이티브 복구와 백업 무결성(백업 오염과
alias 소실 방지), native-alias 행이 라우팅으로 계수되는지.

활성화 증거: bare native-alias 행이 remote `available_models` 필터링 이후에도
살아남는지 확인하는 테스트. 현재 코드에서 red여야 한다.

## 교차 work-phase 의존 (감사 블로커 8)

## 040-5 · #1163 combo 카탈로그 폴백

원작자 eachann1024
Co-authored-by: 关俊江 <each1024@qq.com>
원본 브랜치 `eachann1024:feat/combo-catalog-fallback`
원본 커밋 `39f677cb`, `99c63dbf`
새 브랜치 `codex/260808-combo-catalog-fallback`
순서: #1244 뒤 (둘 다 `src/codex/catalog/provider-fetch.ts`, `aggregation.ts` 공유)

### 결함

`src/codex/catalog/provider-fetch.ts:1276-1284` 이 이미 발견된 멤버만 취한다:

```ts
.map(target => memberByKey.get(targetKey(target)))
```

`src/codex/catalog/aggregation.ts:102-115` 이 target/member 짝과 양수
`contextWindow` 를 요구하므로 결측 멤버가 있으면 combo 전체가 탈락한다. 또한
`:134-136` 의 `member.reasoningEfforts ?? []` 가 없는 ladder를 **빈 배열**로
만드는데, 이는 "제한 없음" 이 아니라 "아무것도 허용 안 함" 으로 해석된다.

### 수정

MODIFY `src/codex/catalog.ts`, `src/codex/catalog/aggregation.ts`,
`src/codex/catalog/provider-fetch.ts` — 프로바이더 설정으로 불완전 멤버를
합성하고, ladder 부재는 빈 배열이 아니라 와일드카드로 처리한다.
MODIFY `tests/codex-catalog.test.ts`
MODIFY `docs-site` 의 `reference/configuration/routing.md` (en, zh-cn)

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| 결측 멤버 합성 | combo 멤버 하나가 발견 목록에 없는 상태 | combo가 탈락하지 않고 설정 기반으로 합성됨 |
| ladder 부재 | `reasoningEfforts` 없는 멤버 | 빈 배열이 아니라 와일드카드. 모든 effort가 통과 |
| 정상 combo | 모든 멤버 완비 | 기존과 동일 (회귀 없음) |

## 040-6 · #1228 Cursor 네이티브 이미지 지원 (대형 단독)

원작자 `SB Yoon <44089734+yansigit@users.noreply.github.com>` (10커밋)
원본 브랜치 `yansigit:audit/cursor-dev`
새 브랜치 `codex/260808-cursor-native-images`
순서: WP4 **마지막**. 24파일로 대형이며 `src/providers/registry.ts` 와
`src/types.ts` 를 앞선 항목들과 공유한다.

### 내용

Cursor 어댑터에 네이티브 이미지 입력을 추가한다. 현재는 이미지가 사이드카
경로로만 처리된다.

MODIFY `src/adapters/cursor.ts` 및 `src/adapters/cursor/` 하위 7파일
(`discovery.ts`, `effort-map.ts`, `images.ts`, `live-transport.ts`,
`protobuf-request.ts`, `request-builder.ts`, `types.ts`)
MODIFY `src/providers/registry.ts`, `src/types.ts`
MODIFY `docs-site/src/content/docs/reference/configuration/providers.md`
MODIFY 테스트 11파일 + 픽스처 `tests/helpers/cursor-grumpy-fixture.png`

### 주의

protobuf 요청 빌더를 건드린다. Cursor는 Connect 프로토콜을 쓰므로 wire 형식이
틀리면 런타임에만 드러난다. 정적 타입 통과가 정확성을 보장하지 않는다.

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| 네이티브 이미지 경로 | 비전 지원 Cursor 모델에 이미지 첨부 | protobuf 요청에 이미지 블롭이 실제로 실림. wire 하네스로 확인 |
| 비전 미지원 폴백 | 비전 미지원 모델에 이미지 | 기존 사이드카 경로 유지 |
| 이미지 없음 | 텍스트 전용 요청 | 기존과 동일 (회귀 없음) |

`tests/cursor-vision-wire-harness.test.ts` 가 실제 wire 페이로드를 검사하므로
이것이 핵심 증거다. 어댑터 단위 테스트만으로는 부족하다.

## 교차 work-phase 의존 (감사 블로커 8)

WP4가 WP5와 파일을 공유한다. 초안이 놓친 부분이다.

| 충돌 | 공유 파일 | 순서 제약 |
|---|---|---|
| WP4 #1226/#1178 x WP5 #1145 | `src/providers/registry.ts` | #1226과 #1178이 먼저. #1145는 마지막 |

따라서 WP5에서 WP4를 기다려야 하는 항목은 050-6(#1145) 하나다. 나머지 WP5
항목은 WP4와 파일이 겹치지 않아 병렬 가능하다.

초안에 있던 `#1244 x #1218` 제약은 삭제됐다. #1218이 2026-08-08T03:40:15Z에
외부에서 CLOSED 되어 050-5가 실행 대상에서 빠졌기 때문이다.

## 040-7 · #1266 Vertex thought signature 재생

원작자 `Ingwannu <ingwannu@users.noreply.github.com>`
head `c0ffaef643aee3a6b73f93db834cc6e4749b5728` (2026-08-08T06:21:28Z 기준.
최초 기록 `ae28b69ef` 에서 갱신됨 — 착수 전 재확인 필수)
원본 브랜치 `lidge-jun:agent/fix-1254-vertex-thought-signature`
새 브랜치 `codex/260808-vertex-thought-signature`
순서: #1178 뒤 (둘 다 Google/Antigravity 경로를 건드린다)

감사 라운드 5의 라이브 게이트가 잡아낸 신규 PR이다. Vertex 경로에서 thought
signature가 재생되지 않는 문제를 다룬다.

MODIFY `src/adapters/google.ts`
NEW `src/adapters/google-antigravity-replay.ts`
MODIFY `structure/04_transports-and-sidecars.md`
MODIFY `docs-site` 5개 로케일 `reference/adapters.md`
MODIFY `tests/google-vertex-thought-signature.test.ts`

#1178이 `src/adapters/google.ts` 인접 영역과 Antigravity 발견 경로를 바꾸므로
그 뒤에 리베이스한다.

활성화 시나리오:

| 경로 | 트리거 | 관찰 |
|---|---|---|
| signature 재생 | thought signature를 포함한 Vertex 응답 후속 턴 | 재생된 signature가 요청에 실림 |
| signature 부재 | signature 없는 응답 | 기존 동작 유지 (회귀 없음) |

## WP4 수용 기준

- 일곱 PR이 순차로 열리고, 각각 직전 착지 head 위에 리베이스됨
  (#1224, #1226, #1178, #1266, #1244, #1163, #1228 순)
- #1228 단계는 `bun test tests/cursor-vision-wire-harness.test.ts` 를 **필수**로
  포함한다. 이것이 protobuf wire 형식의 유일한 실증이며, `codex-catalog.test.ts`
  만으로는 Cursor 이미지 경로를 관찰하지 못한다. 함께 돌릴 것:
  `tests/cursor-images.test.ts`, `tests/cursor-request-builder.test.ts`,
  `tests/cursor-adapter.test.ts`
- 각 단계마다 `bun install` 후 `bun run typecheck` 와
  `bun test tests/codex-catalog.test.ts` green
- 1178 단계에서 위 보안 산출물 4종 전부 확보
- GUI 변경 PR(1224, 1244)에 스크린샷 첨부
- 1226은 워크트리 dirty 충돌 해소 후 진행 (사용자 확인 필요)
- 1228(Cursor 이미지, 24파일)은 대형 단독으로 마지막에 처리 (§040-6)
