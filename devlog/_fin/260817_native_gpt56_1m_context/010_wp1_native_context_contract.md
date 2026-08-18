# 010 — WP1: 네이티브 GPT-5.6 컨텍스트 계약 (1,050,000 / 922,000)

의존: 없음 (foundation). 이 단계가 나머지 모든 단계의 값 계약을 확정한다.
감사 반영: 005_audit_foldback.md B1/B2/B3/B5.

## 목표

네이티브 gpt-5.6-sol/terra/luna(및 Daybreak Blue)의 광고 컨텍스트를 001의 측정 계약으로
바꾸되, 총 컨텍스트와 입력 상한을 **분리**한다. auto-compact와 input admission이
측정 상한 922,000을 넘지 않아야 한다.

## 파일 변경 맵

### 1. `src/codex/catalog/metadata.ts` (MODIFY)

- `NATIVE_GPT56_CONTEXT_WINDOW = 372_000` → `1_050_000`.
- 신규 `export const NATIVE_GPT56_MAX_INPUT_TOKENS = 922_000;` — 001 E2 측정 근거를 주석으로.
- `NATIVE_OPENAI_CONTEXT_OVERRIDES` 값 타입에 `maxInputTokens?: number` 추가.
  sol/terra/luna에 `maxInputTokens: NATIVE_GPT56_MAX_INPUT_TOKENS` 추가.
- **Daybreak Blue**(`NATIVE_DAYBREAK_BLUE_MODEL`)도 같은 값으로 포함한다.
  주석 필수: 이 계정에서는 `HTTP 400 "not supported when using Codex with a ChatGPT
  account"`로 **직접 측정 불가**였고, 접근 권한이 있는 사용자의 확인을 근거로 승격했다.
  sol/terra/luna의 직접 측정과 증거 등급이 다르다는 점을 명시한다.
- gpt-5.5 / gpt-5.4 / gpt-5.3-codex-spark 항목은 **손대지 않는다**.
- 신규 `export function nativeOpenAiMaxInputTokens(slug, contextCap?): number | undefined`
  — override의 `maxInputTokens`를 반환하고, cap이 있으면 `min(maxInput, cap)`.
- `nativeModelRows`가 반환하는 행에 `maxInputTokens`를 함께 싣는다.

### 2. `src/codex/catalog.ts` (MODIFY) — B2

barrel export 목록(:5)에 `nativeOpenAiMaxInputTokens`와
`NATIVE_GPT56_MAX_INPUT_TOKENS`를 추가한다. 이게 없으면 `src/claude/model-info.ts`가
기존 barrel import 경로로 새 helper를 쓸 수 없다.

### 3. `src/codex/catalog/parsing.ts` (MODIFY)

`applyNativeOpenAiContextOverride` (:269-297):

- `auto_compact_token_limit`을 `min(floor(ctx*0.9), maxInputTokens ?? Infinity)`로 계산
  (:278, :291 두 지점 모두).
- provider cap이 컨텍스트를 낮추면 `maxInputTokens`도 `min(maxInput, cappedContext)`로 좁힌다.

기대값: cap 없음 → context 1,050,000 / max_context 1,050,000 / auto_compact 922,000.
cap 350,000 → context 350,000 / auto_compact 315,000.

### 4. `src/server/responses/input-admission.ts` (MODIFY) — B5

`resolveInputCeiling` (:133-151)은 현재 `configured !== null`이면 네이티브 분기를
건너뛴다. overlay가 저장되면 ceiling이 922k가 아니라 overlay 값이 된다.

수정: canonical 네이티브 provider + bare slug일 때 `nativeOpenAiMaxInputTokens(modelId)`를
**configured와 무관하게** 계산해 최종 `min`에 넣는다.

```
const nativeMaxInput = isCanonicalNativeBare ? positive(nativeOpenAiMaxInputTokens(modelId)) : null;
const window = configured ?? nativeContext;
return smallestPositive(window, provider.modelMaxInputTokens?.[modelId], nativeMaxInput);
```

문서화: 이 게이트는 `ceiling * ADMISSION_TOLERANCE(2.5)` 소프트 게이트다. 922k 하드 거절
게이트가 아니며 이번 유닛에서 하드 게이트로 바꾸지 않는다 (범위 밖).

### 5. `src/claude/model-info.ts` (MODIFY) — R2#1

두 지점을 모두 고쳐야 한다. 기본 행만 고치면 variant가 다시 덮어쓴다.

(a) 기본 네이티브 행의 Anthropic `max_input_tokens`에 총 컨텍스트가 아니라 입력 상한을 쓴다:
`nativeOpenAiMaxInputTokens(slug) ?? nativeOpenAiContextWindow(slug)`.

(b) `push1mVariant` (:120-133)는 현재 `max_input_tokens: ONE_MILLION`을 **하드코딩**한다(:131).
GPT-5.6이 1M 계약으로 승격되면 이 variant가 922,000을 덮어쓰고 1,000,000을 광고한다 —
측정 상한 초과. variant도 입력 상한을 존중하도록
`max_input_tokens: min(ONE_MILLION, nativeMaxInput ?? ONE_MILLION)`로 고친다.

`[1m]` variant의 **생성 조건**(권위 window >= 1M)은 그대로 둔다 — #854 회귀 방지 계약이다.
바뀌는 것은 생성 여부가 아니라 광고하는 입력 토큰 수뿐이다.

