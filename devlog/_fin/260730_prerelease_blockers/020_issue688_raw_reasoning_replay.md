# 020 — #688: web-search 이어받기가 raw reasoning을 버리는 문제

대상 이슈: [#688](https://github.com/lidge-jun/opencodex/issues/688)

## 증상

DeepSeek V4 thinking 모드에서 hosted `web_search`를 쓰면, 검색 후 이어받기 요청이
실패한다. 이슈 제목은 502지만 실제 업스트림 거절은 400이다(아래 참조).

## 손실 지점

`scanEventsForWebSearch()`는 합성 `web_search` 툴콜 이벤트만 걷어내고 나머지 전부를
`passthrough`에 남긴다(`src/web-search/loop.ts:55`). `reasoning_raw_delta`도 거기 살아 있다.

버리는 건 추출기다.

```ts
107 function extractIterationThinking(events: AdapterEvent[]): OcxThinkingContent | null {
108   let thinking = "";
109   let signature: string | undefined;
110   const redacted: string[] = [];
111   for (const e of events) {
112     if (e.type === "thinking_delta") thinking += e.thinking;
113     else if (e.type === "thinking_signature") signature = e.signature;
114     else if (e.type === "redacted_thinking") redacted.push(e.data);
115   }
116   if (!thinking && !signature && redacted.length === 0) return null;
```

`reasoning_raw_delta` 분기가 없다. DeepSeek 스트림은 `thinking_delta`를 내지 않고
`reasoning_raw_delta`만 내므로(`src/adapters/openai-chat.ts:743` — 스트리밍,
`:858` — 비스트리밍) 반환값이 `null`이 된다. 그러면 `runSearchCall()`이 리플레이하는
assistant 메시지는 툴콜만 담는다(`loop.ts:465-471`).

## 왜 업스트림이 거절하는가

DeepSeek V4 thinking 모드는 툴콜 이력과 함께 직전 assistant의 `reasoning_content`를
되돌려받아야 한다. 이 제약을 일반 대화 이력에 대해 해소한 것이 #61이다. #688은 hosted
web-search 재구성 경로가 같은 제약을 놓쳤다는 별개 표면이다.

제약을 만족시킬 코드는 이미 있다:

```ts
185 const reasoningContent = thinkingParts.map(p => p.thinking).join("");
186 if (reasoningContent.length > 0 && modelInList(provider.preserveReasoningContentModels, parsed.modelId)) {
187   chatMsg.reasoning_content = reasoningContent;
188 }
```

`src/adapters/openai-chat.ts:185`. DeepSeek V4는 이미 `preserveReasoningContentModels`에
등록돼 있다(`src/providers/registry.ts:823`, `:766`, `:692`). 즉 요청 빌더는 준비돼
있는데 web-search 루프가 thinking 파트를 하나도 주지 않아서 비어 있는 것이다.

**따라서 수정은 `thinking` 타입 파트를 만들어주는 것으로 끝난다.** 어댑터나 레지스트리는
건드리지 않는다.

## 502의 정체 (범위 밖 관찰)

400이 502로 보이는 경로:

1. DeepSeek이 400을 준다.
2. `prepareIterationEvents()`가 `LoopError(400, "Provider error 400: ...")`로 만든다
   (`loop.ts:321`).
3. 2회차 이후라 SSE가 이미 열려 있어, 예외가 어댑터 error 이벤트로 변환되며
   `LoopError.status`가 **버려진다**(`loop.ts:564`).
4. 구조화된 상태가 없으니 `adapterFailureFromMessage()`가 메시지로 추론한다. recognizer가
   `"Provider error 400"` 숫자 접두사를 파싱하지 않고, 이 메시지에는 "invalid"/"malformed"
   같은 인식 단어도 없어 기본값 502로 떨어진다(`src/lib/errors.ts:265`).

이 유닛은 여기까지 고치지 않는다. 리플레이가 정상화되면 이 에러 자체가 발생하지 않고,
상태 코드 전파는 web-search 루프 전반의 별개 표면이다. 별도 이슈로 남길 후보다.

## 서명된 thinking 경계 (틀리면 안 되는 부분)

OpenAI 호환 프로바이더의 raw reasoning은 Anthropic의 **서명된** `thinking` 블록과 다르다.
Anthropic 직렬화는 서명을 검사한다:

```ts
404 if (isLikelyRealAnthropicThinkingSignature(t.signature)) {
405   preface.push({ type: "thinking", thinking: t.thinking, signature: t.signature });
406 }
```

`src/adapters/anthropic.ts:414` 부근. 서명 게이트는 짧거나 call-ID 형태이거나 base64가
아닌 값을 거른다(`:239`).

raw reasoning을 기존 서명된 파트의 `thinking` 문자열에 **이어붙이면 안 된다**. 그러면
서명이 더 이상 원문을 인증하지 못한다. Anthropic이 리플레이를 거절하거나, 더 나쁘게는
무관한 raw chain-of-thought가 인증된 프로바이더 블록으로 위장된다.

그래서 수정은 raw reasoning을 **서명 없는 별개 파트**로 만든다. 서명이 없으면 Anthropic
직렬화가 조용히 무시하고, `openai-chat.ts`는 텍스트를 `reasoning_content`로 직렬화한다.
양쪽 계약이 동시에 성립한다.

`src/images/loop.ts:153`의 동명 함수가 이미 배열을 반환하며 블록별 서명을 보존하는
선례다. 형태를 그쪽에 맞춘다.

## 변경 1: `extractIterationThinking` (MODIFY `src/web-search/loop.ts:107`)

> 초안은 단일 `signature` 변수에 마지막 서명만 남기는 방식이었다. 감사에서 이게
> 다중 서명 블록을 손상시킨다는 것이 확인됐다 — `001_audit_synthesis.md` 블로커 2.
> `thinking("first"), sig1, thinking("second"), sig2`가 `"firstsecond"` + `sig2` 한 파트가
> 되어 서명이 원문을 인증하지 못한다. `src/images/loop.ts:153`가 이미 막아둔 버그다.

before: 위 인용 (단일 `OcxThinkingContent | null` 반환).

after — image loop의 per-block flush를 이식하고 raw reasoning 누적기를 더한다:

```ts
function extractIterationThinking(events: AdapterEvent[]): OcxThinkingContent[] {
  const parts: OcxThinkingContent[] = [];
  let thinking = "";
  let signature: string | undefined;
  let rawReasoning = "";

  // Each signed block keeps its OWN signature and text: Anthropic serializes the pair
  // verbatim, so flattening two blocks under the last signature 400s on replay exactly as
  // it does in the image loop (src/images/loop.ts).
  const flushVisible = () => {
    if (!thinking && !signature) return;
    parts.push({
      type: "thinking",
      thinking,
      ...(signature ? { signature } : {}),
    });
    thinking = "";
    signature = undefined;
  };
  // Raw reasoning is UNSIGNED and must never share a part with signed thinking: the
  // anthropic serializer skips signature-less parts (isLikelyRealAnthropicThinkingSignature)
  // while openai-chat serializes their text as `reasoning_content`, which is what DeepSeek
  // V4 thinking mode requires back next to the tool_calls (issue #688).
  const flushRaw = () => {
    if (!rawReasoning) return;
    parts.push({ type: "thinking", thinking: rawReasoning });
    rawReasoning = "";
  };

  for (const e of events) {
    if (e.type === "thinking_delta") {
      flushRaw();
      thinking += e.thinking;
    } else if (e.type === "reasoning_raw_delta") {
      flushVisible();
      rawReasoning += e.text;
    } else if (e.type === "thinking_signature") {
      signature = e.signature;
      flushVisible();
    } else if (e.type === "redacted_thinking") {
      flushVisible();
      flushRaw();
      parts.push({ type: "thinking", thinking: "", redacted: [e.data] });
    }
  }
  flushVisible();
  flushRaw();
  return parts;
}
```

스트림 순서가 보존된다. redacted 블록은 집계되지 않고 발생 위치에 개별 파트로 남는다.
서명은 블록별로 그 블록의 텍스트와만 짝지어진다. raw reasoning과 signed thinking이
섞여 들어와도 서로의 파트를 오염시키지 않는다.

### 전제하는 이벤트 순서 불변식

이 알고리즘은 **서명이 끝나지 않은 signed 블록 안에 raw reasoning이 끼어들지 않는다**고
전제한다. `thinking_delta → reasoning_raw_delta → thinking_signature` 순서가 오면
`flushVisible()`이 서명 도착 전에 발동해, 서명 없는 visible 텍스트 · 빈 signed 파트 ·
raw 텍스트로 갈라진다.

현재 이 스트림을 내는 어댑터는 없다. Anthropic 계열은 `thinking_delta`/`signature_delta`만
내고(`src/adapters/anthropic.ts:791`, `:798`), OpenAI 호환 계열은 `reasoning_raw_delta`만
낸다(`src/adapters/openai-chat.ts:743`). 두 계열이 한 스트림에 섞이지 않는다. 도달 불가라
이번 범위에서 처리하지 않는다.

"혼합 스트림은 항상 안전"을 보장하려면 누적기 대신 segment 객체 리스트가 필요하다.
새 어댑터가 이 전제를 깨면 그때 구조를 바꾼다.

독스트링도 갱신한다. 기존 문구는 Anthropic 요구사항만 설명한다. raw reasoning 경로와
per-block 보존 이유를 추가한다.

## 변경 2: `runSearchCall` 시그니처 (MODIFY `src/web-search/loop.ts:409`)

before:

```ts
  async function* runSearchCall(call: WebSearchCall, precedingThinking?: OcxThinkingContent | null): AsyncGenerator<AdapterEvent> {
```

after:

```ts
  async function* runSearchCall(call: WebSearchCall, precedingThinking: OcxThinkingContent[] = []): AsyncGenerator<AdapterEvent> {
```

## 변경 3: 리플레이 조립 (MODIFY `src/web-search/loop.ts:465`)

before:

```ts
    messages.push({
      role: "assistant",
      content: [
        // Signed thinking must precede tool_use on replay (Anthropic extended thinking).
        ...(precedingThinking ? [precedingThinking] : []),
        { type: "toolCall" as const, id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: callArgs },
      ],
      timestamp: now,
    });
```

after:

```ts
    messages.push({
      role: "assistant",
      content: [
        // Signed thinking must precede tool_use on replay (Anthropic extended thinking), and
        // unsigned raw reasoning must ride along for providers that require it back (#688).
        ...precedingThinking,
        { type: "toolCall" as const, id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: callArgs },
      ],
      timestamp: now,
    });
```

## 변경 4: 호출부 (MODIFY `src/web-search/loop.ts:560`)

before:

```ts
          const iterationThinking = extractIterationThinking(split.passthrough);
          for (const [callIndex, call] of split.calls.entries()) {
            yield* runSearchCall(call, callIndex === 0 ? iterationThinking : null);
          }
```

after:

```ts
          const iterationThinking = extractIterationThinking(split.passthrough);
          for (const [callIndex, call] of split.calls.entries()) {
            yield* runSearchCall(call, callIndex === 0 ? iterationThinking : []);
          }
```

첫 호출에만 붙이는 기존 동작은 유지한다. 배치된 여러 쿼리가 하나의 assistant 턴을
공유하는 구조라 그대로 맞다.

`src/types.ts`는 변경 불필요하다. `OcxAssistantContentPart`가 이미 여러
`OcxThinkingContent`를 허용한다(`src/types.ts:144`).

## 회귀 테스트: `tests/web-search.test.ts` (MODIFY)

기존 `"signed thinking before a web_search call survives into the replayed assistant turn"`
(line 700 부근) 바로 뒤에 추가한다. 그 테스트는 Anthropic 경계 회귀 증거로 그대로 둔다.

테스트 **3개**가 필요하다. 감사 블로커 2·3 반영.

### (1) 내부 리플레이 형태 — mock 어댑터

```
raw reasoning before a web_search call is replayed as an unsigned thinking part
```

인접 테스트 관례를 따른다: mock `ProviderAdapter`, pass-indexed `parseStream()`이
`AdapterEvent` 배열을 내고 `buildRequest()`에서 `p.context.messages`를 캡처한다.
1회차 이벤트는 `{ type: "reasoning_raw_delta", text: "I should search" }` + 합성 web_search
툴콜 + terminal. 검증:

- 리플레이된 assistant `content`에 `type: "thinking"` 파트가 있고 `thinking`이 1회차
  raw reasoning과 일치한다.
- 그 파트에 `signature`가 **없다**. (Anthropic 경계 계약)
- 툴콜 파트가 thinking 파트 **뒤에** 온다.

### (2) 다중 블록 순서·서명 보존 — mock 어댑터 (블로커 2)

```
multiple signed thinking blocks keep their own signatures across a web_search replay
```

1회차 이벤트 순서: `redacted_thinking(d1)`, `thinking_delta("first")`,
`thinking_signature(sig1)`, `thinking_delta("second")`, `thinking_signature(sig2)`,
`reasoning_raw_delta("raw")`, 합성 툴콜, terminal.

검증 — 파트 배열이 정확히 이 순서여야 한다:

1. `{ thinking: "", redacted: [d1] }`
2. `{ thinking: "first", signature: sig1 }`
3. `{ thinking: "second", signature: sig2 }`
4. `{ thinking: "raw" }` — 서명 없음
5. 툴콜

`"firstsecond"`가 나오거나 서명이 하나만 남으면 실패다. 이게 초안 알고리즘을 잡는
테스트다.

### (3) wire 계약 — 실제 어댑터 (블로커 3, 필수)

```
a reasoning_content provider receives raw reasoning beside the replayed tool_calls
```

실제 `createOpenAIChatAdapter`를 쓰고, provider에 `preserveReasoningContentModels`로
대상 모델을 등록한다. `globalThis.fetch`를 목킹해 1회차는 `delta.reasoning_content` +
indexed `tool_calls` + `finish_reason: "tool_calls"` + `[DONE]`의 OpenAI 호환 SSE를,
사이드카는 이 파일의 기존 Responses SSE 패턴을 반환한다. 2회차 요청 body를 캡처해 검증:

```ts
expect(assistant.reasoning_content).toBe("I should search");
expect(assistant.tool_calls).toHaveLength(1);
```

감사 지적대로 사용자가 겪는 실패는 직렬화 경계(`src/adapters/openai-chat.ts:179` 게이팅)에
있다. mock 테스트만으로는 2회차 요청에 `reasoning_content`가 없어도 통과할 수 있다.
이 테스트는 선택이 아니라 필수다.

## 반증 절차

```
git stash push -- src/web-search/loop.ts
bun test tests/web-search.test.ts    # 새 테스트가 실패해야 한다
git stash pop
bun test tests/web-search.test.ts    # 전부 통과
```

## 위험

`extractIterationThinking`의 반환 타입이 바뀌므로 호출부를 갱신해야 한다.
`rg -n "extractIterationThinking" src/web-search/`로 확인 — 정의와 호출 1곳뿐이고,
리뷰어도 재확인했다. `src/images/loop.ts`의 동명 함수는 별개 파일의 별개 함수다.

서명된 thinking과 raw reasoning이 함께 오면 파트가 여러 개 생긴다. Anthropic 직렬화는
서명 있는 것만 취하고(`src/adapters/anthropic.ts:414` 부근의
`isLikelyRealAnthropicThinkingSignature` 게이트), openai-chat은 모든 thinking 파트의
텍스트를 이어붙여 `reasoning_content`로 만든다. 양쪽 모두 기존 계약을 위반하지 않는다.

리뷰어가 다른 소비자도 확인했다: Kiro는 툴콜 리플레이에서 thinking을 무시하고, Cursor는
다중 thinking 파트를 표현할 수 있다. bridge와 `src/server/responses/terminal-guard.ts`는
내부 재구성된 리플레이 메시지를 소비하지 않는다. 즉 파트 개수가 늘어나는 것 자체로
깨지는 소비자는 없다.

openai-chat이 여러 파트를 이어붙이므로, 다중 서명 블록 + raw reasoning이 함께 온
경우 `reasoning_content`에 Anthropic 서명 블록의 텍스트까지 섞인다. 이는 기존 동작과
동일하다(초안 이전에도 `thinkingParts` 전체를 join했다). 프로바이더별로 분리가 필요하면
별개 작업이다.
