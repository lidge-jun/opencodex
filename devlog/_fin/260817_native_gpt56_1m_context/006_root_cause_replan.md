# 006 — 근본 원인: 왜 감사가 3회 연속 같은 실패를 냈는가

세 라운드 연속 FAIL이 나왔고, 마지막 세 건은 전부 같은 모양이다:
"resolver 소비자 전수표에 X가 빠졌다."

- R2: model-info variant, combo fallback, custom alias
- R3: capability, provider-fetch 3곳, claude 3곳, management shared
- R4: nativeModelRows, Grok 3곳, custom rows

리뷰어를 탓할 일이 아니다. **소비자를 열거하는 방식 자체가 틀렸다.** 002가 이미 세어둔
대로 `nativeOpenAiContextWindow`의 소비자는 십수 곳이고, 그중 대부분이 config를 받지 않는
자리에서 accessor를 직접 부른다. 목록을 손으로 관리하는 한 다음 라운드에서도 빠진 곳이 나온다.

## 설계 변경 (LOOP-REPAIR-01 → P 복귀)

overlay를 **소비 지점마다** 적용하는 대신, **소스에서** 적용한다.

기존 계획: `resolveNativeOpenAiContextWindow(config, slug)`를 새로 만들고
모든 호출부를 그 함수로 갈아끼운다 → 호출부를 하나라도 놓치면 조용히 옛 값이 샌다.

새 계획: `nativeOpenAiContextWindow(slug, cap?)` **자체**가 overlay를 반영하게 한다.
config는 프로세스 시작/설정 변경 시 한 번 주입되는 모듈 스코프 상태로 둔다.
이미 존재하는 `providerContextCaps` 전달 인자와 같은 자리에서 함께 해결된다.

```
// src/codex/catalog/metadata.ts
let nativeContextOverlay: NativeContextOverlay = EMPTY;
export function setNativeContextOverlay(config: OcxConfig): void { ... }
export function nativeOpenAiContextWindow(slug, cap?) {
  const authoritative = /* 기존 override / pinned */;
  const overlaid = applyOverlay(authoritative, nativeContextOverlay, slug); // min only
  return applyProviderContextCap(overlaid, cap) ?? overlaid;
}
```

이 방식의 성질:

- **누락이 불가능하다.** 기존 호출부를 하나도 고치지 않아도 전부 overlay를 본다.
  R2/R3/R4가 지적한 13개 소비자가 전부 자동으로 해결된다.
- 소비자별 테스트는 여전히 필요하지만, 그건 *검증*이지 *구현 조건*이 아니다.
  하나 빠뜨려도 동작은 옳다.
- `providerContextCaps`가 이미 같은 문제를 이 방식으로 풀지 않고 인자 전달로 풀었기 때문에
  cap 자체도 일부 경로(Claude/Grok)에서 새고 있다 — 002에서 확인된 기존 결함이다.
  overlay를 모듈 스코프로 두면 **cap도 같은 자리에서 함께 고칠 수 있다**.

## 주입 시점

`setNativeContextOverlay`를 호출해야 하는 곳:

1. 서버 기동 시 config 로드 직후.
2. `/api/providers` PATCH 성공 후 (이미 모델 캐시를 지우고 카탈로그 convergence를 하는 자리).
3. config reload 경로.

세 곳 모두 **이미 config를 손에 들고 있는** 자리다. 새로 config를 배관할 필요가 없다.

## 위험과 대응

모듈 스코프 상태는 테스트 격리를 깨뜨릴 수 있다. 대응:

- `resetNativeContextOverlay()`를 export하고 테스트 setup에서 부른다.
- 기본값은 EMPTY이므로 주입 전 동작 = 현재 동작 (안전한 기본).
- `bun test --isolate`가 이미 이 저장소의 표준 실행 방식이다 (AGENTS.md 참조 경로).

## 잔여 항목 (R4가 지적한 것 중 이 설계로 해결되지 않는 것)

R4#3 — 커스텀 행의 `contextWindow`는 `customModels[]`에서 직접 오므로 네이티브 accessor를
타지 않는다. 이건 별개 문제다. 결론: **하향 프리셋의 계약을 "네이티브 행"으로 좁힌다.**
커스텀 행은 사용자가 직접 값을 넣어 만든 것이므로 프리셋이 덮어쓰지 않는 편이 옳다.
030의 수용 기준을 그렇게 고친다.

