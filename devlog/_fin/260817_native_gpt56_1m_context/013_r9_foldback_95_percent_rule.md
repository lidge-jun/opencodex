# 013 — 감사 접기(R9): 998k의 진짜 원인과 970,000이라는 답

012의 진단은 틀렸다. 리뷰어가 뒤집었고, codex-rs 소스로 확인했다.

## R9#1 — 998k는 베이스라인 차감이 아니라 95% 규칙 (수용, 진단 교체)

```rust
// codex-rs/protocol/src/openai_models.rs:355
const fn default_effective_context_window_percent() -> i64 { 95 }

// codex-rs/core/src/session/turn_context.rs:208-214
pub(crate) fn model_context_window(&self) -> Option<i64> {
    let pct = self.model_info.effective_context_window_percent;
    self.model_info.resolved_context_window()
        .map(|cw| cw.saturating_mul(pct) / 100)
}
```

`context_window.rs:54`가 이 값을 `full_context_window_limit`으로 쓴다. 즉 Codex가 실제로
채우려는 한도는 `context_window × 0.95`다.

검산이 전부 맞는다:

| slug | context_window | ×95% | 표시 |
| --- | --- | --- | --- |
| gpt-5.6 (현재 배포) | 1,050,000 | 997,500 | **998k** |
| gpt-5.4 | 1,000,000 | 950,000 | 950k |
| gpt-5.5 | 272,000 | 258,400 | 258k |
| gpt-5.3-codex-spark | 100,000 | 95,000 | 95k |

52k 베이스라인 가설은 우연히 5.6 한 줄에만 들어맞았다. 다른 행으로 교차검증했으면
바로 깨졌을 것이다.

## 그래서 922,000이 아니라 970,000이다 (012의 결론 폐기)

012는 `context_window = 922,000`을 제안했다. 그러면 Codex 한도는
`922,000 × 0.95 = 875,900`이 되어, **실측으로 통과하는 입력 46,100토큰을 그냥 버린다.**
리뷰어의 지적이 정확하다.

목표를 다시 쓰면: **95%를 적용한 결과가 922,000 바로 아래가 되어야 한다.**

```
필요한 ctx = 922,000 / 0.95 = 970,526
채택값     = 970,000  ->  970,000 × 0.95 = 921,500
```

921,500은 실측 통과 구간(921,160 성공 / 923,000 거절) 안에 있고 922,000을 넘지 않는다.
화면에는 "922k"로 표시된다 — 사용자가 기대한 바로 그 숫자다.

970,526 대신 970,000을 쓰는 이유는 500토큰 여유이고, 반올림 표시가 동일하다.

| 안 | ctx | Codex 한도 | 평가 |
| --- | --- | --- | --- |
| 현행 | 1,050,000 | 997,500 | 상한 75,500 초과 |
| 012안 | 922,000 | 875,900 | 46,100 손해 |
| **채택** | **970,000** | **921,500** | 상한 바로 아래, 손실 없음 |

## auto_compact

`min(floor(970000*0.9), 922000) = min(873,000, 922,000) = 873,000`.
90% 규칙이 자연스럽게 다시 작아지고, 010의 클램프는 유지된다(발화만 안 할 뿐).
873,000은 Codex 한도 921,500보다 낮아 compaction이 한도 전에 돈다 — 정상이다.

## R9#2 — `[1m]` 파급이 전부 사라지는 게 아니다 (수용)

970,000도 1,000,000 미만이라 파급 자체는 012와 같지만, 리뷰어가 지적한 대로
"전부 사라진다"는 서술이 틀렸다. 실제로는:

| 경로 | 970,000에서 |
| --- | --- |
| Claude `/v1/models` `[1m]` variant | 사라짐 |
| Desktop `supports1m`/`prefer1m`, management chip | false |
| subagent 정의 마커 | 제거됨 |
| **main-session auto-context** | **여전히 붙음** — `970k >= compactWindow(350k)`이므로 |
| 이미 명시된 `[1m]` selector | 그대로 통과 |

마지막 두 줄이 012가 놓친 부분이다. `autoContext:false`일 때만 안 붙는다.
따라서 010 이전 상태로 일괄 되돌리면 안 되고, 경로별로 다르게 기대해야 한다.

## R9#3 — GUI 프리셋 (수용)

`NATIVE_CAP_OPTIONS`의 1,050,000은 이제 권위값 970,000보다 커서 아무 효과가 없는
선택지가 된다(cap은 낮추기만 한다). `970_000`으로 교체한다.
`fmtK(970_000)` = "970k"이므로 M 표기 테스트는 1,000,000 케이스로 유지한다.

## Daybreak

같은 상수를 공유하므로 970,000으로 함께 내려간다. 012에 빠졌던 파급이며, 명시한다.

## 유지하는 것

- API 키 경로(`openai-apikey`)와 OpenRouter의 1,050,000 / 922,000: 별도 provider 계약.
  Codex의 95% 규칙은 네이티브 카탈로그에만 적용된다.
- `NATIVE_GPT56_MAX_INPUT_TOKENS = 922,000`: 입력 상한 자체는 변함없다.
- `min(90%, maxInput)` 클램프: routed/API 경로에서 계속 필요하다.

## 갱신 대상 (리뷰어 전수 + Daybreak)

`tests/codex-catalog.test.ts`, `tests/codex-catalog-sync-hardening.test.ts`,
`tests/codex-convergence-account-selectors.test.ts`, `tests/claude-context-windows.test.ts`,
`tests/claude-desktop-native-context.test.ts`, `tests/claude-model-info.test.ts`,
`tests/desktop-3p.test.ts`, `tests/grok-sync.test.ts`, `tests/native-model-toggle.test.ts`,
`tests/route-explainability.test.ts`, `gui/tests/models-native-group-controls.test.ts`.
API-key/routed 픽스처의 1.05M/922k는 건드리지 않는다.

문서는 native 주장만 수정한다 (`structure/08`, 각 로케일의 `guides/codex-app-models.md`,
`guides/providers.md`, `reference/configuration/providers.md`).
`structure/03`과 quickstart의 API-key 서술은 유지한다.

