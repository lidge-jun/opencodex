# 010 — Responses reasoning을 후속 assistant에 fold

## Work-phase outcome

`parseRequest`가 Responses 입력의 `[reasoning, assistant message]`를 두 개의
`OcxAssistantMessage`로 분리하지 않고, reasoning part를 바로 뒤 assistant의 `content` 앞에
붙인다. 따라서 Grok reasoning 모델을 위한 `preserveReasoningContentModels`가 활성화된 경우
chat-completions wire에는 assistant가 정확히 하나만 나가며 그 메시지에
`reasoning_content`와 answer `content`가 함께 존재한다.

공식 기준은
`/Users/jun/Developer/codex/180_grok-build/crates/codegen/xai-grok-sampling-types/src/conversation.rs:1814-1860`의
pending-reasoning fold와 `:8413-8446` 회귀 테스트다. OpenCodex의 현재 분리 지점은
`src/responses/parser.ts:324-350`, 독립 직렬화 지점은
`src/adapters/openai-chat.ts:104-134`, opaque encrypted blob의 decode 한계는
`src/responses/reasoning-envelope.ts:34-52`다.

## IN / OUT

IN:

- `parseRequest`의 바로 앞 reasoning → 후속 assistant message fold.
- summary/content 또는 `ocxr1` envelope에서 복구 가능한 thinking text 보존.
- native/non-`ocxr1` encrypted-only reasoning을 assistant placeholder 없이 폐기.
- `parseRequest`부터 Grok chat wire까지 통과하는 여섯 개의 회귀 테스트와, 두 signed
  sibling을 Anthropic wire까지 replay하는 activation test.

OUT:

- `openai-chat.ts`의 `reasoning_content` 직렬화 정책 변경.
- `reasoning-envelope.ts`에서 native OpenAI/xAI encrypted blob 복호화.
- Anthropic envelope 형식, provider registry, production runtime 변경.

## File change map

| Marker | Path | Change |
|---|---|---|
| MODIFY | `src/responses/parser.ts` | pending reasoning을 만들되 메시지를 즉시 생성하지 않고, 다음 assistant message에 prepend |
| MODIFY | `tests/xai-transport.test.ts` | 수동 `OcxAssistantMessage` 테스트를 parser-to-wire 회귀 여섯 건으로 교체 |
| MODIFY | `tests/anthropic-thinking-signature.test.ts` | 두 signed sibling의 text/signature 대응을 parser-to-Anthropic wire에서 고정 |
| READ ONLY | `src/adapters/openai-chat.ts` | 기존 thinking → `reasoning_content` 변환을 그대로 소비 |
| READ ONLY | `src/adapters/anthropic.ts` | 각 signed thinking part를 독립 block으로 replay하는 기존 변환을 그대로 소비 |
| READ ONLY | `src/responses/reasoning-envelope.ts` | `decodeReasoningEnvelope(...) === null`인 opaque blob 판정 계약을 그대로 소비 |

## Diff specification

### MODIFY — `src/responses/parser.ts`

#### 1. Pending state 추가

`parseRequest`의 현재 local state(`src/responses/parser.ts:227-236`)에 한 turn짜리 pending
reasoning entry list를 추가한다. 각 entry는 thinking part와 `ocxr1` envelope signature의
실재 여부를 함께 기록한다. 이 boolean은 `signature` 문자열 자체로 재추론하지 않는다.
현재 parser가 non-envelope reasoning에 넣는 `JSON.stringify(reasoning)` synthetic signature도
유지하지만, join 분류에서는 **unsigned**다. 오직 `envelope?.sig`가 있는 part만 signed다.
새 helper/type/file은 만들지 않는다.

Before:

```ts
  const messages: OcxMessage[] = [];
  const systemPrompt: string[] = [];
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];
```

After:

```ts
  const messages: OcxMessage[] = [];
  const systemPrompt: string[] = [];
  // Responses reasoning siblings belong to the following assistant, including across call items.
  // Keep them off the message list until that assistant arrives; turn boundaries clear the array.
  const pendingReasoning: Array<{ part: OcxThinkingContent; envelopeSigned: boolean }> = [];
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];
```

#### 2. Assistant message가 pending reasoning을 소비

