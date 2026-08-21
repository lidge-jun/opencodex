import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { CODEX_FORWARD_BASE_URL } from "../src/providers/openai-tiers";
import { parseRequest } from "../src/responses/parser";
import {
  COMPACT_PROMPT,
  OPAQUE_COMPACTION_NOTE,
  SUMMARY_PREFIX,
  buildCompactV1Output,
  decodeCompactionSummary,
  encodeCompactionSummary,
  extractCompactUserMessages,
} from "../src/responses/compaction";
import type { AdapterEvent } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectFrames(stream: ReadableStream<Uint8Array>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(f => f.trim())
    .filter(f => f.length > 0 && f !== "data: [DONE]")
    .map(f => {
      const event = f.split("\n").find(l => l.startsWith("event: "))?.slice(7) ?? "";
      const dataLine = f.split("\n").find(l => l.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
    });
}

describe("compaction envelope", () => {
  test("round-trips a summary", () => {
    const enc = encodeCompactionSummary("progress: fixed the bug\nnext: run tests");
    expect(enc.startsWith("ocx1:")).toBe(true);
    expect(decodeCompactionSummary(enc)).toBe("progress: fixed the bug\nnext: run tests");
  });
  test("rejects real (OpenAI-encrypted) blobs", () => {
    expect(decodeCompactionSummary("gAAAAABm-openai-encrypted")).toBeNull();
  });
});

describe("parser compaction handling", () => {
  test("compaction_trigger sets _compactionRequest and is dropped from messages", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-sonnet-4-6",
      input: [
        { type: "message", role: "user", content: "long conversation" },
        { type: "compaction_trigger" },
      ],
    });
    expect(parsed._compactionRequest).toBe(true);
    expect(parsed.context.messages).toHaveLength(1);
  });

  test("absent trigger leaves the flag unset", () => {
    const parsed = parseRequest({ model: "m", input: [{ type: "message", role: "user", content: "hi" }] });
    expect(parsed._compactionRequest).toBeUndefined();
  });

  test("ocx1 compaction input item decodes into a summary user message", () => {
    const parsed = parseRequest({
      model: "anthropic/claude-sonnet-4-6",
      input: [
        { type: "compaction", encrypted_content: encodeCompactionSummary("did X, next Y") },
        { type: "message", role: "user", content: "continue" },
      ],
    });
    expect(parsed.context.messages).toHaveLength(2);
    const first = parsed.context.messages[0];
    expect(first.role).toBe("user");
    expect(first.content).toBe(`${SUMMARY_PREFIX}\n\ndid X, next Y`);
  });

  test("real encrypted compaction item degrades to the opaque note", () => {
    const parsed = parseRequest({
      model: "m",
      input: [{ type: "compaction", encrypted_content: "real-encrypted-blob" }],
    });
    expect(parsed.context.messages[0].content).toBe(OPAQUE_COMPACTION_NOTE);
  });

  test("compaction_summary alias is handled too", () => {
    const parsed = parseRequest({
      model: "m",
      input: [{ type: "compaction_summary", encrypted_content: encodeCompactionSummary("alias path") }],
    });
    expect(parsed.context.messages[0].content).toContain("alias path");
  });
});

describe("bridge compaction mode (streaming)", () => {
  test("emits exactly one compaction output item and no assistant message", async () => {
    const frames = await collectFrames(bridgeToResponsesSSE(replay([
      { type: "thinking_delta", thinking: "let me summarize" },
      { type: "text_delta", text: "summary part 1. " },
      { type: "text_delta", text: "summary part 2." },
      { type: "done" },
    ]), "anthropic/claude-sonnet-4-6", undefined, undefined, undefined, undefined, 2_000, { compaction: true }));

    const doneItems = frames.filter(f => f.event === "response.output_item.done")
      .map(f => (f.data as { item: { type: string; encrypted_content?: string } }).item);
    expect(doneItems).toHaveLength(1);
    expect(doneItems[0].type).toBe("compaction");
    expect(decodeCompactionSummary(doneItems[0].encrypted_content ?? "")).toBe("summary part 1. summary part 2.");

    const completed = frames.find(f => f.event === "response.completed");
    expect(completed).toBeDefined();
    const output = (completed!.data as { response: { output: Array<{ type: string }> } }).response.output;
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe("compaction");
  });

  test("error path emits response.failed without a compaction item", async () => {
    const frames = await collectFrames(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "upstream broke" },
    ]), "m", undefined, undefined, undefined, undefined, 2_000, { compaction: true }));

    expect(frames.some(f => f.event === "response.failed")).toBe(true);
    expect(frames.some(f => f.event === "response.output_item.done")).toBe(false);
  });

  test("without the flag nothing changes", async () => {
    const frames = await collectFrames(bridgeToResponsesSSE(replay([
      { type: "text_delta", text: "normal answer" },
      { type: "done" },
    ]), "m"));
    const doneItems = frames.filter(f => f.event === "response.output_item.done")
      .map(f => (f.data as { item: { type: string } }).item);
    expect(doneItems).toHaveLength(1);
    expect(doneItems[0].type).toBe("message");
  });
});

describe("buildResponseJSON compaction mode", () => {
  test("output carries only the compaction item", () => {
    const json = buildResponseJSON([
      { type: "text_delta", text: "the summary" },
      { type: "done" },
    ], "m", { compaction: true }) as { output: Array<{ type: string; encrypted_content?: string }> };
    expect(json.output).toHaveLength(1);
    expect(json.output[0].type).toBe("compaction");
    expect(decodeCompactionSummary(json.output[0].encrypted_content ?? "")).toBe("the summary");
  });

  test("failed turn produces no compaction item", () => {
    const json = buildResponseJSON([
      { type: "error", message: "boom" },
    ], "m", { compaction: true }) as { output: unknown[]; status: string };
    expect(json.status).toBe("failed");
    expect(json.output).toHaveLength(0);
  });
});

