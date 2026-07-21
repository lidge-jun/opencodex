# 008 — 연구 추적: Cursor effort metadata 라이브 재검증

- 유형: 연구/추적 전용 (구현 단위 아님)
- 연관 구현 PRD: `021_patch_r_vertex_cursor_effort.md`
- 목적: Cursor static metadata와 effort-map을 갱신할 때 사용할 날짜가 있는 라이브 증거 확보

## 문제

`src/adapters/cursor/discovery.ts`의 `supportsReasoningEffort`는 모델 picker capability를 정하고,
`src/adapters/cursor/effort-map.ts`의 `CURSOR_MODEL_EFFORT_TIERS`는 실제 wire suffix를 정한다.
한쪽만 갱신되면 UI가 지원하지 않는 effort를 노출하거나, wire tier가 있는데 picker가 숨기는
metadata drift가 생긴다.

현재 트리에는 `src/adapters/cursor/effort-map.ts:29-32`에 2026-07-09 GetUsableModels 근거와
`grok-4.5-fast: [medium, high, xhigh]`가 있지만, `src/adapters/cursor/discovery.ts:168`에는
`supportsReasoningEffort`가 빠져 있다. 021은 이 코드상 모순을 양방향 테스트로 닫는다.

## 라이브 검증 작업

1. 날짜와 계정/플랜 범위를 기록하고 Cursor `GetUsableModels` 응답에서
   `grok-4.5-fast-{medium,high,xhigh}` 존재 여부를 캡처한다.
2. 각 suffix를 실제 요청해 성공/실패 상태와 bare `grok-4.5-fast` 동작을 기록한다.
3. cursor.com 모델 문서의 공개 표기와 API 응답이 다르면 runtime API를 wire capability의 우선
   증거로 삼고 차이를 기록한다.
4. 결과가 현행 tier와 같으면 증거 날짜/경로만 갱신한다. 다르면 effort-map entry와
   `supportsReasoningEffort` flag를 같은 구현 커밋에서 함께 추가/수정/삭제한다.

## 산출물 게이트

- 정확한 모델 ID와 suffix 목록
- 확인 날짜, 계정/플랜 범위, 증거 캡처 경로
- bare/suffixed 요청별 결과
- metadata와 effort-map을 함께 바꾸는 명시적 diff 결정
- `tests/cursor-static-catalog.test.ts`의 양방향 불변식 통과 증거

이 연구가 끝나기 전에도 021은 현재 repository SOT가 증명하는 정합성 수정으로 구현 가능하다.
향후 라이브 결과는 021을 조건부로 만들지 않고 별도 후속 패치의 입력으로 사용한다.