현재 assistant branch(`src/responses/parser.ts:324-327`)에서 pending part를 text보다 앞에
prepend하고 즉시 clear한다. 순서는 wire cache prefix와 `thinking`/answer 결합을 고정한다.

Before:

```ts
          case "assistant": {
            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
            messages.push({ role: "assistant", content: parts, model: data.model, timestamp: now });
            break;
          }
```

After:

```ts
          case "assistant": {
            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
            messages.push({
              role: "assistant",
              content: pendingReasoning.length > 0
                ? [...pendingReasoning.map(entry => entry.part), ...parts]
                : parts,
              model: data.model,
              timestamp: now,
            });
            pendingReasoning.length = 0;
            break;
          }
```

#### 3. Reasoning branch는 decodable text만 pending으로 보존

현재 reasoning branch(`src/responses/parser.ts:333-350`)는 빈 thinking까지
`ensureAssistantPlaceholder`에 넣는다. 이를 다음 규칙으로 교체한다.

- 보존: summary text 우선, 없으면 content text, 없으면 `ocxr1` envelope의 `txt`.
- 함께 보존: decodable `ocxr1`의 `sig`, `red`, reasoning `id`.
- 폐기: summary/content가 비고 `decodeReasoningEnvelope`가 `null`인 native/non-`ocxr1`
  encrypted-only blob. 원문 encrypted bytes와 빈 thinking part는 wire에 남기지 않는다.
  plaintext가 있는 non-envelope reasoning의 기존 synthetic JSON signature는 유지하되 unsigned로 분류한다.
- `envelope?.sig`가 있는 reasoning은 signed entry로 append하며 절대 다른 sibling과 join하지
  않는다. signature, redacted, itemId, thinking text의 대응을 그대로 보존한다.
- `envelope?.sig`가 없는 reasoning은 unsigned다. 바로 앞 pending entry도 unsigned일 때만
  `"\n"`으로 합쳐 하나의 part로 만든다. signed entry가 사이에 있으면 새 unsigned part를
  시작한다. 합쳐진 unsigned part의 metadata는 마지막 sibling 것을 사용한다.
- non-envelope reasoning의 `JSON.stringify(reasoning)` signature는 기존 adapter rejection
  contract를 위해 part에 남지만 synthetic signature이므로 unsigned join 대상이다.

Before:

```ts
      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[]; encrypted_content?: string };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        // ocxr1 envelope: the REAL Anthropic signature (+ redacted blocks, + hidden signed text)
        // captured by the bridge. Native OpenAI-encrypted blobs decode to null and keep today's
        // placeholder signature (which the anthropic adapter correctly rejects on replay).
        const envelope = typeof reasoning.encrypted_content === "string"
          ? decodeReasoningEnvelope(reasoning.encrypted_content)
          : null;
        const thinking: OcxThinkingContent = {
          type: "thinking",
          thinking: envelope?.txt || text,
          signature: envelope?.sig ?? JSON.stringify(reasoning),
          ...(envelope?.red ? { redacted: envelope.red } : {}),
          ...(reasoning.id ? { itemId: reasoning.id } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
        continue;
      }
```

After:

```ts
      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[]; encrypted_content?: string };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        const envelope = typeof reasoning.encrypted_content === "string"
          ? decodeReasoningEnvelope(reasoning.encrypted_content)
          : null;
        const thinkingText = envelope?.txt || text;

        // Native/non-ocxr1 encrypted-only reasoning is opaque here. Do not create a detached
        // assistant turn or invent replayable plaintext/signatures from the encrypted payload.
        if (thinkingText.length > 0) {
          const part: OcxThinkingContent = {
            type: "thinking",
            thinking: thinkingText,
            signature: envelope?.sig ?? JSON.stringify(reasoning),
            ...(envelope?.red ? { redacted: envelope.red } : {}),
            ...(reasoning.id ? { itemId: reasoning.id } : {}),
          };
          const envelopeSigned = typeof envelope?.sig === "string";
          const previous = pendingReasoning[pendingReasoning.length - 1];

          if (!envelopeSigned && previous && !previous.envelopeSigned) {
            previous.part = {
              ...part,
              thinking: `${previous.part.thinking}\n${part.thinking}`,
            };
          } else {
            pendingReasoning.push({ part, envelopeSigned });
          }
        }
        continue;
      }
```

