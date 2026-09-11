# wp2 — 이슈 #3259: responses tool result 경계 하드닝

대상 이슈: [#3259](https://github.com/lidge-jun/opencodex/issues/3259)
작업 브랜치: `codex/priority65-closeout` (base `origin/dev` = `2421e44ce`, package 2.43.0)
cwd: `/Users/jun/.codex/worktrees/f96c/opencodex`

한 줄 요약: `inputItemSchema` 의 loose 폴백이 call_id 없는 tool 아이템을 삼켜
`toolCallId: undefined` 가 어댑터까지 내려간다. 결함은 **번역 경로에만** 있으므로
파싱 시점이 아니라 **번역 경로에서** 400으로 끊는다.

> **개정 이력 (v2).** 초판은 스키마(파싱 시점) 거부를 골랐다. 감사에서 Critical blocker가
> 나왔고, 재검증 결과 **초판 판정이 틀렸다**. 무엇이 틀렸고 어떻게 바로잡았는지는 §11에
> 남긴다. 같은 실수를 반복하지 않으려면 §11을 먼저 읽어라.

---

## 1. 결함 재검증

### 1.1 스키마가 call_id 없는 tool 아이템을 통과시킨다

`src/responses/schema.ts:78-81` 의 엄격한 스키마:

```ts
const functionCallOutputItemSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().min(1),
  output: toolOutputSchema.optional(),
});
```

`src/responses/schema.ts:97-107` 의 union 마지막 대안이 이걸 무력화한다:

```ts
export const inputItemSchema = z.union([
  userMessageItemSchema,
  systemMessageItemSchema,
  assistantMessageItemSchema,
  reasoningItemSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
  customToolCallItemSchema,
  customToolCallOutputItemSchema,
  z.object({ type: z.string() }).loose(),   // ← :106. 모든 실패를 흡수
]);
```

zod union은 첫 성공 대안을 채택한다. `call_id` 가 없으면 엄격한 대안이 실패하고
마지막 loose 대안이 성공하므로, 아이템은 원본 그대로 `data.input` 에 들어간다.
실측(`inputItemSchema.safeParse`): `function_call`, `function_call_output`,
`custom_tool_call`, `custom_tool_call_output` 네 타입 전부 PASS. `call_id` 가 숫자여도 PASS.

### 1.2 파서가 무검사 대입한다

`src/responses/parser.ts:732-745`:

```ts
      if (effectiveType === "function_call_output") {
        const output = item as { call_id: string; output?: string | unknown[] };   // :733 거짓말하는 캐스트
        attachPendingReasoningToCallOwner(messages, output.call_id, pendingReasoning);
        pendingReasoning.length = 0;
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,      // :738 무검사 대입
```

`:747-752` 의 `custom_tool_call_output` 도 동일하다(`:752`).
`as { call_id: string }` 캐스트가 런타임 검증 없이 타입만 주장하므로 tsc는 침묵한다.

### 1.3 타입이 non-optional인데 undefined가 들어간다

`src/types/request.ts:165-175` 는 `toolCallId: string` (:168, non-optional)이다.
실제 파서 출력(실측, 위임 히스토리 모양):

```
toolResult= {"role":"toolResult","toolName":"","content":"bootstrap result","isError":false,...}
toolCallId typeof: undefined
```

`toolCallId` 키가 아예 사라진다. `string` 선언 필드가 런타임에 `undefined` 다.

### 1.4 세 어댑터의 실제 관측 결과 (전부 실행함)

| 어댑터 | 위치 | 실행 결과 |
|---|---|---|
| ollama-native | `src/adapters/ollama-native.ts:334` | `throw` — `ollama-native orphan tool result <missing-id>` |
| kiro | `src/adapters/kiro-wire.ts:32` (호출부 `kiro.ts:661`) | 실측 `TypeError: undefined is not an object (evaluating 'id.replace')` |
| anthropic | `src/adapters/anthropic.ts:775` → `orphanToolResultText` `:637-643` | 실측: 오염 문자열을 업스트림에 **전송** |

anthropic이 가장 나쁘다. 던지지 않고 오염된 문자열을 보낸다. 실측:

```
contains 'undefined'? true
leak snippet: [tool_result without adjacent tool_use: undefined]\nbootstrap result
```

원인(`anthropic.ts:637-643`) — `toolName` 이 빈 문자열이라 label이 곧 `toolCallId` 가 된다:

```ts
function orphanToolResultText(msg: OcxToolResultMessage): string {
  const label = msg.toolName ? `${msg.toolName} (${msg.toolCallId})` : msg.toolCallId;
```

`src/adapters/google.ts:269` 의 `geminiOrphanToolResultParts` 도 같은 label 로직이라 동일하게 오염된다.

### 1.5 **결정적 사실 — 결함은 번역 경로에만 있다**

이것이 이 문서 전체의 설계 근거다. 직접 실행해서 확인했다.

passthrough 어댑터(`src/adapters/openai-responses.ts:2287` `createResponsesPassthroughAdapter`)는
`parsed._rawBody` 만 읽는다. `rg -n 'context.messages' src/adapters/openai-responses.ts` →
**히트 0건**. 파서는 원본 body를 `_rawBody` 로 그대로 실어 보낸다(`parser.ts:850` `_rawBody: body`).

실측으로 독립성을 증명했다 — `context.messages` 를 **빈 배열로 비운 뒤** 같은 요청을 빌드:

```
guard fires on translated path? true
passthrough forwards item verbatim? {"type":"message","role":"user","content":[{"type":"input_text","text":"[tool output for unknown call]\nbootstrap result"}]}
passthrough identical with EMPTY context.messages? true      ← 바이트 동일
anthropic leaks undefined? true
```

두 가지가 동시에 확인된다:

1. passthrough 출력은 `context.messages` 와 **완전히 무관**하다(비워도 바이트 동일).
2. passthrough는 짝 없는 tool output을 **스스로 복구**한다 — `"[tool output for unknown call]"`
   로 바꿔 정상 user 메시지로 내보낸다. `undefined` 오염이 **없다**.

즉 passthrough는 이 결함의 피해자가 아니라 **이미 올바르게 동작하는 경로**다.
여기에 400을 씌우면 멀쩡한 트래픽을 죽인다.

---

## 2. 스코프 경계

### IN

- **번역 경로**에서 짝 없는(call_id 없는) tool result를 400으로 거부.
- 400 응답의 정확한 형태(status / type / code / message) 확정.
- passthrough / forward / key 모드가 **영향받지 않음**을 실측으로 증명.
- 회귀 피해 전수 조사(표본 아님)와 focused 실행 목록 확정.
- `tests/responses-parser.test.ts` 파서 단위 회귀 + 경계 동작 테스트 추가.
- anthropic `undefined` 누출이 이 가드로 해소되는지 확인 + 명시.

### OUT

- **짝 없는 부트스트랩 tool result를 드롭/합성/강등할 것인가** — 제품 판단. 별도 결정.
  (passthrough는 이미 `[tool output for unknown call]` 로 강등한다. 번역 경로에
  같은 정책을 이식할지는 이 work-phase가 정할 문제가 아니다.)
- `orphanToolResultText` / `geminiOrphanToolResultParts` 의 label 폴백 수정.
- `src/types/request.ts:168` 을 `toolCallId?: string` 으로 바꾸는 것.
  타입 선언이 맞고 런타임이 틀렸다. 타입을 느슨하게 하면 결함을 정당화한다.
- ollama-native / kiro 의 throw 자체.
- `parser.ts:721` 의 `toolCallId: out.call_id ?? ""` (`tool_search_output`) — §6.3.
- 스키마(`inputItemSchema`) 변경. §3에서 기각한다.

---

## 3. 설계 결정 — 세 안 비교

세 안을 **전부 실제로 패치해서** 동일한 63개 파일 스위트로 돌렸다. 표본이 아니라 같은 조건이다.

### 안 A — 스키마 거부 (`src/responses/schema.ts` `inputItemSchema`)

loose 폴백이 call_id 없는 tool 아이템을 삼키지 못하게 해 `parseRequest` 가 던지게 한다.

**기각한다. 결정적 근거는 실행 순서다.**

`src/server/responses/core.ts` 에서 두 지점이 같은 `handleResponsesInner` 안에 있고 순서가 고정이다:

```ts
// :2812
    parsed = parseRequest(body);
...
// :3719 — 훨씬 뒤
  if ("passthrough" in adapter && adapter.passthrough && !routedCompaction) {
```

`parseRequest` 가 passthrough 분기보다 **먼저** 실행된다. 따라서 스키마에서 400을 내면
**번역을 전혀 하지 않는 forward/key passthrough까지 끊는다.** 그런데 §1.5에서 실측했듯
passthrough는 이 결함의 영향을 받지 않고 오히려 스스로 복구한다. 안 A는
**결함이 없는 경로를 죽이는 대가로 결함이 있는 경로를 고치는** 교환이다.

실측 피해(63파일 스위트, 아래 §7 baseline 대비):

```
안 A:      1693 pass / 4 fail   ← baseline 대비 +1 회귀
(fail) routed compaction for key-mode openai-responses (#422) > raw input_image never reaches the upstream
```

이 실패는 픽스처 결함이 아니다. `routedCompaction` 경로(`core.ts:3691-3712`)는
key-mode openai-responses 어댑터를 쓰는데, 그 어댑터는 `_rawBody` 에서 빌드한다
(`core.ts:3703-3706` 주석이 명시: *the key-mode openai-responses adapter builds from _rawBody*).
즉 **번역하지 않는 경로가 스키마 400에 걸린 것**이고, 안 A의 구조적 결함을 그대로 보여준다.

### 안 B — 번역 경로 거부 (`core.ts`, passthrough 분기 **이후**)

passthrough 블록이 끝나는 `core.ts:5153` 이후, 즉 번역 경로만 지나는 지점에서 검사한다.

실측: **baseline과 동일(1694 pass / 3 fail)**. 추가 회귀 0건.
passthrough 테스트 전부 green, routed compaction도 green.

단, 위치를 잘못 잡으면 실패한다. 처음 `:5153` 직후에 무조건 검사하도록 넣었더니
routed compaction이 깨졌다(실측 1 fail). `routedCompaction` 은 passthrough 분기를
`!routedCompaction` 조건으로 **건너뛰고** 내려오지만 여전히 `_rawBody` 기반이기 때문이다.
그래서 위치가 아니라 **어댑터 성질**로 조건을 걸어야 한다:
`if (!("passthrough" in adapter && adapter.passthrough))`. 이렇게 바꾼 뒤 green을 확인했다.

### 안 C — 어댑터 공통 래퍼 (`src/adapters/registry.ts:155` `createRegisteredAdapter`)

모든 어댑터의 `buildRequest` 를 감싸는 **단 하나의 래퍼**가 이미 존재한다(`:154-172`).
여기 넣으면 `core.ts` 의 8개 `buildRequest` 호출 지점
(`:1258, :3775, :4174, :4285, :4392, :5806, :5931, :6373`)을 **전부** 한 번에 덮는다.

실측: 안 B와 동일하게 **baseline 동일(1694 pass / 3 fail)**, `tsc` exit 0.

**그런데 안 C는 에러 형태를 통제할 수 없다.** 래퍼는 `buildRequest` 안이므로 throw만 가능하고,
그 throw를 받는 `core.ts:3774-3788` 의 catch는 **두 개의 지정된 에러 클래스만** 400으로 바꾼다:

```ts
    } catch (error) {
      releaseCodexAuthContextProbeLease(authCtx);
      if (error instanceof NamespaceToolCollisionError || error instanceof XaiToolSchemaCompatibilityError) {
        return formatErrorResponse(400, "invalid_request_error", redactSecretString(error.message));
      }
      throw error;   // ← 그 외는 전부 재throw = 500
    }
```

바로 위 주석이 이 함정을 직접 기록해 두었다: *Rethrowing it here escaped every catch up to the
Bun handler, so the same request produced an unstructured 500 — and no request log*.
안 C로 400을 내려면 **새 에러 클래스를 만들어 이 catch에 등록**해야 하고, 그러면 변경 표면이
`registry.ts` + 새 에러 모듈 + `core.ts` catch 세 곳으로 늘어난다. 경계 하드닝 한 건에 비해 과하다.

### 결정: **안 B**

| 기준 | A 스키마 | B 번역 경로 | C 레지스트리 래퍼 |
|---|---|---|---|
| passthrough 계약 보존 | **깨짐** (+1 회귀) | 보존 | 보존 |
| routed compaction 보존 | **깨짐** | 보존 | 보존 |
| 400 형태 통제 | 가능 | **가능 (직접 return)** | 불가 (500이 기본) |
| 변경 파일 수 | 1 | **1** | 3 |
| 결함 없는 경로에 영향 | 있음 | **없음** | 없음 |

안 B는 결함이 실재하는 경로에만 정확히 걸리고, 400을 직접 반환하며, 파일 하나만 바꾼다.

---

## 4. 파일 변경 맵

### 4.1 MODIFY — `src/server/responses/core.ts` (유일한 프로덕션 변경)

**위치**: passthrough 블록이 닫히는 `:5153` 직후, 사이드카 계획(`:5155` 주석) 직전.

**before** (현재 `:5147-5158`):

```ts
    } finally {
      if (hostAdmissionLease) {
        releaseUpstreamHostAdmission(hostAdmissionLease);
        releaseCodexAuthContextProbeLease(authCtx);
      }
    }
  }

  // Image / web-search sidecars: plan once, then dispatch with runTurn-aware priority.
```

**after**:

```ts
    } finally {
      if (hostAdmissionLease) {
        releaseUpstreamHostAdmission(hostAdmissionLease);
        releaseCodexAuthContextProbeLease(authCtx);
      }
    }
  }

  // Tool results are PAIRED by call_id. parseRequest writes it into OcxToolResultMessage.toolCallId
  // (parser.ts:738/752) without validating it, because inputItemSchema's permissive catch-all
  // (schema.ts:106) accepts a tool item whose strict schema failed only for a missing call_id. A
  // translating adapter then consumes `toolCallId: string` holding undefined: kiro-wire.ts:32
  // TypeErrors, ollama-native.ts:334 throws, and anthropic.ts:775 sends
  // "[tool_result without adjacent tool_use: undefined]" upstream (issue #3259).
  //
  // This CANNOT move into the schema. parseRequest (:2812) runs before the passthrough branch
  // (:3719), so a parse-time rejection would also kill forward/key passthrough and routed
  // compaction — paths that never read context.messages, build from _rawBody, and already
  // degrade an unpaired output to "[tool output for unknown call]" on their own.
  //
  // Keyed on the adapter, not on position: routedCompaction skips the passthrough branch above
  // yet still builds from _rawBody (see the :3703 comment).
  if (!("passthrough" in adapter && adapter.passthrough)) {
    const unpaired = parsed.context.messages.find(
      message => message.role === "toolResult"
        && (typeof (message as { toolCallId?: unknown }).toolCallId !== "string"
          || (message as { toolCallId: string }).toolCallId.length === 0),
    );
    if (unpaired) {
      // Never interpolate the tool output: this message reaches the client and the logs.
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "tool result requires a non-empty string call_id",
      );
    }
  }

  // Image / web-search sidecars: plan once, then dispatch with runTurn-aware priority.
```

`formatErrorResponse` 는 이 파일에서 이미 쓰인다(예: `:2875`, `:3785`). **새 import 불필요.**

### 4.2 MODIFY — `tests/responses-parser.test.ts` (회귀 테스트)

파일 끝(`:797`, `describe("codex-rs compat surface (260707)")` 가 `:568`~`:797`) 뒤에 추가한다.

이 테스트가 검증하는 것은 **파서가 결함 상태를 실제로 만들어낸다**는 사실 자체다.
§4.1 가드는 이 상태를 전제로 동작하므로, 이 관측이 무너지면 가드도 무의미해진다.

```ts
describe("unpaired tool result boundary (#3259)", () => {
  // The real delegation-history shape that produced the defect: a subagent bootstrap turn
  // whose FIRST tool result has no originating call in the same request.
  const delegationHistory = (toolItem: Record<string, unknown>) => ({
    model: "test-model",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a subagent." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "do the task" }] },
      toolItem,
    ],
  });

  const toolResultOf = (item: Record<string, unknown>) =>
    parseRequest(delegationHistory(item)).context.messages.find(m => m.role === "toolResult") as
      | { toolCallId?: unknown }
      | undefined;

  test("a function_call_output with no call_id still parses, and yields an unusable toolCallId", () => {
    // This is the state src/server/responses/core.ts guards on. `toolCallId` is declared
    // `string` (src/types/request.ts:168) but is undefined here — the schema catch-all
    // (schema.ts:106) accepted the item and parser.ts:738 assigned it unchecked.
    const result = toolResultOf({ type: "function_call_output", output: "bootstrap result" });
    expect(result).toBeDefined();
    expect(typeof result?.toolCallId).not.toBe("string");
  });

  test("an empty-string call_id is equally unusable", () => {
    // findToolById (parser.ts:328) matches by identity, so "" can never pair. The guard
    // must treat it exactly like undefined.
    const result = toolResultOf({ type: "function_call_output", call_id: "", output: "x" });
    expect(result?.toolCallId).toBe("");
  });

  test("a well-formed tool result on the same history pairs normally", () => {
    const result = toolResultOf({ type: "function_call_output", call_id: "call_1", output: "ok" });
    expect(result).toMatchObject({ toolCallId: "call_1", content: "ok" });
  });

  test("custom_tool_call_output has the identical hole (parser.ts:752)", () => {
    const result = toolResultOf({ type: "custom_tool_call_output", output: "x" });
    expect(result).toBeDefined();
    expect(typeof result?.toolCallId).not.toBe("string");
  });

  test("tolerances unrelated to call_id stay intact", () => {
    // parser.ts:611-621 deliberately tolerates non-JSON arguments; nothing here may 400 it.
    expect(() => parseRequest(delegationHistory({
      type: "function_call", call_id: "c1", name: "shell", arguments: "not json",
    }))).not.toThrow();
    // Unknown future item types must keep flowing through the catch-all untouched.
    expect(() => parseRequest(delegationHistory({
      type: "brand_new_item_2027", foo: 1,
    }))).not.toThrow();
  });
});
```

`describe` / `expect` / `test` / `parseRequest` 는 `:1-4` 에서 이미 import되어 있다.

### 4.3 서버 레벨 400 회귀 테스트 (권장, 위치 주의)

`core.ts` 가드의 400을 직접 검증하려면 `handleResponses` 를 통과시켜야 하고, 그건
완전한 `config` 가 필요하다(실측: config 없이 호출하면 `Object.hasOwn(config.providers, ...)` 에서
404가 난다). 기존 하네스가 이미 있는 `tests/responses-compaction-routing.test.ts` 의
`compactionRequest()` / `keyProviderConfig()` 패턴(`:89-115`)을 참고해
**번역 어댑터(anthropic 등) 라우트로** 케이스를 추가하라. 검증할 것은 두 가지다:

- 응답이 `400` 이고 message가 `tool result requires a non-empty string call_id` 다.
- `fetch` 스텁이 **한 번도 호출되지 않는다**(업스트림 전송 0회).

passthrough 라우트로 같은 body를 보내면 **200이 나와야 한다**. 그 대비가 이 설계의 핵심 주장이다.

### 4.4 NEW / DELETE

없음.

### 4.5 변경하지 **않는** 파일 (명시)

- `src/responses/schema.ts` — 안 A 기각(§3).
- `src/responses/parser.ts` — 파서는 passthrough와 공유된다. 여기서 `call_id` 를 강제하면
  안 A와 같은 부작용이 난다.
- `src/adapters/` 전부 — 가드가 앞서므로 도달하지 않는다.
- `tests/openai-responses-compaction-routing` 픽스처 — 안 B에서는 **수리가 필요 없다**
  (초판이 요구했던 픽스처 수정은 안 A의 부작용이었다).

---

## 5. 조건 분기 activation scenario

§4.1이 추가하는 조건 분기는 **두 개**다.

### 분기 1 — `if (!("passthrough" in adapter && adapter.passthrough))`

- **C(클라이언트)가 어떻게 발화시키는가**: 라우팅 결과가 passthrough 어댑터
  (`openai-responses` key/forward, `azure-openai` — `adapters/azure.ts:5` 가
  `ProviderAdapter & { passthrough: true }` 를 반환)인 요청. 예: xAI grok을 key 모드로,
  또는 ChatGPT forward 모드로 부르는 Codex 턴.
- **무엇이 관측되는가**: 가드 전체를 건너뛴다. call_id 없는 tool output이 있어도 **200**이고,
  업스트림 body에는 passthrough 자신의 복구 결과
  `[tool output for unknown call]` 가 실린다(§1.5 실측). `undefined` 는 나타나지 않는다.
- **검증**: `bun test tests/openai-responses-passthrough.test.ts` 가 green을 유지
  (실측 125/125 상당, 전체 배치에서 baseline 동일).

### 분기 2 — `if (unpaired)` — `toolCallId` 가 문자열이 아니거나 빈 문자열

- **C가 어떻게 발화시키는가**: 번역 어댑터(anthropic / google / kiro / ollama-native / cursor …)로
  라우팅되는 요청에, 같은 요청 안에 짝이 되는 `function_call` 없이
  `{type: "function_call_output", output: ...}` 만 실려 오고 `call_id` 가 누락/빈문자열/비문자열인 경우.
  위임(subagent) 부트스트랩 히스토리가 이슈 #3259가 보고한 실제 트래픽 모양이다.
- **무엇이 관측되는가**: HTTP `400`,
  `{"error":{"message":"tool result requires a non-empty string call_id","type":"invalid_request_error","code":"invalid_request_error"}}`.
  **업스트림 provider 호출 0회** — 가드가 `buildRequest` 앞이므로 fetch 스텁이 한 번도 안 불린다.
  이전에는 anthropic이 200과 함께 오염 문자열을 보냈다.
- **검증**: §4.3 서버 레벨 테스트.

### 분기 미도달 — 정상 번역 턴

- **C가 어떻게 발화시키는가**: 짝이 맞는 `function_call` + `function_call_output`.
- **무엇이 관측되는가**: `find` 가 `undefined` 를 반환해 가드를 통과. 동작 변화 0.
  `messages` 순회 1회가 추가될 뿐이다(요청당 O(n), n = 메시지 수).

---

## 6. anthropic `undefined` 누출 — 이 가드로 해소되는가

### 6.1 결론

**번역 경로에서 해소된다. 어댑터는 한 줄도 고치지 않는다.**

### 6.2 근거

§1.5 실측에서 두 사실이 같이 나왔다:

```
guard fires on translated path? true      ← 가드 조건이 정확히 이 요청에서 참
anthropic leaks undefined? true           ← 가드가 없으면 오염이 실제로 나감
```

가드가 `buildRequest` 이전에 400을 반환하므로 `orphanToolResultText` 가 호출되지 않는다.
`kiro-wire.ts:32` TypeError, `ollama-native.ts:334` throw, `google.ts:269` 의 동일 label 오염도
모두 같은 이유로 도달 불가가 된다. **네 어댑터 결함이 한 곳의 변경으로 사라진다.**

### 6.3 남는 구멍 (OUT, 후속 단위)

`parser.ts:721` 의 `toolCallId: out.call_id ?? ""` (`tool_search_output`) 는
이 가드에 **잡힌다** — 빈 문자열도 분기 2의 조건이기 때문이다. 즉 지금까지
`"tool_search ()"` 로 조용히 오염되던 요청이 이제 400이 된다.

이건 **의도한 부작용이자 동시에 위험**이다. `tool_search_output` 에 `call_id` 가 없는 요청을
실제로 보내는 클라이언트가 있다면 회귀가 된다. 63파일 전수 스위트에서 그런 픽스처는
**나오지 않았다**(§7). 그래도 배포 후 400 로그에서 이 메시지가 뜨는지 지켜볼 것.
필요하면 `tool_search_output` 만 예외 처리하는 후속 단위를 연다.

---

## 7. 회귀 전수 조사 + Verifier (PLAN-VERIFIER-REAL-01)

### 7.1 후보 전수 수집 (표본 아님)

```bash
rg -n '"function_call_output"|"custom_tool_call_output"|"custom_tool_call"|"function_call"' tests/ -l | sort
```

→ **65개 파일**. 이 중 `tests/fixtures/compatibility/openai-codex-forward-gpt56-sol-v1.json` (JSON)과
`tests/helpers/agent-task-recovery.ts` (헬퍼)는 테스트 파일이 아니므로 실행 대상에서 빠지고,
**63개 `.test.ts`** 가 실행 목록이 된다. 목록은 위 명령으로 재생성 가능하다.

### 7.2 baseline 먼저 확정 (이게 없으면 판정 불가)

```bash
git stash push -- src/server/responses/core.ts   # 변경 제거
bun test <63개 파일>
```

실측 baseline: `1694 pass / 3 fail`.

**그 3건은 이 변경과 무관한 기존 실패다.** `tests/server-xai-responses-streaming.test.ts` 의
`xAI OAuth Responses streaming opt-in` 3개 테스트로, **깨끗한 트리에서도 동일하게 실패한다**
(실측). 단독 실행 시에는 `3 pass / 0 fail` 이므로 63파일 병렬 배치에서만 나타나는
기존 간섭이다. 이 변경의 책임이 아니고, 이 work-phase에서 고치지 않는다.

### 7.3 세 안 실측 비교 (같은 63파일, 같은 조건)

| 안 | 결과 | baseline 대비 |
|---|---|---|
| baseline (변경 없음) | 1694 pass / 3 fail | — |
| **안 B (채택)** | **1694 pass / 3 fail** | **+0 회귀** |
| 안 C (레지스트리) | 1694 pass / 3 fail | +0 회귀 (단 400 불가, §3) |
| 안 A (스키마) | 1693 pass / 4 fail | **+1 회귀** (routed compaction) |

안 A만 추가 회귀를 낸다. 그 1건이 §3에서 설명한 구조적 결함의 직접 증거다.

### 7.4 Verifier 표 (전부 실제 실행함)

| # | 커맨드 | exit | 이 커맨드가 변경 대상을 실제로 읽는가 |
|---|---|---|---|
| V1 | `bun x tsc --noEmit` | 0 | 읽는다 — `src/server/responses/core.ts` 는 tsconfig 대상이고, `message` 좁히기 캐스트가 여기서 판정된다 |
| V2 | `bun test tests/responses-parser.test.ts` | 0 | 읽는다 — §4.2 새 블록이 이 파일에 있고 `parseRequest` 를 직접 호출한다. **단 `core.ts` 가드는 보지 못한다** — 파서 단위 관측 전용이다 |
| V3 | `bun test tests/responses-compaction-routing.test.ts` | 0 | 읽는다 — `handleResponses` 를 통과하므로 §4.1 가드 코드를 **실제로 실행**한다. routedCompaction이 가드에 걸리지 않아야 함을 여기서 판정한다. 안 B 초기 위치(무조건 검사)에서 실제 red를 봤다 |
| V4 | `bun test tests/openai-responses-passthrough.test.ts tests/responses-compaction-routing.test.ts` | 0 | 읽는다 — **V4가 이 변경을 관측하는 커맨드다**. 초판이 지목한 `:2343` 단독 테스트는 `adapter.buildRequest({_rawBody})` 직접 호출이라(`:2368`) `core.ts` 를 우회해 **아무것도 관측하지 못한다**. compaction 파일이 `handleResponses` 경유로 가드를 실행하므로 둘을 **함께** 돌려야 passthrough 보존을 실제로 증명한다. 실측 176 pass / 0 fail |
| V5 | 63파일 전수 (§7.1 목록) | 3 fail = baseline | 읽는다 — 63개 중 **18개**가 `handleResponses` 를 호출하므로 가드 코드가 실제로 실행된다(실측: `xargs rg -l 'handleResponses' < 후보목록 \| wc -l` → 18). 나머지 45개는 어댑터/파서 단위라 가드에 도달하지 않지만, 후보 수집이 표본이 아니라 전수임을 보이는 것이 이 행의 목적이다. baseline과 동일해야 통과 |

**금지**: `bun run test`, 인자 없는 `bun test`. V5는 rg로 수집한 명시적 파일 목록 실행이지
전체 스위트가 아니다(전체는 ~850파일, V5는 63파일).

### 7.5 red 확인 의무

V3는 **red를 실제로 봤다**(가드를 위치 기반으로 넣었을 때 1 fail). V2의 파서 관측 테스트는
현재 코드에서 green이다 — 결함 상태를 기술하는 테스트이기 때문이다. §4.3 서버 테스트를
추가한다면 가드를 잠시 제거해 red를 확인하라. red를 못 본 테스트는 신뢰할 수 없다.

---

## 8. Accept criteria (testable)

1. `bun x tsc --noEmit` exit 0. (V1)
2. `bun test tests/responses-parser.test.ts` exit 0, §4.2 블록 5건 pass. (V2)
3. `bun test tests/openai-responses-passthrough.test.ts tests/responses-compaction-routing.test.ts`
   exit 0. (V4 — 실측 176 pass / 0 fail)
4. 63파일 전수 실행이 **baseline과 동일**: 1694 pass / 3 fail, 그 3건이 §7.2의
   xAI 기존 실패와 **정확히 일치**. 다른 실패가 하나라도 늘면 실패다. (V5)
5. **번역 어댑터** 라우트 + call_id 없는 `function_call_output` → HTTP `400`,
   `type`/`code` = `invalid_request_error`, message = `tool result requires a non-empty string call_id`.
6. 같은 요청에서 업스트림 fetch **0회**.
7. **passthrough 라우트**에 동일 body → **200**, 업스트림 body에
   `[tool output for unknown call]` 포함, `undefined` **미포함**.
8. 400 body가 요청의 `output` 값을 포함하지 않는다(메시지가 상수 문자열이므로 구조적으로 보장).
9. 변경 파일이 정확히 `src/server/responses/core.ts` 와 `tests/responses-parser.test.ts`
   (+§4.3 채택 시 서버 테스트 파일) 뿐이다. `src/responses/schema.ts`, `src/responses/parser.ts`,
   `src/adapters/` 는 `git diff --name-only` 에 **나오지 않는다**.

---

## 9. 필드 체인 (PLAN-FIELD-CHAIN-01)

**이 변경은 타입이나 enum에 필드를 추가하지 않는다.** 새 creation → serialization →
deserialization → consumer 체인이 생기지 않는다.

확인 사항:

- `OcxToolResultMessage`(`src/types/request.ts:165-175`) 변경 없음.
  `toolCallId: string` 유지 — 이 변경의 목적이 **그 선언을 참으로 만드는 것**이다.
- `OcxToolCall`(`:211-227`), `inputItemSchema`, `responsesRequestSchema` 전부 변경 없음.
- 새 에러 클래스 없음. 새 에러 `code` 없음. 따라서 `classifyError`(`src/lib/errors.ts:149`),
  `/api/logs` 소비자, GUI 에러 표시 경로 모두 변경 없음.
- 가드는 **읽기 전용**이다. `parsed` 를 변형하지 않으므로 이후 파이프라인
  (사이드카 계획, 툴 브리지, 스트림 처리)의 입력이 달라지지 않는다.

영향을 받는 유일한 관측 가능 표면은 **번역 경로의 HTTP 400 응답**이다.
`formatErrorResponse(400, "invalid_request_error", ...)` 는 이 파일이 이미 여러 번 쓰는 형태이고
(`:2875`, `:3785`, `:5824`), `classifyError` 가 `code` 를 `invalid_request_error` 로 확정한다.
커스텀 `code` 를 넘겨도 `isCyberPolicyCode` 가 아니면 무시된다(`src/bridge.ts:2088-2093`).

---

## 10. 구현 순서

1. 63파일 목록 재생성(§7.1) 후 **baseline 먼저 측정**. 이걸 건너뛰면 §7.2의 기존 xAI 실패 3건을
   자기 회귀로 오인한다.
2. `src/server/responses/core.ts` 에 §4.1 적용.
3. `bun x tsc --noEmit` (V1).
4. `bun test tests/openai-responses-passthrough.test.ts tests/responses-compaction-routing.test.ts` (V4).
   **여기가 설계의 핵심 주장이 무너지는지 보는 지점이다.**
5. `tests/responses-parser.test.ts` 에 §4.2 적용 후 V2.
6. (선택) §4.3 서버 테스트 추가 — 가드 제거 상태에서 red 확인 후 복구.
7. V5 전수 실행, baseline과 대조.
8. `git diff --name-only` 로 accept criteria 9 확인.

PR은 `dev` 를 target하고 설명에 `Closes #3259` 를 넣는다. `dev` 는 default branch가 아니므로
머지 후 이슈를 **수동으로 닫아야 한다**(AGENTS.md).

---

## 11. 초판(v1)이 틀린 지점 — 재발 방지 기록

초판은 **안 A(스키마 거부)** 를 골랐다. 감사에서 Critical blocker가 나왔고 재검증 결과 사실이었다.
세 가지가 틀렸다.

### 11.1 픽스처를 조작한 결과를 근거로 썼다 (가장 심각)

초판 §3.3은 좁은 스키마 가드가 `openai-responses-passthrough` 의 fail-closed 픽스처를
관용한다고 적으며 `fco output unknown block PASS` 를 근거로 제시했다.
**그 PASS는 픽스처에 없는 `call_id: "c1"` 을 내가 임의로 덧붙였을 때만 나온다.**
원본 `tests/openai-responses-passthrough.test.ts:2350-2366` 의 6개 픽스처는 **전부 call_id가 없다**:

```ts
    const invalidOutputs = [
      { type: "custom_tool_call_output" },
      { type: "function_call_output", output: [{ type: "bogus", value: "not a tool-output part" }] },
      // … 나머지 4개도 전부 call_id 없음
    ];
```

즉 초판은 **자기가 만든 변형을 원본이라고 착각하고** 안전하다고 결론지었다.
교훈: 픽스처를 인용할 때는 반드시 원본 라인을 다시 열어 대조한다. 프로브 스크립트에서
값을 채워 넣었다면 그건 근거가 아니다.

### 11.2 이 변경을 볼 수 없는 커맨드를 verifier로 지목했다

초판 V4는 `tests/openai-responses-passthrough.test.ts` 단독이었다. 그런데 그 파일의 해당
테스트는 `adapter.buildRequest({ ...parsedBase, _rawBody })` 를 **직접** 호출한다(`:2367-2370`).
`handleResponses` 도 `parseRequest` 도 지나지 않으므로 스키마 변경도 core 변경도 관측 못 한다.
실제로 가드를 넣어도 그 파일은 초록이었다 — **초록의 의미가 없는 초록**이었다.
교훈: verifier를 적을 때 "이 커맨드가 변경 지점을 실행하는 호출 경로"를 한 줄로 쓸 수 없으면
그 커맨드는 verifier가 아니다. v2 §7.4는 각 행에 그 근거를 강제로 적었다.

### 11.3 결함의 위치를 잘못 짚었다

결함은 파싱이 아니라 **번역**에 있었다. passthrough는 `_rawBody` 만 읽고(`context.messages` 참조
0건), 짝 없는 output을 스스로 강등해 이미 올바르게 동작한다. 초판은 이걸 확인하지 않고
`parseRequest` 가 passthrough보다 먼저 실행된다는 사실(`core.ts:2812` vs `:3719`)도 놓쳐서,
**멀쩡한 경로까지 끊는 위치**에 가드를 놓았다. 그 대가가 실측 +1 회귀였다.
교훈: "어디서 터지는가"가 아니라 "어떤 코드가 그 필드를 실제로 읽는가"로 경계를 정한다.
`rg -n 'context.messages' src/adapters/<adapter>.ts` 한 번이면 갈렸다.

### 11.4 회귀 조사를 표본으로 했다

초판은 6개 파일을 골라 돌리고 "추가 피해 0건"이라고 적었다. v2는 rg로 65개 후보를 전수 수집해
63개를 돌렸고, 그 과정에서 **baseline에 이미 3건의 기존 실패가 있다**는 사실을 발견했다(§7.2).
표본만 돌렸다면 이 3건을 자기 회귀로 오인하거나, 반대로 진짜 회귀를 놓쳤을 것이다.
