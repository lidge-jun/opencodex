# 005 — 감사 접기(fold-back): 리뷰어 blocker 10건 처리

A 페이즈 독립 리뷰어(explorer, 읽기 전용) 판정 FAIL / blockers=10. 아래는 각 blocker의
수용 또는 반박과 계획 수정 내용이다. 리뷰어가 실행한 기준선: `bun test --isolate
tests/codex-catalog.test.ts` 184 pass / 0 fail, `bun x tsc --noEmit` exit 0.

## B1 — Daybreak 1.05M 승계 (수용, 단 사용자 결정으로 포함)

리뷰어 지적: Daybreak Blue가 GPT-5.6과 같은 상수에 묶여 있는데 실측 대상이 아니었다.

본 세션에서 실제로 쏴봤다: `gpt-daybreak-blue-latest`는 이 계정에서
`HTTP 400 {"detail":"The 'gpt-daybreak-blue-latest' model is not supported when using
Codex with a ChatGPT account."}` — 접근 권한이 없어 **측정 불가**.

결정: 사용자가 "접근 권한 있는 다른 사용자에게서 동작 확인됨"을 근거로 포함을 지시했다.
Daybreak도 1,050,000 / 922,000 계약에 포함한다. 단 코드 주석과 이 문서에
**"본 계정 미측정 · 사용자 확인 기반"**으로 출처를 구분해 남긴다. sol/terra/luna의
직접 측정과 같은 등급의 증거가 아니다.

## B2 — maxInputTokens 필드 체인 누락 (수용)

010의 파일 변경 맵에 다음을 추가한다.

| 단계 | 위치 |
| --- | --- |
| 생성 | `src/codex/catalog/metadata.ts` — `NATIVE_GPT56_MAX_INPUT_TOKENS`, override의 `maxInputTokens`, `nativeOpenAiMaxInputTokens()` |
| barrel 재수출 | `src/codex/catalog.ts:5` export 목록에 `nativeOpenAiMaxInputTokens` 추가 (없으면 `claude/model-info.ts`가 import 불가) |
| 직렬화 | N/A — 정적 상수이며 config에 저장되지 않는다 |
| 역직렬화 | N/A — 같은 이유 |
| 소비자 1 | `src/codex/catalog/parsing.ts` auto-compact `min()` |
| 소비자 2 | `src/server/responses/input-admission.ts` ceiling |
| 소비자 3 | `src/claude/model-info.ts` Anthropic `max_input_tokens` |
| 소비자 4 | `src/codex/catalog/provider-fetch.ts:1715` 네이티브 combo 합성 행 (`maxInputTokens: contextWindow`) |
| 소비자 5 | 같은 파일 combo fallback 합성 (`ComboCatalogMemberFallback` 경로, :747 부근 `addMaxInput`) |
| 소비자 6 | 같은 파일 forward native custom alias (:1783 부근 — 리뷰어 지적대로 이 자리에는 직접 대입이 없고 `customContextWindow` 파생이 있다. 여기서 입력 상한을 별도로 심는다) |
| 소비자 7 | `src/server/management/model-rows.ts` — `nativeModelRows`가 실어 보낸 값이 버려지지 않도록 매핑에 추가 |

## B3 — applyNativeOpenAiContextOverride 호출부 (수용)

010/020이 지목한 `sync.ts:1425-1428`은 틀렸다. 실제 호출부는 네 곳이다:
`src/codex/catalog/sync.ts:231` (pinned upstream), `:340` (template),
`:386` (fallback), `:1079` (최종 merge/preserved). overlay를 받도록 넓힐 때
**네 곳 모두**를 같은 방식으로 고친다. fresh / fallback / preserved / account-qualified
행 각각에 대해 동일 결과가 나오는 테스트를 넣는다.

## B4 — routing/capability.ts 미연결 (수용)

`src/routing/capability.ts:163-172`는 provider overlay를 **먼저** 채택하므로
overlay 2,000,000이면 라우팅 증거가 2M을 보고한다. 카탈로그 resolver와 동일한
`min(권위값, overlay, cap)` 순서를 쓰도록 파일 변경 맵에 추가한다.
테스트: overlay 2M → 1.05M, overlay 500k → 500k, cap 350k → 350k.