#### 4. 모든 후속 item class의 pending 규칙

`src/responses/parser.ts:245-479`에서 reasoning 뒤 도달 가능한 class와 정확한 동작은 다음과
같다. `compaction` 계열은 user-role history를 만들므로 user boundary와 동일하게 clear한다.
`additional_tools`/`compaction_trigger`는 conversation item이 아니므로 pending을 소비하거나
clear하지 않는다.

| 다음 item class | 현재 동작 | 변경 후 pending 동작 |
|---|---|---|
| assistant message | 새 assistant message push | signed는 개별 유지하고 연속 unsigned만 newline-join한 parts를 prepend한 뒤 clear |
| user/developer message | user/developer message push | push 전에 clear |
| system message | `systemPrompt`에 append | append 전에 clear |
| agent message | user-role external turn push | push 전에 clear |
| function/custom/local-shell/tool-search call | `ensureAssistantPlaceholder`가 assistant tool-call placeholder를 생성/재사용 | placeholder에는 call만 넣고 pending은 보존; 다음 explicit assistant가 reasoning을 소비 |
| web-search call | placeholder에 synthetic assistant text append | 공식 BackendToolCall과 같은 call-side evidence이므로 pending 보존 |
| function/custom/tool-search output | toolResult push | push 전에 clear |
| another reasoning | 현재 placeholder에 sibling append | signed면 별도 append; 바로 앞 entry와 모두 unsigned일 때만 `"\n"` merge |
| end-of-input | 현재 reasoning placeholder가 남음 | flush하지 않고 pending array를 자연 폐기; 대응 assistant가 없는 취소/고아 reasoning은 chat-completions 표현이 없으므로 drop |

Boundary branches에는 push/append보다 먼저 아래 한 줄을 넣는다.

```ts
pendingReasoning.length = 0;
```

정확한 삽입 지점은 다음과 같다.

- `compaction`/`compaction_summary`/payload가 있는 `context_compaction`: `messages.push` 직전.
- `agent_message`: `messages.push` 직전.
- `message`의 `system`, `user`, `developer`: 각 branch의 content 변환 전.
- `tool_search_output`, `function_call_output`, `custom_tool_call_output`: output 해석 및
  `findToolById` 전. tool-result boundary가 pending을 뒤 assistant로 넘기지 않는 것이 우선이다.

Call branch(`function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`,
`tool_search_call`)에는 clear 코드를 추가하지 않는다. 현재 parser의 placeholder consumer는
tool call을 별도 assistant history item에 유지하는 역할만 한다. 따라서
`[reasoning, function_call, assistant]`는 `[{assistant toolCall}, {assistant thinking+answer}]`로
파싱되고 pending reasoning은 call placeholder에 붙지 않은 채 explicit assistant까지 보존된다.
이는 공식 `[Reasoning, BackendToolCall, Assistant]` 보존 규칙과 일치한다.

#### 5. Multiple thinking part serializer 확인

- OpenAI Chat은 assistant content에서 thinking part를 원래 순서대로 filter한 뒤 text를
  `join("")`하여 하나의 `reasoning_content`로 만든다
  (`src/adapters/openai-chat.ts:104-115`). Parser가 unsigned sibling 내부에 정확히 하나의
  newline을 넣으므로 Grok wire는 `first\nsecond`가 되고, signed part가 여러 개여도 이
  adapter에서는 part 순서대로 자연스럽게 concatenate된다. 이 phase에서 adapter 변경은 없다.
- Anthropic은 assistant content를 순서대로 순회한다 (`src/adapters/anthropic.ts:396-420`).
  각 thinking part의 redacted payload를 먼저 replay하고 (`:404-410`), 그 **동일 part**의
  signature가 real-signature gate를 통과하면 `{type:"thinking", thinking, signature}`를
  독립 block으로 push한다 (`:411-413`). 따라서 parser가 두 signed sibling을 두 part로
  유지하면 각 signature가 자기 text에 붙어 원래 순서대로 replay된다. 빈 assistant만
  제외하고 완성된 content 배열을 그대로 push하는 지점은 `:421-422`다.

### MODIFY — `tests/xai-transport.test.ts`