테스트: `gpt-5.6-sol[1m]` 행의 `max_input_tokens`가 1,000,000이 아니라 922,000.

### 6. `src/codex/catalog/provider-fetch.ts` (MODIFY) — B2

세 지점 모두 입력 상한을 총 컨텍스트에서 분리한다.

- :1715 네이티브 combo synthetic (`maxInputTokens: contextWindow`) →
  `nativeOpenAiMaxInputTokens(slug, cap) ?? contextWindow`.
- :747 부근 combo fallback (`addMaxInput ? { maxInputTokens: contextWindow }`) — R2#2:
  `ComboCatalogMemberFallback` 인터페이스(:704)에는 입력 상한 필드가 **없다**.
  `readonly maxInputTokens?: number`를 추가하고, 네이티브 alias fallback을 만드는 호출부에서
  `nativeOpenAiMaxInputTokens`를 채운 뒤, `addMaxInput` 분기가
  `min(contextWindow, fallback.maxInputTokens ?? Infinity)`를 심게 한다.
- :1783 부근 forward native custom alias — R2#2: 이 자리에는 직접 대입이 없고
  `customContextWindow` 파생만 있다(`min(cm.contextWindow, nativeAliasContextWindow)`).
  입력 상한을 "별도로 심기"만 하면 context 500k / maxInput 922k 같은 모순 행이 생긴다.
  반드시 최종 `customContextWindow`와 다시 `min`한다:
  `maxInputTokens = min(nativeAliasMaxInput, customContextWindow)`.

**불변식 (두 지점 공통):** 어떤 행에서도 `maxInputTokens <= contextWindow`.
테스트로 이 불변식을 카탈로그 전 행에 대해 검사한다.

### 7. `src/server/management/model-rows.ts` (MODIFY) — B2

`nativeModelRows`가 실은 `maxInputTokens`가 매핑에서 버려지지 않도록 통과시킨다.

### 7a. cap 누수 봉합 (MODIFY) — R6#1

아래 호출부는 `nativeOpenAiContextWindow(id)`를 **cap 인자 없이** 부른다. 권위값이 1.05M으로
올라가면 cap을 걸어도 이들이 계속 1.05M을 광고한다 (002에서 확인된 기존 결함이 확대됨).

accessor는 이미 `(slug, contextCap?)` 시그니처를 갖는다. 새 API 없이
`providerContextCap(config, OPENAI_CODEX_PROVIDER_ID)`를 넘기기만 하면 된다 —
**전부 config를 이미 들고 있는 자리다.**

| 위치 | 대상 |
| --- | --- |
| `src/claude/context-windows.ts:99` | 네이티브 selector map |
| `src/claude/model-info.ts` | `/v1/models` 네이티브 행 + `[1m]` variant 판정 |
| `src/claude/desktop-3p.ts:202` | Desktop 3P 후보 |
| `src/grok/sync.ts:43` | Grok 모델 목록 |
| `src/server/management/shared.ts:198` | `fetchGrokCandidateModels` |
| `src/server/management/shared.ts:231` | `buildClaudeDesktopState` |

테스트: cap 272,000 적용 후 위 여섯 경로가 전부 272,000을 보고하고,
Claude `/v1/models`에서 `[1m]` variant가 사라진다 (권위 window < 1M이 되므로).

### 8. `src/codex/data/upstream-models.json` (NO CHANGE)

스냅샷은 upstream 원본 복제라는 정체성을 유지한다. override가 권위임을 002/010에 기록한다.

### 9. 테스트

- `tests/codex-catalog.test.ts`: sol/terra/luna/Daybreak의 context 1,050,000,
  max_context 1,050,000, auto_compact 922,000. gpt-5.5는 272,000 불변.
- cap 350,000 케이스: context 350,000 / auto_compact 315,000 / maxInput ≤ 350,000.
- **호출부 4곳 균일성** (B3): `sync.ts:231`(pinned), `:340`(template), `:386`(fallback),
  `:1079`(merge/preserved) 각각을 타는 시나리오에서 같은 결과가 나오는지.
- `tests/input-admission.test.ts`: overlay 없음 → ceiling 922,000.
  **overlay 1,050,000 저장 상태에서도** ceiling 922,000 (B5 활성화 증거).
- `tests/claude-model-info.test.ts`: max_input_tokens 922,000.
- `tests/claude-context-windows.test.ts`, `tests/claude-desktop-native-context.test.ts`,
  `tests/grok-sync.test.ts`, `tests/native-model-toggle.test.ts`,
  `tests/codex-catalog-sync-hardening.test.ts`,
  `tests/codex-convergence-account-selectors.test.ts`, `tests/route-explainability.test.ts`:
  372,000 기대값 갱신.

## 수용 기준

- 포커스 테스트 통과.
- 네이티브 GPT-5.6이 Claude 경로에서 `[1m]`로 인식됨(의도된 변화, 테스트로 고정).
- gpt-5.5/5.4/spark 기대값 변화 없음.
- auto-compact와 admission ceiling 어디에서도 922,000을 초과하지 않음.

## 검증 명령 (PLAN-VERIFIER-REAL-01)

`bun test --isolate tests/codex-catalog.test.ts` — 기준선 184 pass / 0 fail (리뷰어 실행 확인).
catalog barrel을 통해 metadata/parsing/provider-fetch/sync를 실제로 읽는다.
`bun x tsc --noEmit` — tsconfig `include: ["src"]`, exit 0.