## B5 — input-admission overlay 시 네이티브 분기 미도달 (수용)

`resolveInputCeiling`은 `configured !== null`이면 네이티브 분기를 건너뛴다.
따라서 1.05M overlay 저장 후 ceiling이 922k가 아니라 1.05M이 된다.

수정: canonical 네이티브 provider일 때 `nativeOpenAiMaxInputTokens(modelId)`를
**configured와 무관하게** 계산해 최종 `min`에 넣는다. 테스트는 overlay가 켜진 상태에서도
ceiling이 922,000임을 확인한다.

또한 이 게이트는 `ceiling * 2.5` 소프트 게이트임을 문서에 명시한다. 922k 하드 거절
게이트가 아니며, 이번 유닛에서 하드 게이트로 바꾸지 않는다 (범위 밖).

## B6 — 272k/372k "그룹 전체 적용" 수용 기준 모순 (수용)

resolver가 `min(권위값, overlay)`이므로 372k를 gpt-5.5에 걸어도 272k가 유지된다.
수용 기준을 다음으로 고친다:

> 프리셋은 그룹의 모든 모델에 **상한 overlay를 기록**한다. 권위값이 더 낮은 모델은
> 낮은 값을 유지한다 (프리셋은 올리는 도구가 아니라 낮추는 도구다).
> 검증은 PATCH 바디가 아니라 PATCH 후 `/api/models`의 effective window로 한다.

1.05M만 예외적으로 지원 모델 gating을 갖는다 (권위값 자체를 올리는 유일한 경로이므로).

## B7 — supportsOneMillionContext 필드 체인 (수용)

| 단계 | 위치 |
| --- | --- |
| 생성 | `src/codex/catalog/metadata.ts` `NATIVE_OPENAI_1M_MODELS` → `nativeModelRows` |
| 서버 타입 | `src/server/management/model-rows.ts` `ManagementModelRow`에 `supportsOneMillionContext?: boolean` |
| 직렬화 | `/api/models` JSON (기존 행 스프레드 경로) |
| GUI 타입 | `gui/src/pages/models-shared.ts` `ModelRow`에 동일 필드 |
| GUI 캐시 | Models 페이지의 캐시된 모델 목록 경로 — 캐시 리로드 후에도 필드가 남는지 테스트 |
| 소비자 | 프리셋 드롭다운의 1.05M 분기 |

## B8 — nativeProviderGroup 소비자 미지정 (수용)

020에 소유권 표를 추가한다.

| UI 요소 | 소유 필드 |
| --- | --- |
| 네이티브 배지 / 네이티브 힌트 | `nativeProviderGroup` |
| 컨텍스트 윈도우 / 커스텀 추가 / cap 컨트롤 노출 | `nativeProviderGroup` (항상 노출로 바뀌므로 사실상 무조건) |
| 행 단위 토글의 native 플래그 | 각 행의 `native` |

`allRowsNative`는 더 이상 카드 정체성을 결정하지 않는다. 커스텀 행 추가 전후 렌더 테스트를 넣는다.

## B9 — auth-cors overlay 예외의 write 경계 (수용)

canonical 비교 전에 두 필드를 **삭제만** 하면 POST/reload 경로에서 `contextWindow: "bad"`가
통과한다. 삭제 전에 공통 validator로 검증한다: `contextWindow`는 양의 safe integer 또는 null,
`modelContextWindows`는 비어있지 않은 키 → 양의 safe integer 또는 null의 plain object.
검증 실패면 400. 테스트에 문자열, unsafe integer, blank key, unknown field를 넣는다.

## B10 — 문서/GUI 빌드 검증 누락 (수용)

- `fmtK(1_050_000)`은 현재 `"1050k"`를 반환한다 (`gui/src/pages/models-shared.ts:85-88`).
  1,000,000 이상은 `M` 단위로 표기하도록 고치고 단위 테스트를 넣는다.