Replace the current manually assembled test at `tests/xai-transport.test.ts:239-263`. It bypasses
the parser boundary and therefore stays green while parser output is split.

Before:

```ts
  test("assistant thinking parts round-trip as reasoning_content on grok-4.5 history", () => {
    // xAI docs: dropped reasoning_content is the top cause of multi-turn cache misses
    // (docs.x.ai prompt-caching/multi-turn, 2026-07-13).
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const assistant: OcxAssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "cached chain" },
        { type: "text", text: "answer" },
      ],
      timestamp: 0,
    };
    const req: OcxParsedRequest = {
      modelId: "grok-4.5",
      context: { messages: [{ role: "user", content: "q1", timestamp: 0 }, assistant, { role: "user", content: "q2", timestamp: 0 }] },
      stream: false,
      options: {},
    };
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const replayed = body.messages.find(m => m.role === "assistant");
    expect(replayed?.reasoning_content).toBe("cached chain");
  });
```

After:

```ts
  test("parseRequest folds summary reasoning into one Grok assistant wire message", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "cached chain" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: "answer", reasoning_content: "cached chain" });
  });

  test("parseRequest drops opaque encrypted-only reasoning without detaching an assistant wire message", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r-opaque", summary: [], encrypted_content: "opaque-native-blob" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual({ role: "assistant", content: "answer" });
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest clears pending reasoning at a user boundary", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "reasoning", id: "r-orphan", summary: [{ type: "summary_text", text: "must drop" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "new turn" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toEqual([{ role: "assistant", content: "answer" }]);
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
  });

  test("parseRequest preserves pending reasoning across a function call", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "reasoning", id: "r-call", summary: [{ type: "summary_text", text: "call chain" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");

    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
    });
    expect(assistants[1]).toMatchObject({ content: "answer", reasoning_content: "call chain" });
  });

  test("parseRequest newline-joins reasoning siblings before one assistant", () => {
    const prov: OcxProviderConfig = {
      ...provider("oauth"),
      preserveReasoningContentModels: getProviderRegistryEntry("xai")?.preserveReasoningContentModels ?? [],
    };
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "first" }] },
        { type: "reasoning", id: "r2", summary: [{ type: "summary_text", text: "second" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    const body = JSON.parse(createOpenAIChatAdapter(prov).buildRequest(req).body as string) as { messages: Array<Record<string, unknown>> };
    const assistants = body.messages.filter(message => message.role === "assistant");
    const parsedAssistant = req.context.messages.find(message => message.role === "assistant") as OcxAssistantMessage;
    const thinkingParts = parsedAssistant.content.filter(part => part.type === "thinking");

    expect(thinkingParts).toHaveLength(1);
    expect(thinkingParts[0]).toMatchObject({ thinking: "first\nsecond", itemId: "r2" });
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ content: "answer", reasoning_content: "first\nsecond" });
  });

  test("parseRequest drops trailing reasoning without creating an assistant", () => {
    const req = parseRequest({
      model: "xai/grok-4.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "reasoning", id: "r-trailing", summary: [{ type: "summary_text", text: "unfinished" }] },
      ],
    });

    expect(req.context.messages.filter(message => message.role === "assistant")).toHaveLength(0);
    expect(req.context.messages).toHaveLength(1);
  });
```

After replacement, remove now-unused type imports only if TypeScript reports them:
`OcxParsedRequest`. Keep `OcxAssistantMessage` for the one-part parser assertion and keep
`OcxProviderConfig`.

### MODIFY — `tests/anthropic-thinking-signature.test.ts`

Add this activation inside `describe("parser ocxr1 decode + anthropic replay", ...)`. It goes
through `parseRequest`, confirms two parser parts, then checks the actual Anthropic request blocks;
it fails if sibling plaintext is joined while only the final signature survives.

같은 describe의 기존 parser decode/replay fixture도 stale-check한다. Fold 구현 후에는
`reasoning` 바로 뒤 `user`가 boundary clear이므로, signed thinking을 검사하는 fixture는
`reasoning`과 다음 `user` 사이에 explicit assistant message를 두어 실제 Responses ordering을
활성화해야 한다. Assertions의 signature/redacted/text 의미는 유지한다.

