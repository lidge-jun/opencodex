import { describe, expect, test } from "bun:test";
import { closeOpenMarkdownBlocks } from "../../src/responses/markdown-block-repair";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { codexWsExchange } from "../../src/server/responses/codex-ws-exchange";
import type { CodexWsSession } from "../../src/server/responses/codex-ws-session";
import type { PreparedCodexWsRequest } from "../../src/server/responses/codex-ws-request";

describe("closeOpenMarkdownBlocks", () => {
  test("leaves normal and empty text unchanged", () => {
    expect(closeOpenMarkdownBlocks("")).toBe("");
    expect(closeOpenMarkdownBlocks("Hello world!")).toBe("Hello world!");
    expect(closeOpenMarkdownBlocks("```ts\nconst x = 1;\n```\n")).toBe("```ts\nconst x = 1;\n```\n");
  });

  test("closes unclosed code fences", () => {
    const truncated = "Here is some code:\n```typescript\nfunction greet() {\n  return 'hi';";
    const repaired = closeOpenMarkdownBlocks(truncated);
    expect(repaired).toBe("Here is some code:\n```typescript\nfunction greet() {\n  return 'hi';\n```\n");
  });

  test("closes nested or multiple open code fences", () => {
    const truncated = "```markdown\nInside markdown:\n~~~python\nprint(1)";
    const repaired = closeOpenMarkdownBlocks(truncated);
    expect(repaired).toContain("~~~\n");
    expect(repaired).toContain("```\n");
  });

  test("closes unclosed paired tags", () => {
    const truncated = "<details><summary>More info</summary>\nSome body text";
    const repaired = closeOpenMarkdownBlocks(truncated);
    expect(repaired).toBe("<details><summary>More info</summary>\nSome body text\n</details>\n");
  });
});

describe("graceful completion on max_output_tokens: bridgeToResponsesSSE", () => {
  async function streamEvents(events: AdapterEvent[], options: Parameters<typeof bridgeToResponsesSSE>[7]) {
    const budget = createTestTranslatorBudget();
    async function* gen() {
      for (const e of events) yield e;
    }
    const sseStream = bridgeToResponsesSSE(
      gen(),
      "test-model",
      undefined,
      undefined,
      undefined,
      () => {},
      100,
      { ...options, translatorBudget: budget },
    );
    const text = await new Response(sseStream).text();
    const parsed: any[] = [];
    for (const block of text.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            parsed.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
    return parsed;
  }

  test("emits response.completed and repairs markdown fences in normal turn", async () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Here is partial code:\n```python\ndef run():\n  pass" },
      { type: "done", stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 100 } },
    ];
    const sse = await streamEvents(events, {
      completeOnMaxOutputTokens: true,
    });

    const terminal = sse.find(e => e.type === "response.completed");
    expect(terminal).toBeDefined();
    expect(terminal.response.status).toBe("completed");

    // Markdown fence delta emitted
    const textDeltas = sse.filter(e => e.type === "response.output_text.delta").map(e => e.delta);
    const fullText = textDeltas.join("");
    expect(fullText).toContain("```\n");
  });

  test("emits compaction item and commits retention on compaction max_output_tokens", async () => {
    let committed = false;
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Summary up to limit..." },
      { type: "done", stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 100 } },
    ];
    const sse = await streamEvents(events, {
      completeOnMaxOutputTokens: true,
      compaction: true,
      compactionRetention: {
        encode: s => `encoded:${s}`,
        commit: () => { committed = true; },
      },
    });

    const terminal = sse.find(e => e.type === "response.completed");
    expect(terminal).toBeDefined();
    expect(terminal.response.status).toBe("completed");

    const compactionDone = sse.find(e => e.type === "response.output_item.done" && e.item?.type === "compaction");
    expect(compactionDone).toBeDefined();
    expect(committed).toBe(true);
  });

  test("recovers from explicit incomplete event with max_output_tokens", async () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Accumulated response before cut off" },
      { type: "incomplete", reason: "max_output_tokens", usage: { inputTokens: 5, outputTokens: 50 } },
    ];
    const sse = await streamEvents(events, {
      completeOnMaxOutputTokens: true,
    });

    const terminal = sse.find(e => e.type === "response.completed");
    expect(terminal).toBeDefined();
    expect(terminal.response.status).toBe("completed");
    expect(sse.some(e => e.type === "response.incomplete")).toBe(false);
  });

  test("keeps response.incomplete when completeOnMaxOutputTokens is false", async () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Some text" },
      { type: "done", stopReason: "max_tokens" },
    ];
    const sse = await streamEvents(events, {
      completeOnMaxOutputTokens: false,
    });

    const terminal = sse.find(e => e.type === "response.incomplete");
    expect(terminal).toBeDefined();
    expect(terminal.response.incomplete_details?.reason).toBe("max_output_tokens");
    expect(sse.some(e => e.type === "response.completed")).toBe(false);
  });

  test("keeps response.incomplete for content_filter even if completeOnMaxOutputTokens is true", async () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Some text" },
      { type: "done", stopReason: "content_filter" },
    ];
    const sse = await streamEvents(events, {
      completeOnMaxOutputTokens: true,
    });

    const terminal = sse.find(e => e.type === "response.incomplete");
    expect(terminal).toBeDefined();
    expect(terminal.response.incomplete_details?.reason).toBe("content_filter");
  });
});