describe("COMPACT_PROMPT", () => {
  test("mirrors the codex-rs checkpoint instruction", () => {
    expect(COMPACT_PROMPT).toContain("CONTEXT CHECKPOINT COMPACTION");
    expect(COMPACT_PROMPT).toContain("What remains to be done");
  });
});

describe("forward-path ocx1 compaction scrub", () => {
  const provider = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.example/backend-api/codex",
    authMode: "forward" as const,
  };

  function forwardedBody(
    rawBody: Record<string, unknown>,
    target = provider,
    threadServingIdentityChanged = false,
  ): { input: Array<Record<string, unknown>> } {
    const adapter = createResponsesPassthroughAdapter(target as never);
    const request = adapter.buildRequest({
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: rawBody,
      ...(threadServingIdentityChanged ? { _stripReasoningEncryptedContent: true } : {}),
    }, { headers: new Headers() });
    return JSON.parse(request.body as string) as { input: Array<Record<string, unknown>> };
  }

  test("ocx1 compaction items become plain user messages before ChatGPT forwarding", () => {
    const body = forwardedBody({
      model: "gpt-5.5",
      input: [
        { type: "compaction", encrypted_content: encodeCompactionSummary("routed summary") },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    expect(body.input[0].type).toBe("message");
    const content = body.input[0].content as Array<{ text: string }>;
    expect(content[0].text).toContain("routed summary");
    expect(JSON.stringify(body)).not.toContain("ocx1:");
  });

  test("ocx1 context_compaction items are scrubbed the same way", () => {
    const body = forwardedBody({
      model: "gpt-5.5",
      input: [
        { type: "context_compaction", encrypted_content: encodeCompactionSummary("ctx summary") },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    expect(body.input[0].type).toBe("message");
    const content = body.input[0].content as Array<{ text: string }>;
    expect(content[0].text).toContain("ctx summary");
    expect(JSON.stringify(body)).not.toContain("ocx1:");
  });

  test("real OpenAI-encrypted compaction items are forwarded untouched", () => {
    const body = forwardedBody({
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "gAAAAA-real-openai-blob" }],
    }, { ...provider, baseUrl: CODEX_FORWARD_BASE_URL });
    expect(body.input[0].type).toBe("compaction");
    expect(body.input[0].encrypted_content).toBe("gAAAAA-real-openai-blob");
  });

  test("known serving-identity changes degrade native blobs before OpenAI forwarding", () => {
    const before = { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] };
    const after = { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] };
    const body = forwardedBody({
      model: "gpt-5.5",
      input: [
        before,
        { type: "compaction", encrypted_content: "xai-native-compaction-blob" },
        after,
      ],
    }, { ...provider, baseUrl: CODEX_FORWARD_BASE_URL }, true);

    expect(body.input).toEqual([
      before,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
      },
      after,
    ]);
  });

  test("noncanonical forward providers degrade OpenAI-encrypted compaction items", () => {
    const body = forwardedBody({
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "gAAAAA-real-openai-blob" }],
    }, provider);
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: OPAQUE_COMPACTION_NOTE }],
    });
  });
});

describe("remote compaction v1 helpers (260707 Design-B sweep)", () => {
  test("extractCompactUserMessages keeps real user text and drops other items", () => {
    const messages = extractCompactUserMessages([
      { type: "message", role: "user", content: [{ type: "input_text", text: "first ask" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev ctx" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "message", role: "user", content: "plain second ask" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "   " }] },
    ]);
    expect(messages).toEqual(["first ask", "plain second ask"]);
  });

  test("buildCompactV1Output appends SUMMARY_PREFIX summary after retained user messages", () => {
    const output = buildCompactV1Output(["ask one", "ask two"], "the summary");
    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({ type: "message", role: "user", content: [{ type: "input_text", text: "ask one" }] });
    expect(output[1]).toMatchObject({ type: "message", role: "user", content: [{ type: "input_text", text: "ask two" }] });
    const last = output[2] as { content: { text: string }[] };
    expect(last.content[0].text.startsWith(`${SUMMARY_PREFIX}\n`)).toBe(true);
    expect(last.content[0].text).toContain("the summary");
  });

  test("buildCompactV1Output degrades to '(no summary available)' on empty summary", () => {
    const output = buildCompactV1Output([], "");
    expect(output).toHaveLength(1);
    const only = output[0] as { content: { text: string }[] };
    expect(only.content[0].text).toBe("(no summary available)");
  });

  test("buildCompactV1Output enforces the retained-message budget from the newest backwards", () => {
    const old = "o".repeat(90_000);
    const recent = "r".repeat(10_000);
    const output = buildCompactV1Output([old, recent], "s");
    // recent kept whole; old truncated to tail within the 80k-char budget; summary last.
    expect(output).toHaveLength(3);
    const first = output[0] as { content: { text: string }[] };
    const second = output[1] as { content: { text: string }[] };
    expect(second.content[0].text).toBe(recent);
    expect(first.content[0].text.length).toBe(80_000 - recent.length);
  });

  test("the retained tail never begins on a lone low surrogate", () => {
    // The reviewer's repro: an 80,001-code-unit message BEGINNING with an
    // astral character, so the 80k budget cut lands exactly inside the pair.
    const withAstral = "🎆" + "가".repeat(79_999);
    expect(withAstral.length).toBe(80_001);
    const output = buildCompactV1Output([withAstral], "summary");
    const retained = (output[output.length - 2] as { content: { text: string }[] }).content[0].text;
    const first = retained.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(retained.includes("\uFFFD")).toBe(false);
  });
});
