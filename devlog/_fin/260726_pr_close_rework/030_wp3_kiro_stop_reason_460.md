# WP3 — PR #460 Kiro native stop reason + Opus 5 effort

대상: PR #460 (mushikingh), head `664934bf`. `git merge-tree` clean (tree `9ec2c446`).
인증/자격증명/OAuth/워크플로/릴리스 경계를 건드리지 않는다. 이 배치에서 유일하게
원본 의도 그대로 self-merge 가능한 provider PR이다.

## 변경 파일 전수 (9개)

최초 안은 `kiro.ts`와 문서만 다뤘으나 PR은 9개 파일을 바꾼다. 나머지 두 소스 파일이
누락돼 있었고, 그중 하나는 **핵심 수정의 전제조건**이다.

| 파일 | 취급 | 비고 |
|---|---|---|
| `src/adapters/kiro-events.ts` | **필수 통합** | 아래 전제조건 참조 |
| `src/adapters/kiro.ts` | 통합 (결함 A 수정 포함) | |
| `src/providers/kiro-models.ts` | 통합 | 주석만 변경 |
| `src/adapters/kiro-restatement.ts` | **제외** | 결함 B |
| `tests/kiro-restatement.test.ts` | **제외** | 위 모듈과 함께 |
| `tests/kiro-stream.test.ts` | 통합 + 수정 | 테스트 1 교체, 테스트 2 추가 |
| `tests/kiro-adapter.test.ts` | 통합 | Opus 5 effort 커버리지 |
| `docs-site/.../adapters.md` | 통합 + 문구 수정 | 결함 A 반영 후 |
| `structure/04_transports-and-sidecars.md` | 통합 + **문구 수정** | 아래 blocker 3 |

### 전제조건 — `kiro-events.ts`의 `stopReason` 파싱 (필수)

결함 A 수정은 `stopReason` 변수를 읽는데, dev의 `ParsedKiroEvent`에는 그 필드가 없다.
PR이 아래를 추가한다. **이걸 빼면 수정 자체가 컴파일되지 않는다.**

```diff
-  | { type: "metadata"; usage?: OcxUsage; contextUsagePercentage?: number }
+  | { type: "metadata"; usage?: OcxUsage; contextUsagePercentage?: number; stopReason?: string }
```

그리고 `parseKiroEvent`의 `metadataEvent` 분기에서:

```ts
const stopReason = optionalString(eventType, parsed, "stopReason");
...
...(stopReason !== undefined ? { stopReason } : {}),
```

`optionalString`은 dev에 이미 있는 헬퍼다. 이 훅이 native stop reason을 파서까지
실어나르는 유일한 경로다.

### `kiro-models.ts`는 주석만 바뀐다

```diff
-// gpt-5.6-sol sends these values through Kiro's verified native reasoning field. Other models map
-// them to bounded thinking instructions until their native effort support is verified.
+// gpt-5.6-sol and claude-opus-5 send these values through Kiro's verified native effort fields
+// (`reasoning.effort` and `output_config.effort` respectively). Other models map them to bounded
+// thinking instructions until their native effort support is verified.
```

`KIRO_REASONING_EFFORTS` 배열 자체는 그대로다. 동작 변경 없음.

## 결함 A — END_TURN 외 모든 stop reason이 추가 추론을 유발

### A-gate 정정 1: 제안 branch는 도달하지 않는다 (blocker 1, High)

리뷰어가 PR head에 계획의 테스트를 실제로 추가해 돌린 결과 `fetches === 0`이었고
terminal은 `done`이 아니라 non-retryable 502 `error`(`kiro_stream_protocol_error`)였다.
즉 최초 안이 주장한 RED 근거가 **사실과 다르다.**

원인은 `src/adapters/kiro-events.ts:91-93`이다. `parseKiroEvent`는 switch에 들어가기
**전에** generic truncation을 먼저 검사한다.

```ts
const truncationReason = kiroTruncationReason(parsed);
if (truncationReason) return { type: "truncation", data: truncationReason };
```

