# 002 — 네이티브 컨텍스트 결정 경로와 소비자 영향

독립 조사(subagent, 읽기 전용) 결과를 코드 재확인과 함께 정리한다.

## 단일 상수가 묶고 있는 것

`src/codex/catalog/metadata.ts:102` `NATIVE_GPT56_CONTEXT_WINDOW = 372_000`은
`NATIVE_OPENAI_CONTEXT_OVERRIDES`의 sol/terra/luna 및 Daybreak Blue 항목
(:108-111)에서 `contextWindow`와 `maxContextWindow` 양쪽에 쓰인다. 그 값은
`nativeOpenAiContextWindow(slug, cap)` (:135-141) 한 개의 accessor를 통해 전 시스템으로 퍼진다.

카탈로그 필드는 `applyNativeOpenAiContextOverride` (`src/codex/catalog/parsing.ts:269-297`)가
최종 확정한다. 여기서 `auto_compact_token_limit`은 **무조건** `floor(context_window * 0.9)`다
(:278, :291). 라우팅된 모델은 `src/codex/catalog/effort.ts:125-129`에서
`min(floor(ctx*0.9), maxInputTokens)`를 쓰는데, 네이티브에는 그 `maxInputTokens` 분리가 없다.

## 372,000 → 1,050,000 단순 치환이 깨뜨리는 것

1. **auto-compact 초과.** `floor(1.05M*0.9) = 945,000` > 측정 상한 922,000.
   클라이언트가 컴팩션을 시작하기 전에 upstream이 `context_length_exceeded`로 끊는다.
2. **input admission 무력화.** `src/server/responses/input-admission.ts:128-145`는
   configured window가 없을 때 `nativeOpenAiContextWindow(modelId)`를 ceiling으로 쓰고,
   실제 거절은 `ceiling * ADMISSION_TOLERANCE(2.5)`에서 일어난다. 현재 372k*2.5=930k로
   측정 상한 922k와 거의 겹쳐 우연히 잘 맞는다. 1.05M이면 2,625,000이 되어 게이트가 사실상 꺼진다.
   해법: `modelMaxInputTokens`가 ceiling을 좁힐 수 있으므로(:148-150) 네이티브에도 입력 상한을 알린다.
3. **Claude `[1m]` 마커의 의미 전환.** `src/claude/context-windows.ts:83-103`,
   `src/claude/agents-inject.ts`, `src/claude/desktop-3p.ts:190-205`,
   `src/server/management/shared.ts:223-240`은 window >= 1,000,000을 1M 계약으로 읽는다.
   GPT-5.6이 처음으로 authoritative 1M 모델이 된다 — 이것은 의도된 변화이며 테스트로 고정한다.
4. **Anthropic max_input_tokens 왜곡.** `src/claude/model-info.ts:84-123`은 네이티브
   `contextWindow`를 그대로 `max_input_tokens`로 쓴다. 총 컨텍스트를 입력 상한으로 광고하면
   측정된 922k와 충돌한다.
5. **combo/커스텀 합성 행.** `src/codex/catalog/provider-fetch.ts:1697, 1783`의 네이티브 합성 행은
   `maxInputTokens = contextWindow`로 만든다. 같은 왜곡이 여기서도 반복된다.
6. **번들 스냅샷 불일치.** `src/codex/data/upstream-models.json`의 372,000은 라이브(272k/872k)와도,
   측정 계약(1.05M/922k)과도 다르다. 스냅샷은 "upstream 원본 복제"라는 정체성을 가지므로
   여기서 임의로 고치는 대신 override가 권위임을 문서로 명시한다.

## 결론

계약을 **총 컨텍스트(1,050,000)** 와 **입력 상한(922,000)** 두 값으로 분리한다.
override 타입에 입력 상한 필드를 추가하고, auto-compact는
`min(floor(ctx*0.9), maxInput)`로 계산한다. 그러면 위 1·2·4·5가 한 번에 정합해진다.

## 갱신 대상 테스트 (조사 결과 + 재확인)

계약 기대값을 갱신해야 하는 것:
`tests/codex-catalog.test.ts`, `tests/codex-catalog-sync-hardening.test.ts`,
`tests/codex-convergence-account-selectors.test.ts`, `tests/native-model-toggle.test.ts`,
`tests/claude-context-windows.test.ts`, `tests/claude-desktop-native-context.test.ts`,
`tests/claude-model-info.test.ts`, `tests/grok-sync.test.ts`,
`tests/input-admission.test.ts`, `tests/route-explainability.test.ts`.

372,000을 "1M 미만" 일반 픽스처로 쓰는 것(값 유지 가능, 실제 gpt-5.6 이름을 쓰는지 확인 필요):
`tests/claude-agents-inject.test.ts`, `tests/claude-cli.test.ts`,
`tests/grok-attribution.test.ts`, `tests/grok-orphan-adoption.test.ts`, `tests/grok-status.test.ts`.

