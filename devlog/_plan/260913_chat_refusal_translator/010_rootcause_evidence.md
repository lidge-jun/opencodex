# 010 — wp1: 원인 증명 (재현 테스트)

수정 전 트리에서 실패하고 수정 후 통과하는 테스트를 먼저 세운다. 그게 이 단계의 전부다.

## NEW: tests/responses/chat-refusal-scope.test.ts

기존 `tests/responses/chat-refusal.test.ts`는 건드리지 않는다. 그 파일은 거절 계약을
지키는 곳이고, 여기는 "거절이 아닌 것에 거절 규칙이 걸리지 않는다"를 지키는 곳이다.

재현 케이스는 이벤트 두 개면 충분하다.

```ts
// 거절 파트가 어디에도 없다. 그런데 현재 트리에서는 invalid_refusal로 죽는다.
const events = [
  sse("response.output_item.added", {
    output_index: 0,
    item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] },
  }),
  sse("response.output_item.done", {
    output_index: 0,
    item: { type: "reasoning", id: "rs_1", summary: [] },
  }),
];
```

기대: 스트림이 `invalid_refusal` 없이 끝난다. 현재 트리에서는 :308이 `msg_1`을 심고
:623 → :299 → :249가 `rs_1`에서 던진다.

## 추가 케이스

| 케이스 | 기대 (수정 후) |
|---|---|
| 한 index에 message → reasoning (위 최소 재현) | 성공 |
| 거절 없는 텍스트 메시지 2개가 같은 id를 재사용 | 성공 |
| 같은 message id가 다른 index에 등장 (거절 없음) | 성공 |
| 실제 `response.refusal.delta` 뒤 같은 id가 다른 index | **여전히 throw** |
| 실제 거절 뒤 한 index에 다른 거절 id | **여전히 throw** |
| 거절 스냅샷이 누적 델타의 접두사가 아님 | **여전히 throw** |

마지막 세 줄이 이 수정의 안전망이다. 이것들이 통과해 버리면 수정이 과했다는 뜻이다.

## 레이아웃 등록

`tests/responses/` 도메인이므로 두 파일에 항목을 추가한다.

- `scripts/test-layout/layout.json` `explicit`
- `tests/fixtures/test-layout-expected.json`

`chat-refusal.test.ts`가 이미 `responses`로 등록돼 있으니 같은 값을 쓴다.

## 증거로 남길 것

수정 전 실행 결과(실패)와 수정 후 실행 결과(통과)를 같은 명령으로 남긴다. 단,
이 세션은 로컬 제품 스위트 금지이므로 **hosted CI가 판정자**다. 로컬에서는 실행하지
않고 NOT RUN으로 표기한다.


## 증명 결과 (wp1 종료, 2026-09-13)

가설은 **확증**됐다. 세 명의 독립 리뷰어가 같은 결론에 도달했고, 마지막 리뷰어는
실제 제어 흐름을 따라 재유도했다.

| 단계 | 위치 | 무슨 일 |
|---|---|---|
| 1 | `outbound.ts:308` | `added`의 `msg_1`이 거절 없이 장부에 등록됨 |
| 2 | `outbound.ts:623` → `:299` | 같은 index의 `done`이 `rs_1`로 들어옴 |
| 3 | `outbound.ts:249` | `item.id !== candidate` → `invalid_refusal` |

트리거 진입점은 `src/bridge.ts:958-960` → `flushHiddenReasoningEnvelope(:514-517)`이다.
`currentMsg`를 닫지 않은 채 같은 `outputIndex`로 reasoning의 `added`/`done`을 낸다.

### 계약이 깨지지 않는다는 증명

`tests/responses/chat-refusal.test.ts`의 18개 케이스는 전부 선행 `refusalDelta`를 갖는다.
따라서 `existing`이 참이고 새 조기 return에 걸리지 않는다. 리뷰어가 개별 확인한 것:

| 케이스 | 던지는 곳 | 수정 후 |
|---|---|---|
| 178, 179 | `:248` | 여전히 throw |
| 180 | `:315` | 여전히 throw |
| 208 | `:249` | 여전히 throw |

### 기각된 대안

"스트림에서 거절을 한 번이라도 봤는가"라는 전역 플래그 안은 더 약하다. 거절이 한 번
나온 뒤에는 다른 index의 평범한 메시지가 다시 장부에 등록되기 때문이다. per-item
스코프가 맞다.

### 착지

- 재현 테스트: `tests/responses/chat-refusal-scope.test.ts` (커밋 `66e1c9e67`)
- 머지: PR #4468 → `dev` `d0cbfffddfe1bb6a30b53862c55ff75cabc54eca`
- exact-head CI: `66e1c9e67`에서 25 success / 0 fail / 0 cancelled

로컬 제품 스위트·typecheck·build·install은 **NOT RUN**이다.

