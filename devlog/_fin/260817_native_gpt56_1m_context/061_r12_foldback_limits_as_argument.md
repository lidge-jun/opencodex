# 061 — R12 접기: overlay를 전역 상태가 아니라 인자로 흘린다

리뷰어 r12 FAIL, blocker 2건. 둘 다 수용하고 설계를 바꾼다.

## R12#1 — 카탈로그 직렬화가 정적 상수를 직접 읽는다

`applyNativeOpenAiContextOverride`(`parsing.ts:285`)는 accessor를 거치지 않고
`NATIVE_OPENAI_CONTEXT_OVERRIDES`를 직접 읽어 `context_window`,
`max_context_window`, `auto_compact_token_limit`을 다시 쓴다.

060대로 accessor만 고치면 `/api/models`는 낮아지는데 Codex 카탈로그는 922k로 되돌아간다.
사용자가 500k를 저장해도 실제 Codex는 922k를 본다 — 저장은 되는데 아무 일도 안 일어나는 상태.

## R12#2 — overlay 공급 수명주기가 빠졌다

accessor 인자는 `(slug, contextCap?)`뿐이다. overlay를 어떻게 넣을지 060이 말하지 않았다.

006에서 이미 이 문제로 두 번 실패했다: (a) 소비 지점마다 배관 → 전수표 누락 반복,
(b) 모듈 전역 상태 → `grok/sync.ts`가 서버 밖 `ocx ensure` 프로세스에서 돌아 주입이 안 닿음.

## 채택하는 설계: cap이 이미 흐르는 경로에 얹는다

**새 채널도, 전역 상태도 만들지 않는다.** cap은 이미 인자로 전 경로를 흐른다
(013/014에서 8곳 배관 완료). overlay를 그 인자와 **같은 자리에 묶어** 함께 흘린다.

```ts
/** 네이티브 광고 창을 낮추는 사용자 레버 두 개. 둘 다 낮추기만 한다. */
export interface NativeContextLimits {
  /** providerContextCaps.openai */
  readonly cap?: number;
  /** providers.openai.contextWindow */
  readonly providerWindow?: number;
  /** providers.openai.modelContextWindows */
  readonly modelWindows?: Readonly<Record<string, number>>;
}

/** config에서 한 번 읽어 만든다 — 호출부는 이미 config를 들고 있다. */
export function nativeContextLimits(config): NativeContextLimits;
```

기존 `contextCap?: number` 자리를 `limits?: NativeContextLimits`로 넓힌다.
cap만 넘기던 호출부는 `{ cap }` 한 줄 수정이고, config를 든 호출부는
`nativeContextLimits(config)`로 바꾸면 overlay까지 자동으로 따라간다.

**전역 상태가 아니므로 `ocx ensure` 같은 서버 밖 프로세스도 자기 config에서 읽는다.**
006의 (b) 실패가 재발하지 않는 이유다.

적용 순서(어디서나 동일):

```
권위값(922,000)
  -> min(modelWindows[slug] ?? providerWindow)   // overlay: 낮추기만
  -> min(cap)                                    // cap: 낮추기만
```

## 변경 지점

| 파일 | 변경 |
| --- | --- |
| `metadata.ts` | `NativeContextLimits`, `nativeContextLimits(config)`, accessor 2개 시그니처 확장 |
| `parsing.ts` | `applyNativeOpenAiContextOverride`가 limits를 받아 accessor와 같은 결과를 쓰도록 (R12#1) |
| `sync.ts` 4곳 | 호출부에 limits 전달 |
| cap을 넘기던 8곳 | `{ cap }` 또는 `nativeContextLimits(config)`로 교체 |
| `auth-cors.ts` | overlay 두 필드 허용 + validator (060 §1 그대로) |
| `Models.tsx` | 버튼 가드 제거 (060 §3 그대로) |

## 테스트

- overlay 500k -> 광고 500,000 (accessor **와** 카탈로그 엔트리 둘 다).
- overlay 2,000,000 -> 922,000 유지 (올리지 못함).
- overlay 500k + cap 350k -> 350,000 (R12 지적: 공존 회귀).
- 모델별 overlay가 해당 slug에만 적용되고 형제 slug는 불변.
- `applyNativeOpenAiContextOverride`의 4개 호출 경로가 같은 결과.

## R12 비차단 항목 (함께 처리)

낡은 "350k default" 표기: `context-windows.ts:74` 주석,
`docs-site/.../claude-code.md:236`, GUI 전 로케일 `en.ts:1808` 계열,
`claude-context-windows.test.ts:82` 테스트명.

## wp7 판정 (A 검토 결과)

리뷰어 확인: 829,800은 922,000의 정확한 90%, 상한까지 92,200 여유, Claude Code 2.1.233이
100k–1M 범위를 인식. 명시적 `autoCompactWindow` 설정 사용자는 영향 없음.
마커를 잃는 활성 행은 `cursor/grok-4.6`, `xai/grok-4.6` 둘 — 500k 모델이 1M 계산을
받던 쪽이 과했으므로 정정이 맞다. **wp7 코드는 유지**하고 문서만 갱신한다.