`src/adapters/kiro-truncation.ts:3-4`의 검사 대상에 `stopReason` 키가 들어 있고
패턴이 `max[_-]?tokens?`를 잡는다.

```ts
const REASON_KEYS = ["finish_reason", "finishReason", "stop_reason", "stopReason", "completionReason", "reason"];
const TRUNCATION_PATTERN = /length|max[_-]?tokens?|truncat|incomplete|context_length/i;
```

실측 결과 (A-gate R2 정정 — 최초 안은 "둘 다 걸린다"고 썼으나 사실이 아니다):

| stop reason | sniffer 매치 |
|---|---|
| `MAX_TOKENS` | **true** |
| `LENGTH_LIMIT` | **true** |
| `MODEL_CONTEXT_WINDOW_EXCEEDED` | false |
| `STOP_SEQUENCE` / `END_TURN` / `CONTENT_FILTERED` / `MAX_TIME` / `MALFORMED_MODEL_OUTPUT` | false |

**수정 방향 (값 기반 화이트리스트를 쓰지 않는다).** 알려진 enum 집합으로 우회하면
`MAX_TIME`·`LENGTH_LIMIT` 같은 미래 값이 다시 sniffer에 선점된다. 실제로 `LENGTH_LIMIT`은
지금도 매치된다. 값이 아니라 **위치**로 판정한다.

`metadataEvent`에 유효한 문자열 `stopReason`이 있으면 값과 무관하게 generic sniffer를
건너뛴다. `stopReason`이 없거나 다른 이벤트 타입이면 legacy 탐지를 그대로 적용한다.

```ts
// A metadataEvent's `stopReason` is a native terminal signal and must reach the parser
// intact. The generic sniffer matches substrings ("max_tokens", "length") across many keys,
// so a value-based allowlist would keep swallowing future enums such as MAX_TIME or
// LENGTH_LIMIT. Gate on position, not on the value.
const nativeStopReason = eventType === "metadataEvent"
  ? optionalString(eventType, parsed, "stopReason")
  : undefined;
if (nativeStopReason === undefined) {
  const truncationReason = kiroTruncationReason(parsed);
  if (truncationReason) return { type: "truncation", data: truncationReason };
}
```

그 외 이벤트의 legacy `finish_reason` truncation 동작은 **그대로 보존**한다.

### A-gate 정정 2: stop reason 매핑 (blocker 2, High)

최초 안은 `MODEL_CONTEXT_WINDOW_EXCEEDED`를 `max_output_tokens`로 보냈다. 이는
**입력 컨텍스트 고갈을 출력 truncation으로 오분류**한다. 결과가 실제로 나쁘다:

- `src/responses/state.ts:306` — `max_output_tokens`인 partial 출력을 continuation
  재생용으로 캐싱한다. 컨텍스트가 이미 꽉 찼는데 이어붙이기를 유도한다.
- `src/claude/outbound.ts:411,563` — Claude `max_tokens`로 변환된다.
- `src/chat/outbound.ts:354` — Chat `length`로 변환된다.

AWS는 이를 출력 한도가 아니라 컨텍스트 한도 도달로 정의한다
(https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_MessageStopEvent.html).
또 최초 안의 catch-all은 정상 종료인 `STOP_SEQUENCE`까지 incomplete로 만든다.

명시적 매트릭스로 확정한다. catch-all은 **미지 값에만** 적용한다.

