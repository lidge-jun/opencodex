# 010 — 사람 지시를 프록시 캐리어 문구보다 앞에 둔다

의존: 없음

## 문제

`currentMessage.content`가 실측에서 이렇게 나온다:

```
"The requested tool result is attached.

STOP editing module A. Use kiro/gpt-5.6-sol instead."
```

`KIRO_TOOL_RESULT_CARRIER_MESSAGE`는 tool result를 담는 user turn이 빈 content가 되지
않게 하려고 넣는 프록시 자체 문구다(`src/adapters/kiro-constants.ts:7`,
`src/adapters/kiro.ts:501`). 그런데 `pushUser` 병합이 append이므로
(`src/adapters/kiro.ts:442-451`) **사람이 방금 쓴 지시가 기계 문구 뒤로 밀린다.**

두 가지가 문제다.

1. 최신 사람 지시가 filler 뒤에 묻힌다. 모델이 앞줄을 "이번 턴의 요지"로 읽으면
   스티어링을 부차적으로 취급할 여지가 생긴다.
2. 캐리어 문구는 **사람 텍스트가 없을 때만** 필요하다. 사람 텍스트가 있으면
   content는 이미 비어 있지 않으므로 filler는 순수 잡음이다.

## 변경

### `src/adapters/kiro.ts`

tool result를 push할 때 캐리어 문구를 무조건 앞세우지 않는다. `pushUser`에 캐리어가
"content가 비어 있을 때만 쓰는 placeholder"임을 알린다.

구체적으로: tool-result 분기에서 캐리어를 즉시 content로 넣는 대신, 모든 turn이
확정된 뒤 content가 비어 있는 tool-result turn만 캐리어로 보정한다.

**리뷰 blocker 1 반영 — 보정은 `turns.pop()` BEFORE에 해야 한다.** 초안은
`for (const turn of turns)`를 "toEntry 직전"에 두라고 했는데, 그 시점엔 이미
`currentTurn`이 `pop()`으로 빠져나가 있다(`src/adapters/kiro.ts:521`). 그대로 구현하면
**현재 메시지가 빈 content로 전송되고**, `validateKiroConversationState`는
toolResults가 있으면 통과시키므로 조용히 새어나간다. 정확한 위치:

```ts
// tool result 분기: 캐리어를 강제로 앞세우지 않는다
pushUser("", images, [{ content: [{ text: resultText }], status: ..., toolUseId }]);

// ... 선행/후행 turn 보정(unshift/push)이 끝난 뒤, pop() 하기 전에:
for (const turn of turns) {
  if (turn.kind === "user" && !turn.content.trim() && turn.toolResults.length > 0) {
    turn.content = KIRO_TOOL_RESULT_CARRIER_MESSAGE;
  }
}
const currentTurn = turns.pop();   // 보정 이후에 pop
```

`pushUser("")`가 빈 문자열을 넣어도 `appendTurnText`는 `if (!next) return target`으로
빈 값을 무시하므로(`src/adapters/kiro.ts:326-329`) 기존 병합 동작을 깨지 않는다.

`validateKiroConversationState`는 content/images/toolResults 중 하나라도 있으면
통과시키므로(`src/adapters/kiro.ts:346-350`) tool result가 있는 턴은 빈 content여도
유효하다. 다만 상류가 빈 문자열을 어떻게 다루는지 확신할 수 없으므로 **캐리어 보정은
유지한다.** 순서만 바꾸는 것이 이번 변경의 핵심이다.

결과 content:

```
"STOP editing module A. Use kiro/gpt-5.6-sol instead."
```

사람 지시만 남고, tool result는 `userInputMessageContext.toolResults`에 구조적으로
그대로 붙어 있다. 정보 손실이 없다.

## 회귀 테스트

`tests/kiro-adapter.test.ts` (또는 payload 조립을 다루는 기존 파일)

1. tool result + 사람 스티어링 텍스트가 같은 턴에 오면 `currentMessage.content`가
   **정확히 사람 텍스트와 같다** — 캐리어 문구가 앞에 오지 않는 것을 넘어
   **어디에도 등장하지 않는다** (리뷰 blocker 3: "사람 텍스트로 시작한다"만 보면
   캐리어가 뒤에 붙어도 통과하므로 부족하다). 현재 트리에서 실패한다.
2. tool result만 있고 사람 텍스트가 없으면 캐리어 문구가 그대로 유지된다 (기존 동작 보존).
3. **모델 패리티**: `claude-opus-5`와 `claude-opus-4.8`이 동일한 tail에 대해
   `currentMessage.content`와 `toolResults`가 같고, `additionalModelRequestFields`만
   다르다. issue #543의 핵심 주장을 코드로 못 박는다.

## 위험

- 낮음. 정보는 그대로고 순서만 바뀐다. tool result는 구조 필드에 남는다.
- 캐리어가 사라지는 것이 아니라 사람 텍스트가 없을 때만 쓰이도록 좁아진다.
- 이 변경이 #543을 **고친다고 주장하지 않는다.** 우리 쪽 위생 개선이며, 상류가
  무시하는 것이라면 증상은 남는다. 그 구분을 이슈 코멘트에 명시한다.