- docs-site의 372k 언급을 갱신한다: `guides/codex-app-models.md`, `guides/providers.md`,
  `reference/configuration/providers.md`와 각 로케일(ja/ko/ru/tr/zh-cn/zh-tw/fr) 대응 파일.
- 040의 검증 목록에 `cd gui && bun run lint:i18n`, `cd gui && bun run build`를 추가한다.

## 판정 (R1)

10건 전부 계획 수정으로 접었다(fold). 리뷰어가 반박된 항목은 없다. 근거 오류 3건
(sync.ts 호출부 라인, provider-fetch:1783 대입 부재, fmtK 동작)은 리뷰어가 맞고 계획이 틀렸다.

## 라운드 2 (재감사)

접기 결과를 두 번째 독립 리뷰어가 재검토해 3건을 더 잡았다. 전부 코드로 재확인했고 수용했다.

### R2#1 — `[1m]` variant가 922k를 덮어씀 (High, 수용)

`src/claude/model-info.ts:120-133` `push1mVariant`는 `max_input_tokens: ONE_MILLION`을
**하드코딩**한다(:131). 기본 행만 922k로 고치면 variant가 다시 1,000,000을 광고해
측정 상한을 넘는다. 010 §5에 (a) 기본 행, (b) variant 두 지점 수정으로 반영.
variant **생성 조건**(권위 window >= 1M, #854 회귀 방지)은 건드리지 않는다.

### R2#2 — combo fallback / custom alias 입력 상한 계약 불완전 (High, 수용)

`ComboCatalogMemberFallback`(`provider-fetch.ts:704`)에는 입력 상한 필드가 없다 —
인터페이스에 추가해야 한다. custom alias(:1783)는 `customContextWindow`가 이미
`min(cm.contextWindow, nativeAliasContextWindow)`로 낮아질 수 있으므로, 입력 상한을
그냥 심으면 context 500k / maxInput 922k 모순 행이 나온다. 최종 context와 다시 `min`한다.
불변식 `maxInputTokens <= contextWindow`를 카탈로그 전 행 테스트로 고정한다.

### R2#3 — 030 목표 문구와 Daybreak 결정 모순 (Medium, 수용)

"실측으로 확인된 모델만"이라는 문구가 미측정 Daybreak 포함과 모순된다.
"1M 계약이 확인된 모델"로 고치고 직접 측정 / 사용자 확인 두 등급을 명시했다.

## 라운드 3 (최종 확인)

세 번째 독립 리뷰어(launch r2-20260817013836)가 4건을 더 잡았다. 전부 수용.

### R3#1 — 하향 프리셋이 모델별 overlay를 이기지 못함 (High)

모델별 `modelContextWindows`가 provider-wide `contextWindow`보다 우선한다.
1.05M을 건 뒤 372k를 provider-wide로만 기록하면 sol은 1.05M에 그대로 남는다.
하향 프리셋도 그룹 전 모델의 `modelContextWindows`를 명시적으로 덮어쓰도록 030을 고쳤다.
회귀 테스트: 1.05M → 372k 순서 적용 후 effective window가 372,000.

### R3#2 — resolver 연결 범위 불완전 (High)

resolver를 만들고 라우팅에만 연결하면 combo/custom/Claude 경로가 여전히 권위값을 광고한다.
020에 소비자 전수 표를 넣었다: capability.ts, provider-fetch :1708/:1733/:1784,
claude/context-windows.ts:99, claude/model-info.ts:137-139, claude/desktop-3p.ts:202,
management/shared.ts:223-240. 각 경로에 overlay 500k 반영 테스트를 건다.

### R3#3 — full-object 경계의 `null` 허용 (High)

`null`은 PATCH의 삭제 신호이고 `applyProviderPatchFields`가 정규화한다. 그러나
`providerManagementConfigError`는 POST/reload에서도 쓰이며 거기엔 정규화가 없어
`contextWindow: null`이 디스크에 남을 수 있다. full-object 경계에서는 null을 거부하도록 고쳤다.

### R3#4 — docs-site 빌드 검증 누락 (Medium)

다국어 문서를 고치면서 `cd docs-site && bun install --frozen-lockfile && bun run build`가
없었다. 040 검증 목록에 추가했다.