```ts
  test("two signed reasoning siblings replay with each signature attached to its own text", async () => {
    const adapter = createAnthropicAdapter(provider);
    const firstEnvelope = encodeReasoningEnvelope({
      sig: "FirstRealSignature123456==",
      txt: "first signed chain",
    });
    const secondEnvelope = encodeReasoningEnvelope({
      sig: "SecondRealSignature123456==",
      txt: "second signed chain",
    });
    const parsed = parseRequest({
      model: "anthropic/claude-x",
      input: [
        { type: "reasoning", id: "rs_first", summary: [], encrypted_content: firstEnvelope },
        { type: "reasoning", id: "rs_second", summary: [], encrypted_content: secondEnvelope },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    const parsedAssistant = parsed.context.messages.find(message => message.role === "assistant") as {
      content: OcxThinkingContent[];
    };
    const parsedThinking = parsedAssistant.content.filter(part => part.type === "thinking");

    expect(parsedThinking).toHaveLength(2);
    expect(parsedThinking.map(part => ({
      thinking: part.thinking,
      signature: part.signature,
    }))).toEqual([
      { thinking: "first signed chain", signature: "FirstRealSignature123456==" },
      { thinking: "second signed chain", signature: "SecondRealSignature123456==" },
    ]);

    const request = await adapter.buildRequest(parsed) as { body: string };
    const body = JSON.parse(request.body) as {
      messages: Array<{
        role: string;
        content: Array<{ type: string; thinking?: string; signature?: string; text?: string }>;
      }>;
    };
    const replayedAssistant = body.messages.find(message => message.role === "assistant");
    const replayedThinking = replayedAssistant?.content.filter(block => block.type === "thinking");

    expect(replayedThinking).toEqual([
      { type: "thinking", thinking: "first signed chain", signature: "FirstRealSignature123456==" },
      { type: "thinking", thinking: "second signed chain", signature: "SecondRealSignature123456==" },
    ]);
  });
```

## Acceptance criteria and activation scenarios

1. **Summary fold** — activate with input ordering
   `[user, reasoning(summary="cached chain"), assistant("answer"), user]` through
   `parseRequest`; Grok wire has exactly one assistant, with
   `{content:"answer", reasoning_content:"cached chain"}`.
2. **Opaque encrypted-only drop** — activate with
   `[user, reasoning(summary=[], encrypted_content="opaque-native-blob"), assistant("answer"), user]`;
   Grok wire has exactly one assistant with answer content and no `reasoning_content`.
3. **User boundary clear** — `[reasoning, user, assistant]` drops the orphaned reasoning and the
   later assistant has no `reasoning_content`.
4. **Call preservation** — `[reasoning, function_call, assistant]` keeps the existing assistant
   tool-call placeholder and folds reasoning only into the following explicit assistant.
5. **Sibling join** — `[reasoning("first"), reasoning("second"), assistant]` emits
   exactly one parser thinking part and `reasoning_content: "first\nsecond"`.
6. **Trailing drop** — `[user, reasoning]` creates no assistant placeholder and leaves only user history.
7. **Signed sibling integrity** — two `ocxr1` siblings with distinct `sig`/`txt` values before
   one assistant remain two parser thinking parts, and Anthropic emits two thinking blocks in the
   same order with each signature attached to its original text.
8. **No detached parser message** — fold/drop activations assert the expected assistant count;
   `req.context.messages.filter(m => m.role === "assistant")` may additionally be asserted as
   length 1; the required wire assertion remains authoritative.
9. **Preservation boundary** — decodable plaintext/`ocxr1` thinking metadata remains on the
   following `OcxAssistantMessage`; only `envelope?.sig` marks a signed part. Synthetic JSON
   signatures remain unsigned for joining; undecodable encrypted bytes and invented plaintext are dropped.
10. **No adapter regression** — registry preset and Anthropic signature suites remain green; no
    change is made to `src/adapters/openai-chat.ts` or `src/adapters/anthropic.ts`.

Exact new test names:

- `parseRequest folds summary reasoning into one Grok assistant wire message`
- `parseRequest drops opaque encrypted-only reasoning without detaching an assistant wire message`
- `parseRequest clears pending reasoning at a user boundary`
- `parseRequest preserves pending reasoning across a function call`
- `parseRequest newline-joins reasoning siblings before one assistant`
- `parseRequest drops trailing reasoning without creating an assistant`

