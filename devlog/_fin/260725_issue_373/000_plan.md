# 260725 #373 — Cursor 재시작 후 context usage 0 (조사 · 근거 · 제약)

단일 work-phase 유닛. 구현 계약은 `010_prepared_request.md`.
경쟁 PR(#376) 이력은 `../260725_bug_sweep/001_external_evidence.md` 참조.

## 증상

프록시 재시작 후 checkpoint frame이 없는 턴이 계속 `inputTokens=0`,
`totalTokens=outputTokens`로 보고된다. 제보자 환경에서 61/61 요청 재현.

`usage.jsonl` 표시 문제가 아니라 Codex에 전달되는 `response.completed.usage` 문제다.
Codex 입장에서 "거의 빈 컨텍스트"로 보이므로 compaction 타이밍이 망가진다.

## 근본 원인 (코드 확인 완료)

마지막 absolute checkpoint가 디스크가 아니라 프로세스 내부 `Map`에만 있다.
`src/adapters/cursor/protobuf-events.ts:52`의 tracker는 closure 내부 `Map`이고,
프로덕션 인스턴스도 `live-transport.ts:72`의 모듈 전역 변수다. 프로세스가 죽으면 사라진다.

`responses-state.json`은 디스크에 persist되지만 `types.ts:229`이 보여주듯 conversation ID와
`checkpointUsable`만 담는다. 재시작 후 대화 ID는 복구돼도 토큰 checkpoint는 없다.

재시작 후 경로:

1. `live-transport.ts:515`에서 tracker 조회 → 비어 있어 carry 없음
2. `protobuf-events.ts:164` 초기 usage가 `{ inputTokens: 0, outputTokens: 0 }`
3. checkpoint frame이 없으면 `protobuf-events.ts:385`의 absolute 기록도 없음
4. `tokenDelta`는 445행에서 output에만 누적
5. `protobuf-events.ts:461`가 초기 `inputTokens: 0`을 그대로 복사

## PR #376이 거절된 이유

같은 방향이지만 CHANGES_REQUESTED다. estimator가 원본 요청을 다시 읽어 버려진 history,
필터된 tool, 원본 base64 이미지까지 계산했다. 두 번째 커밋도 payload 구성을 중복 수행했고
두 결과가 같은 인스턴스에서 나온다는 보장이 없었다.

owner 요구: **이미 pruning·정규화된 wire payload를 소비하고, request 구성을 중복하지 말며,
checkpoint/carry가 없을 때만 계산할 것.**

## 확인된 코드 구조

`encodeCursorRunRequest()`(506행) 안에서 다음이 **평범한 함수 스코프 지역 변수**다.

- `text` / `actionCase` (508-516행)
- `rootPromptMessagesState` (536행) — pruning이 끝난 결과

반면 tool 정의는 601행의 **IIFE 안에서만** 만들어진다.

```ts
...(() => {
  const visibleTools = cursorToolsForActivePrompt(request.tools, activePromptText(request), request.toolChoice);
  const mcpToolDefs = buildCursorToolDefinitions(visibleTools, request.toolChoice);
  return mcpToolDefs.length > 0 ? { mcpTools: create(McpToolsSchema, { mcpTools: mcpToolDefs }) } : {};
})(),
```

따라서 추정에 tool을 포함하려면 이 IIFE를 함수 스코프로 끌어올려야 한다.

`rootPromptMessages()`(163행)의 반환은 `ids` / `byteLength` / `historyMessageStart` 셋뿐이다.
직렬화된 텍스트를 얻으려면 반환 타입을 확장해야 한다.

## 제약

- estimate는 절대 tracker에 기록하지 않는다. tracker를 갱신하는 유일한 입력은 실제
  `conversationCheckpointUpdate.usedTokens`여야 한다.
- 공유 `src/lib/token-estimate.ts`는 건드리지 않는다. `kiro.ts`, `claude-messages.ts`,
  `chat-completions.ts`가 함께 쓰며, CJK clamp(67행)도 그대로 활용해야 한다.
- 우선순위: current checkpoint → process-local carry → post-pruning estimate → 기존 fallback.
- 요청이 실제로 소비됐다는 증거(checkpoint 또는 output signal) 없이 usage를 만들지 않는다.