| stop reason | 처리 | retryable | 근거 |
|---|---|---|---|
| `END_TURN` (text 있음) | `done`, endTurn=true, 텍스트를 `final_answer`로 | — | 정상 종료 |
| `STOP_SEQUENCE` (text 있음) | 위와 동일 | — | 정상 종료. incomplete 아님 |
| `END_TURN` / `STOP_SEQUENCE` (text 없음) | incomplete `kiro_<reason>_without_text` | false | 빈 성공 금지 |
| `TOOL_USE` | 실제 tool call 있으면 기존 경로. 없으면 incomplete `kiro_tool_use_without_call` | false | 모순 상태 |
| `MAX_TOKENS` | incomplete `max_output_tokens` | true | 출력 한도. 이어쓰기 가능 |
| `MODEL_CONTEXT_WINDOW_EXCEEDED` | **structured error** (아래) | false | 기존 계약 재사용 |
| `CONTENT_FILTERED` / `GUARDRAIL_INTERVENED` | incomplete `content_filter` | false | 필터링 |
| `MALFORMED_TOOL_USE` | incomplete `kiro_malformed_tool_use` | false | |
| `MALFORMED_MODEL_OUTPUT` | incomplete `kiro_malformed_model_output` | false | 공식 enum |
| 그 외(미지) | incomplete `kiro_<lowercased>` | false | 미래 enum 대비 |

### context 고갈은 structured error로 (A-gate R2 확정)

B로 미루지 않고 여기서 정한다. custom incomplete reason을 쓰면 Claude는 미지 incomplete를
**529 retryable overload**로, Chat은 error frame으로 바꿔 `retryable: false`가 보존되지 않는다.

dev에 이미 정확한 계약이 있다: `src/adapters/kiro-errors.ts:103-110`의
`400 / invalid_request_error / context_length_exceeded / retryable:false`.
`tests/bridge.test.ts:370-388`이 이를 잠근다. 세 converter를 건드리지 않고 재사용한다.

```ts
terminal: {
  type: "error",
  message: "Kiro stopped because the model context window was exhausted",
  status: 400,
  errorType: "invalid_request_error",
  code: "context_length_exceeded",
  retryable: false,
  usage: finalUsage,
}
```

참고로 OpenAI Responses는 context-window 도달도 `max_output_tokens`로 표현하므로
AWS 문구만으로 이를 "입력 거부"라고 단정할 수는 없다. 이건 규범이 아니라
**이 저장소의 정책 선택**이다: opencodex는 이미 `kiro-errors.ts`에서 context 고갈을
비재시도 400 계약으로 구분하고 있으므로 그 선례를 따른다.