describe("graceful completion on max_output_tokens: buildResponseJSON", () => {
  test("returns status completed and repairs markdown in buffered response", () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Hello\n```js\nconsole.log(1);" },
      { type: "done", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 20 } },
    ];
    const json = buildResponseJSON(events, "test-model", {
      completeOnMaxOutputTokens: true,
    });

    expect(json.status).toBe("completed");
    expect((json as any).incomplete_details).toBeUndefined();

    const output = json.output as any[];
    const msg = output.find(item => item.type === "message");
    expect(msg).toBeDefined();
    expect(msg.content[0].text).toBe("Hello\n```js\nconsole.log(1);\n```\n");
  });

  test("emits compaction item and commits retention on compaction max_output_tokens in buffered response", () => {
    let committed = false;
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Compacted summary text" },
      { type: "done", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 20 } },
    ];
    const json = buildResponseJSON(events, "test-model", {
      completeOnMaxOutputTokens: true,
      compaction: true,
      compactionRetention: {
        encode: s => `encoded:${s}`,
        commit: () => { committed = true; },
      },
    });

    expect(json.status).toBe("completed");
    expect(committed).toBe(true);
    const output = json.output as any[];
    expect(output.some(item => item.type === "compaction")).toBe(true);
  });

  test("returns status incomplete when completeOnMaxOutputTokens is false", () => {
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Hello" },
      { type: "done", stopReason: "max_tokens" },
    ];
    const json = buildResponseJSON(events, "test-model", {
      completeOnMaxOutputTokens: false,
    });
    expect(json.status).toBe("incomplete");
    expect((json as any).incomplete_details?.reason).toBe("max_output_tokens");
  });
});

describe("graceful completion on max_output_tokens: codexWsExchange", () => {
  test("transforms response.incomplete into response.completed and injects compaction item", async () => {
    let messageHandler: ((event: MessageEvent) => void) | undefined;
    const fakeSocket = {
      send: () => {},
      close: () => {},
      addEventListener: (type: string, handler: any) => {
        if (type === "message") messageHandler = handler;
      },
      removeEventListener: () => {},
    };

    const session: CodexWsSession = {
      socket: fakeSocket as any,
      dispose: () => {},
      metrics: () => ({} as any),
      on: () => {},
      off: () => {},
      bindOwner: () => () => {},
      release: () => {},
    } as any;

    const prepared: PreparedCodexWsRequest = {
      frameText: JSON.stringify({ payload: { compaction_trigger: "auto" } }),
      headers: new Headers(),
    } as any;

    const responsePromise = codexWsExchange({
      session,
      url: "https://api.openai.com/v1/responses",
      init: {},
      prepared,
      completeOnMaxOutputTokens: true,
      sseFallback: async () => new Response("fallback"),
    });

    // Simulate WS emitting response.incomplete due to max_output_tokens
    setTimeout(() => {
      messageHandler?.({
        data: JSON.stringify({
          type: "response.incomplete",
          response: {
            id: "resp_123",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        }),
      } as MessageEvent);
    }, 10);

    const res = await responsePromise;
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("event: response.output_item.done");
    expect(text).toContain('"type":"compaction"');
    expect(text).toContain("event: response.completed");
    expect(text).toContain('"status":"completed"');
    expect(text).not.toContain("event: response.incomplete");
  });
});
