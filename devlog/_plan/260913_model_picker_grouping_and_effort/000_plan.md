# 000 — Devin 추론 사다리: 피커 불일치와 Pi 컨트롤 부재

- 단위: `260913_model_picker_grouping_and_effort`
- 세션: `01a0985e-ce1a-7d12-81b9-c2e93a2bce67` (HOTL, cxc-loop)
- 기준: `origin/dev` `f7d9dbad03` (#4484 devin-cli→devin 병합 반영)

## 사용자가 말한 세 가지

| # | 증상 | 판정 |
|---|---|---|
| 1 | "gemini 처리했던거처럼 묶는 기능"이 필요하다 | **부분 NOOP** — 접기는 이미 있음, 짝이 빠졌음 |
| 2 | 추론 매칭 | **실결함** |
| 3 | Pi 커넥터로 연결하면 추론 피커가 안 보임 | **실결함** |

셋 다 뿌리가 하나다. `devin` 레지스트리 행에 `modelReasoningEfforts`가 없다.

## Gemini 선례는 두 부분이다

공용 family-grouper 같은 건 없다. 사용자가 기억한 "gemini 처리"는 Antigravity 전용
구현이고(도입 `c07f2d63dc`, 회귀 복구 `06f8e7a944`), 두 조각이 짝을 이룬다.

| 조각 | Antigravity | Devin 현재 |
|---|---|---|
| A. wire variant를 base 한 줄로 접기 | `pickerModelIdForDiscoveredWireId` + `collapsesIntoKnownPickerModel` (`antigravity-models.ts:140-156`) | **있음** — `collapseDevinModelUid` (`live-models.ts:80-86`), `provider-fetch.ts:1706-1750` |
| B. 접힌 base에 effort 사다리 붙이기 | `ANTIGRAVITY_MODEL_EFFORTS` → `modelReasoningEfforts` (`registry.ts:2139`) | **없음** (`registry.ts:1340-1358`) |

`antigravity-models.ts:148-150` 주석이 왜 짝이어야 하는지 직접 말한다.

> `gemini-3.7-flash-high` looks like a model id and is not one: it is the "high"
> rung of `gemini-3.7-flash`, whose ladder lives in ANTIGRAVITY_MODEL_EFFORTS.
> Publishing it as its own row is what breaks effort selection.

Devin은 A만 하고 B를 안 해서, 행은 하나로 접혔는데 그 행에 붙는 사다리가 Devin 것이
아니다. 그래서 "묶는 기능이 필요하다"는 체감이 나온다 — 접기는 됐지만 쓸모가 없다.

## 증상 2 — 추론 매칭 불일치

`modelReasoningEfforts`가 없으면 `applyReasoningLevels`(`effort.ts:231`)가 기본
사다리로 떨어진다.

| | 광고되는 사다리 | 실제 레인 |
|---|---|---|
| SWE-2 | low, medium, high, xhigh, max, ultra | **medium, high, max** (`devin.ts:116-126` `SWE2_EFFORT`) |

`low`를 고르면 조용히 medium으로 올라가고, `xhigh`/`ultra`도 max로 접힌다. 컨트롤이
말한 대로 동작하지 않는다. Anthropic 행 주석(`registry.ts:418-420`)이 정확히 이 기준을
세워 뒀다 — "advertising it would offer a control that does not do what it says".

## 증상 3 — Pi에서 컨트롤이 아예 안 그려짐

omp에 프로바이더 화이트리스트는 없다. `ompEfforts()`가 `ExportModel.reasoningEfforts`
(`contracts.ts:76`)를 걸러서 **비어 있지 않을 때만** `reasoning: true` +
`thinking: { mode: "effort", efforts }`를 쓴다(`omp.ts:72`). Devin은 그 배열이 비어
있으니 컨트롤이 통째로 빠진다.

이건 Pi만의 문제가 아니다. 같은 필드를 읽는 `pi`, `aside`, `prime`, `omo`, `zcode`,
`mcode`, `dsh`, `raycast`, OpenCode 계열이 전부 같이 깨진다. `cline` export는 effort
필드 자체가 없어 대상이 아니다.

선례 커밋은 `df416a439c` (#3454, Anthropic)다. 어댑터는 원래 effort를 보내고 있었는데
레지스트리가 사다리를 안 실어서 Pi형 피커가 숨었던, 글자 그대로 같은 결함이다.

## 스크린샷에 대해

사용자 스크린샷의 `swe-2 (devin-cli)` 행은 Codex app composer이고 출처는
`model_catalog_json`(`inject.ts:864`)이다. #4484가 `devin-cli` 행을 지웠으므로 그 라벨은
현재 dev에 없다 — 스크린샷은 병합 전 상태이거나 재기동 전 캐시다. 이 단위는 그 라벨을
쫓지 않고 사다리만 고친다.

## 작업 단계

| wp | 문서 | 산출물 |
|---|---|---|
| wp0 | 이 문서 + 010 | 로드맵 |
| wp1 | (이 문서에 통합) | 선례 확정 — 완료 |
| wp2 | `010_devin_effort_ladder.md` | 레지스트리 사다리 + 테스트 → PR → merge |
| wp3 | 통합 | Pi 익스포트는 같은 변경으로 해결 |

wp2와 wp3은 같은 한 줄짜리 원인을 공유하므로 PR 하나로 착지한다. 나누면 두 번째
PR이 빈 변경이 된다.