PR head `src/adapters/kiro.ts:1005-1103`에서 `END_TURN`만 종료로 취급하고
`MAX_TOKENS`, `CONTENT_FILTERED`, `TOOL_USE`, 미래의 미지 값이 전부 `needsFallback: true`로
떨어진다. AWS는 이들을 서로 다른 종료 상태로 정의한다
(https://docs.aws.amazon.com/java/api/latest/software/amazon/awssdk/services/bedrockruntime/model/StopReason.html).
`MAX_TOKENS`에서 잘린 응답을 또 한 번 유료 요청으로 덮고, context window 초과에서는
dev에 이미 통합된 `fc517004`(context pressure)와 충돌해 과대 요청을 재전송할 수 있다.

INSERT — PR head `src/adapters/kiro.ts:1093-1099`의 `if (sawRealTool) { ... }` 블록 직후.
삽입 위치 자체는 리뷰어가 올바르다고 확인했다(`completionAnswer`/`sawRealTool` 우선,
아래 fallback/empty branch 차단). 아래 코드는 위 매트릭스를 반영한 개정판이다.

```ts
    if (mode === "required" && stopReason !== undefined) {
      const reason = stopReason.trim().toUpperCase();
      const providerStateField = finalProviderState ? { providerState: finalProviderState } : {};

      // NOTE: END_TURN and STOP_SEQUENCE are NOT handled here. They are handled earlier by the
      // widened `nativeEndTurn` path (see below), because the deferred text must be relabeled
      // to `final_answer` BEFORE it is flushed. Reaching this block with either reason means
      // no text was produced.

      // Repository policy: context-window exhaustion is reported as a non-retryable
      // context-length failure, matching the existing kiro-errors.ts contract. Mapping it to
      // max_output_tokens would make responses/state.ts cache a partial for continuation
      // replay and would surface as Claude `max_tokens` / Chat `length`, inviting a retry
      // that cannot succeed.
      const incomplete = (incompleteReason: string, retryable: boolean) => ({
        assistantText,
        sawReasoning,
        terminal: {
          type: "incomplete" as const,
          reason: incompleteReason,
          message: `Kiro stopped with ${reason} before an explicit final answer`,
          usage: finalUsage,
          retryable,
          endTurn: false,
          ...providerStateField,
        },
      });

      if (reason === "MAX_TOKENS") return incomplete("max_output_tokens", true);
      if (reason === "MODEL_CONTEXT_WINDOW_EXCEEDED") {
        return {
          assistantText,
          sawReasoning,
          terminal: {
            type: "error" as const,
            message: "Kiro stopped because the model context window was exhausted",
            status: 400,
            errorType: "invalid_request_error",
            code: "context_length_exceeded",
            retryable: false,
            usage: finalUsage,
          },
        };
      }
      if (reason === "CONTENT_FILTERED" || reason === "GUARDRAIL_INTERVENED") {
        return incomplete("content_filter", false);
      }
      if (reason === "MALFORMED_TOOL_USE") return incomplete("kiro_malformed_tool_use", false);
      if (reason === "MALFORMED_MODEL_OUTPUT") return incomplete("kiro_malformed_model_output", false);
      if (reason === "TOOL_USE") return incomplete("kiro_tool_use_without_call", false);
      // Empty or reasoning-only END_TURN / STOP_SEQUENCE lands here rather than completing
      // as a blank success.
      if (reason === "END_TURN" || reason === "STOP_SEQUENCE") {
        return incomplete(`kiro_${reason.toLowerCase()}_without_text`, false);
      }
      return incomplete(`kiro_${reason.toLowerCase() || "unknown_stop"}`, false);
    }
```

### STOP_SEQUENCE는 `nativeEndTurn` 확장으로 처리한다 (A-gate R3 blocker 1)

위 매트릭스 branch에서 `done`을 반환하면 terminal은 맞지만 **텍스트가 commentary로 남는다.**
PR head `src/adapters/kiro.ts:1024-1036`을 보면 이유가 분명하다.

```ts
if (mode === "required") {
  if (nativeEndTurn) {
    for (const event of deferred.splice(0)) {
      yield event.type === "text_delta" ? { ...event, phase: "final_answer" } : event;
    }
    return { ... terminal: { type: "done", endTurn: true, ... } };
  }
  for (const event of deferred.splice(0)) yield event;   // ← commentary로 flush
}
```

`nativeEndTurn`이 아니면 deferred가 여기서 이미 commentary로 빠져나간다. 매트릭스 branch는
그 **뒤에** 실행되므로 재라벨 기회가 없다.

따라서 `nativeEndTurn` 판정을 두 reason으로 넓힌다.

```ts
// before (PR head :1007-1011) — five conditions, not two
const nativeEndTurn = stopReason === KIRO_END_TURN_STOP_REASON
  && sawText
  && !sawRealTool
  && completionAnswer === undefined
  && completionCalls === 0;

// after — widen ONLY the reason test. STOP_SEQUENCE is an ordinary native completion too,
// and both need their deferred text relabeled to final_answer before the flush below.
// The other four guards stay: a real tool call or a private completion answer must still
// arbitrate against Kiro's own verdict.
const normalizedStop = stopReason?.trim().toUpperCase();
const nativeEndTurn =
  (normalizedStop === "END_TURN" || normalizedStop === "STOP_SEQUENCE")
  && sawText
  && !sawRealTool
  && completionAnswer === undefined
  && completionCalls === 0;
```

**다섯 조건을 모두 보존하는 것이 핵심이다** (A-gate R4 blocker 1). 이전 개정안은
`sawText`만 남기고 `!sawRealTool` / `completionAnswer === undefined` /
`completionCalls === 0`을 떨어뜨렸다. 그러면 텍스트 뒤에 실제 tool call이 오고
`END_TURN`이 붙는 경우 턴이 조기 완료되고, private completion answer도 우회된다.
기존 `tests/kiro-stream.test.ts:496-530`이 END_TURN 변종을 잡아낸다.

가드가 유지되므로 매트릭스 branch에는 두 reason의 **빈/reasoning-only** 케이스만
도달한다. tool call이나 completion answer가 개입한 경우는 위쪽 `completionAnswer` /
`sawRealTool` 분기에서 먼저 반환되므로 여기까지 오지 않는다.

테스트도 terminal만 보면 이 결함을 놓친다. phase까지 단언한다.

```ts
test("STOP_SEQUENCE emits its text as the final answer, not commentary", async () => {
  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(parsedWith([{ role: "user", content: "go" }], [bashTool]));
  const events = await collectAdapterEvents(
    adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "Done." }),
      eventFrame({ stopReason: "STOP_SEQUENCE" }, "metadataEvent"),
    ))),
  );

  expect(events.filter(e => e.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Done.", phase: "final_answer" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
});
```

`TOOL_USE`가 여기까지 온다는 것은 위 `sawRealTool` 분기를 통과하지 못했다는 뜻,
즉 tool call 없이 `TOOL_USE`만 온 모순 상태다.

선행 `completionAnswer` / `sawRealTool` 분기는 그대로 둔다. 실제 tool call을 동반한
정상 `TOOL_USE`는 계속 tool call을 내고, call 없는 모순된 `TOOL_USE`만 incomplete가 된다.

주석 교체 — before:

```ts
// Kiro text has no trustworthy final/progress marker. When completion is required, ordinary
// text and reasoning remain unfinished until the one bounded fallback validates the turn.
```

after:

```ts
// Only a missing native stop reason uses the compatibility fallback. Any explicit reason has
// already terminated this inference and must not be converted into another model request.
```

## 결함 B — fuzzy restatement 억제가 진짜 최종 상태를 삭제

`src/adapters/kiro-restatement.ts:28-77`의 LCS 임계값(첫 400단어 중 65% 공유, 20% 이내 증가,
11단어 이하 차이 구간)은 "I will update / run / verify" → "I updated / ran / verified" 같은
상태 전환을 중복으로 분류한다. 긴 응답에서 한 단어 시제 변화가 결과를 뒤집는데 억제된다.

DO NOT INTEGRATE: `src/adapters/kiro-restatement.ts`, `tests/kiro-restatement.test.ts`.

`src/adapters/kiro.ts`에서 import 제거:

```ts
import { isKiroRestatement } from "./kiro-restatement";
```

dev 기준 정확 비교를 유지한다:

```ts
function normalizedKiroAnswer(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isRepeatedKiroAnswer(text: string, previous?: string): boolean {
  return normalizedKiroAnswer(text) === normalizedKiroAnswer(previous ?? "");
}
```

## 회귀 테스트 1 — stop reason

REPLACE: PR head의 `"a non-END_TURN stop reason still requires the bounded completion fallback"`
테스트를 아래로 교체 (`tests/kiro-stream.test.ts`).

```ts
test("MAX_TOKENS terminates as incomplete without a bounded completion request", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(streamOf(...completionFrames("must not run")));
  }) as typeof fetch;

  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(
    parsedWith([{ role: "user", content: "write a long report" }], [bashTool]),
  );

  const events = await collectAdapterEvents(
    adapter.parseStream(
      new Response(
        streamOf(
          eventFrame({ content: "Partial report." }),
          eventFrame({ stopReason: "MAX_TOKENS" }, "metadataEvent"),
        ),
      ),
    ),
  );

  expect(fetches).toBe(0);
  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Partial report.", phase: "commentary" },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "incomplete",
    reason: "max_output_tokens",
    retryable: true,
    endTurn: false,
  });
});
```

RED→GREEN 근거 (A-gate 정정): 리뷰어 실측 결과 PR head에서 `fetches`는 이미 `0`이고
terminal은 `done`이 아니라 non-retryable `error`(`kiro_stream_protocol_error`)다.
truncation sniffer가 먼저 삼키기 때문이다. 따라서 이 테스트가 RED인 이유는
"fallback이 호출돼서"가 아니라 **terminal 종류와 reason이 틀려서**다.
`fetches === 0` 단언은 수정 전후 모두 통과하므로 회귀 방지용이고,
실제 RED 신호는 `toMatchObject({type:"incomplete", reason:"max_output_tokens"})`다.

### 회귀 테스트 1b — stop reason 매트릭스 전수

매트릭스가 9갈래이므로 케이스별로 잠근다. 특히 아래 두 개가 blocker 2의 핵심이다.

A-gate R2 blocker 4 반영: 최초 안은 `adapter`를 정의하지 않았고 `buildRequest`도 없어
`mode === "required"`가 활성화되지 않았다. 매 케이스마다 adapter를 만들고 tool을 붙인
`buildRequest`를 먼저 호출해야 새 branch에 도달한다.

```ts
/** Drives one metadataEvent stopReason through a tool-enabled (mode=required) turn. */
async function terminalForStopReason(stopReason: string, content = "Partial.") {
  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(
    parsedWith([{ role: "user", content: "do the thing" }], [bashTool]),
  );
  const events = await collectAdapterEvents(
    adapter.parseStream(new Response(streamOf(
      eventFrame({ content }),
      eventFrame({ stopReason }, "metadataEvent"),
    ))),
  );
  return events.at(-1);
}

test("MODEL_CONTEXT_WINDOW_EXCEEDED reports a non-retryable context-length failure", async () => {
  // Reuses the existing kiro-errors.ts:103-110 contract rather than inventing an incomplete
  // reason: an unknown incomplete would become a retryable 529 in Claude outbound.
  expect(await terminalForStopReason("MODEL_CONTEXT_WINDOW_EXCEEDED")).toMatchObject({
    type: "error",
    status: 400,
    errorType: "invalid_request_error",
    code: "context_length_exceeded",
    retryable: false,
  });
});

test("STOP_SEQUENCE completes the turn instead of reporting incomplete", async () => {
  expect(await terminalForStopReason("STOP_SEQUENCE", "Done.")).toMatchObject({
    type: "done",
    endTurn: true,
  });
});

test("an empty STOP_SEQUENCE turn does not complete as a blank success", async () => {
  // Mirrors the existing nativeEndTurn sawText guard: no text means no successful completion.
  expect(await terminalForStopReason("STOP_SEQUENCE", "")).toMatchObject({
    type: "incomplete",
    reason: "kiro_stop_sequence_without_text",
    retryable: false,
  });
});
```

`CONTENT_FILTERED`, `MALFORMED_TOOL_USE`, `MALFORMED_MODEL_OUTPUT`, tool call 없는
`TOOL_USE`, 미지 값(`MAX_TIME`)도 `terminalForStopReason`으로 각 1케이스씩 추가한다.

`MAX_TIME`은 **unknown catch-all** 케이스일 뿐이다 (A-gate R3 blocker 2).
sniffer가 원래 매치하지 않으므로 positional bypass를 증명하지 못한다.
bypass 증명에는 실제로 매치되는 `LENGTH_LIMIT`을 써야 한다 — 아래 1c 참조.

### 회귀 테스트 1c — truncation sniffer 분리 확인

`kiro-events.ts` 수정이 legacy 동작을 깨지 않았는지 양방향으로 잠근다.
`tests/kiro-events.test.ts`는 **존재하지 않는다.** `tests/kiro-stream.test.ts`에 넣고,
그 파일의 기존 인코딩 패턴(`enc.encode(JSON.stringify(...))`)을 그대로 쓴다.

```ts
test("metadataEvent stopReason bypasses the generic truncation sniffer", () => {
  const event = parseKiroEvent("metadataEvent", enc.encode(JSON.stringify({ stopReason: "MAX_TOKENS" })));
  expect(event).toMatchObject({ type: "metadata", stopReason: "MAX_TOKENS" });
});

test("the bypass is positional, not value-based", () => {
  // LENGTH_LIMIT genuinely matches TRUNCATION_PATTERN, so a value allowlist would still
  // swallow it. Only a positional gate lets it through as a native stop reason.
  const event = parseKiroEvent("metadataEvent", enc.encode(JSON.stringify({ stopReason: "LENGTH_LIMIT" })));
  expect(event).toMatchObject({ type: "metadata", stopReason: "LENGTH_LIMIT" });
});

test("legacy finish_reason truncation detection is unchanged", () => {
  const event = parseKiroEvent("assistantResponseEvent", enc.encode(JSON.stringify({ finish_reason: "max_tokens" })));
  expect(event).toMatchObject({ type: "truncation" });
});
```

두 번째 테스트가 blocker 1 수정의 부작용 방지선이다.
`parseKiroEvent`는 `tests/kiro-stream.test.ts:10`에 **이미 import되어 있다.**
추가 import는 필요 없다.

## 회귀 테스트 2 — restatement 보존

APPEND: `tests/kiro-stream.test.ts`

```ts
test("bounded fallback preserves a final status update that mostly repeats commentary", async () => {
  const progress =
    "I checked the repository, read the provider implementation, inspected the related tests, "
    + "ran the focused validation commands, and reviewed the generated diagnostics. The migration "
    + "is still pending because the final verification job has not completed, so the branch must "
    + "not be reported as ready yet.";

  const finalStatus =
    "I checked the repository, read the provider implementation, inspected the related tests, "
    + "ran the focused validation commands, and reviewed the generated diagnostics. The migration "
    + "is now complete because the final verification job has completed, so the branch can "
    + "be reported as ready.";

  globalThis.fetch = (async () =>
    new Response(streamOf(eventFrame({ content: finalStatus })))) as typeof fetch;

  const adapter = createKiroAdapter(provider);
  await adapter.buildRequest(
    parsedWith([{ role: "user", content: "finish the migration" }], [bashTool]),
  );

  const events = await collectAdapterEvents(
    adapter.parseStream(new Response(streamOf(eventFrame({ content: progress })))),
  );

  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: progress, phase: "commentary" },
    { type: "text_delta", text: finalStatus, phase: "final_answer" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
});
```

RED→GREEN 근거: PR head는 두 텍스트가 40단어 초과·65% 훨씬 상회·짧은 삽입 구간이라
`finalStatus`를 억제해 `text_delta`가 1개만 남는다.

## 문서

`docs-site/src/content/docs/reference/adapters.md`의 completion 문단을 아래로 교체한다.
PR head의 "END_TURN 아닌 것은 전부 fallback" 서술은 결함 A 수정 후 거짓이 된다.

```md
Kiro assistant text carries no dependable end-turn phase of its own. Its terminal `metadataEvent`
can, however, carry a native `stopReason`. An `END_TURN` response holding plain assistant text with
no client tool call ends the turn directly, with that text emitted as the final answer and no extra
model round trip.

Only a missing stop reason uses the compatibility completion path. Other explicit stop reasons
terminate the current inference without another model request: `TOOL_USE` must accompany a real
tool call, an output-token limit surfaces as incomplete output that can be continued, and
context-window exhaustion surfaces as a non-retryable context-length error rather than as
truncated output. Filtering and guardrail stops surface as filtered incomplete output.

When no native stop reason is present and an ordinary client tool is available, opencodex adds a
private `codex_kiro_final_answer` tool. If Kiro emits progress without calling it, the adapter makes
one bounded continuation. Duplicate suppression is deliberately limited to whitespace-normalized
exact repeats; a reworded status update is retained because suppressing genuine final information
is worse than displaying a cosmetic restatement.
```

같은 completion 의미와 Opus 5 `output_config.effort` 문단을 아래 4개 로케일에 반영한다.
현재 이 파일들은 Kiro 전송 계층 불릿에서 끝나고 completion/effort 서술이 아예 없다.

```
docs-site/src/content/docs/ja/reference/adapters.md
docs-site/src/content/docs/ko/reference/adapters.md
docs-site/src/content/docs/ru/reference/adapters.md
docs-site/src/content/docs/zh-cn/reference/adapters.md
```

Opus 5의 effort 값(`low`/`medium`/`high`/`xhigh`/`max`)은 Kiro 공식 문서로 확인됨
(https://kiro.dev/docs/cli/chat/effort/).

## 활성화 시나리오

활성화 대상은 세 곳이다.

1. **파서 우회** — `parseKiroEvent`의 positional `stopReason` 게이트. `MAX_TOKENS`(sniffer
   매치)와 `LENGTH_LIMIT`(값 기반 화이트리스트였다면 누락됐을 값)이 `type: "metadata"`로
   통과하는지, legacy `finish_reason` truncation이 그대로인지.
2. **native 완료 확장** — `nativeEndTurn`이 `STOP_SEQUENCE`까지 포함하되 나머지 네 가드를
   유지하는지. 관찰 지점은 `text_delta.phase === "final_answer"`와, tool call이 개입하면
   조기 완료되지 않는 것.
3. **terminal 매트릭스** — `mode === "required" && stopReason !== undefined` 게이트 안의
   9갈래. `MAX_TOKENS`는 이어쓰기 가능한 incomplete, `MODEL_CONTEXT_WINDOW_EXCEEDED`는
   structured 400 error, 나머지는 각자의 incomplete.

관찰 가능한 효과는 추가 fetch 부재, terminal 종류/reason, 텍스트의 phase다.

## 커밋

```
fix(kiro): honor native stop reasons and Opus 5 effort (#460)

Co-authored-by: Mushikingh <164845020+mushikingh@users.noreply.github.com>
```

## 검증

```bash
bun test --isolate tests/kiro-adapter.test.ts tests/kiro-stream.test.ts \
  tests/bridge.test.ts tests/claude-outbound.test.ts tests/chat-completions-endpoint.test.ts
bun run typecheck
```

A-gate blocker 3: 최초 검증 범위는 kiro 파일 2개뿐이라 **변경된 bridge/client 계약을
전혀 검사하지 않았다.** `incomplete.reason`은 `src/bridge.ts:671-684`,
`src/responses/state.ts:284-307`, `src/claude/outbound.ts:408-420`,
`src/chat/outbound.ts:351-369`을 거쳐 클라이언트까지 간다. 새 reason을 추가하면
이 경로들이 함께 움직인다. 위 6개 파일을 모두 돌린다.

A-gate R2 blocker 4: 파일명을 실측 확인했다. `tests/kiro-events.test.ts`와
`tests/chat-outbound.test.ts`는 **존재하지 않는다.** bun은 없는 경로를 조용히 무시하고
exit 0을 내므로 누락이 드러나지 않는다 — WP2의 `cursor-protobuf.test.ts`와 같은 함정이다.
대응 파일은 각각 `tests/kiro-stream.test.ts`, `tests/chat-completions-endpoint.test.ts`다.

## structure 문서 수정 (A-gate blocker 3)

`structure/04_transports-and-sidecars.md:111-117`은 PR 상태 그대로 두면 여전히
"END_TURN 이외에는 fallback"이라고 설명한다. 결함 A 수정 후 거짓이 된다.
maintainer 불변조건 문서이므로 최종 매트릭스에 맞춰 고친다. 4개 로케일 문서도
위 영문과 동일하게 맞춘다: 출력 한도는 이어쓰기 가능한 incomplete,
컨텍스트 고갈은 비재시도 context-length 오류다. 둘을 한 문장으로 묶지 않는다.
`STOP_SEQUENCE`가 `END_TURN`과 함께 정상 완료라는 점도 명시한다.

PR head의 Ubuntu CI는 `4240 pass / 1 fail`인데, 실패는 무관한
`combo management API > PUT renames atomically...` 타임아웃이다. 통합 head에서 전체 재확인한다.