Anthropic activation test name:

- `two signed reasoning siblings replay with each signature attached to its own text`

## Verification commands

Run from `/Users/jun/Developer/new/700_projects/opencodex`:

```bash
bun test tests/xai-transport.test.ts tests/anthropic-thinking-signature.test.ts
bun run typecheck
```

Optional affected-suite confidence gate after the focused commands:

```bash
bun test tests/responses-parser.test.ts tests/xai-transport.test.ts tests/anthropic-adapter.test.ts tests/anthropic-thinking-signature.test.ts
```

If an optional path does not exist at implementation time, use `rg --files tests` to select the
actual parser/Anthropic replay suites; do not create a placeholder suite merely to satisfy this doc.

## Risk and rollback

Primary risk is assistant-history grouping: reasoning currently uses
`ensureAssistantPlaceholder`, so function/custom/local-shell/tool-search calls may rely on that
placeholder to share a turn. Parser tests involving reasoning adjacent to tool calls, signed
Anthropic thinking replay, trailing reasoning, or user/tool boundaries could fail. The most likely
affected suites are parser tests, Anthropic extended-thinking/signature tests, and
`tests/xai-transport.test.ts`; run the optional gate above after locating their current names.

Secondary risk is semantic loss: native encrypted-only reasoning is intentionally unavailable to
routed chat models. This phase drops that opaque reasoning item while preserving the following
assistant answer. It must never serialize the blob as `reasoning_content`, expose it as text, or
manufacture a detached empty assistant.

Rollback is a three-file revert of this work-phase: restore immediate
`ensureAssistantPlaceholder(...).content.push(thinking)`, restore the prior manual Grok wire test,
and restore the pre-fold Anthropic parser fixtures.
Rollback restores previous compatibility but also restores the Grok exact-prefix cache break, so
record that regression explicitly in the revert/commit message.

## Stale-check checklist for implementing P

- Re-read the full `parser.ts` input loop and confirm every assistant, user/developer/system,
  agent-message, call, tool-output, reasoning, and end-of-input path still matches the boundary table.
- Confirm all call-like branches still use `ensureAssistantPlaceholder`; preserve pending across calls,
  and clear it before every user/tool-result/agent/system boundary push or append.
- Confirm sibling reasoning still joins with exactly one newline and trailing pending state is never flushed.
- Confirm only `envelope?.sig` sets `envelopeSigned`; synthetic `JSON.stringify(reasoning)` signatures
  remain unsigned, adjacent unsigned siblings become one part, and signed siblings remain separate parts.
- Confirm `openai-chat.ts:104-115` still concatenates multiple thinking parts in original order and
  forwards the non-empty result only for `preserveReasoningContentModels`.
- Confirm `anthropic.ts:396-422` still iterates multiple thinking parts in order and emits every
  real signature on the same block as that part's own thinking text.
- Confirm `decodeReasoningEnvelope` still returns `null` for non-`ocxr1` blobs.
- Validate all seven proposed request fixtures against the current Responses schema before editing.
- Re-check current test filenames/imports and `package.json` `test`/`typecheck` scripts.

## Implementation record (B, 2026-07-16)

구현은 본 문서대로 착지했고, 모호했던 "call 항목을 가로지르는 보존"은 다음처럼 확정했다:
pending reasoning은 tool/function/shell/web/tool_search call이 assistant placeholder를 만들 때
그 **동일 assistant turn에 폴딩**된다(`assistantHolderWithReasoning` helper). 근거: Grok
chat-completions wire는 reasoning_content와 tool_calls를 같은 assistant 메시지로 내보내며,
Anthropic replay는 thinking이 같은 turn의 tool_use 앞에 와야 한다. 이에 따라 초안 테스트
기대값(다음 text assistant로 skip)과 구계약 픽스처
`tests/responses-parser-agent-message.test.ts`(경계 앞 reasoning의 detached assistant 유지)를
신계약으로 갱신했다. 검증: 대상 3개 스위트 33 pass, 풀 스위트 2596 pass / 0 fail,
`bun run typecheck` 통과.
