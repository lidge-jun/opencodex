import { describe, expect, test } from "bun:test";
import {
  buildConversationInput,
  buildInputLines,
  buildSystemPrompt,
  mapStreamMessageToEvents,
  readJsonLines,
  usageFromResult,
} from "../src/adapters/coding-agent/protocol";
import type { OcxParsedRequest } from "../src/types";

// The stream-json protocol for coding-agent CLIs
// (src/adapters/coding-agent/protocol.ts); these fixtures exercise it via CodeBuddy frames.

const enc = new TextEncoder();

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

async function collect(gen: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

function parsedRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "glm-5.3",
    stream: true,
    options: {},
    context: { messages: [] },
    ...overrides,
  } as OcxParsedRequest;
}

describe("codebuddy stream-json line reader", () => {
  test("parses multiple frames delivered in a single chunk", async () => {
    const line = enc.encode('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    const out = await collect(readJsonLines(chunks(line)));
    expect(out.map(m => m.type)).toEqual(["a", "b", "c"]);
  });

  test("applies the line limit to each frame instead of the combined chunk", async () => {
    const line = enc.encode('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    const out = await collect(readJsonLines(chunks(line), { maxLineBytes: 12 }));
    expect(out.map(m => m.type)).toEqual(["a", "b", "c"]);
  });

  test("reassembles a JSON frame fragmented across chunk boundaries", async () => {
    const full = enc.encode('{"type":"result","subtype":"success"}\n');
    const out = await collect(readJsonLines(chunks(full.slice(0, 12), full.slice(12, 25), full.slice(25))));
    expect(out).toEqual([{ type: "result", subtype: "success" }]);
  });

  test("reassembles a multi-byte UTF-8 character split across chunks", async () => {
    const full = enc.encode('{"type":"stream_event","text":"世界"}\n');
    // "世" is a 3-byte sequence; split inside it so the decoder must buffer the partial char.
    const marker = enc.encode('"text":"').length;
    const splitAt = full.indexOf(enc.encode("世")[0]!, marker) + 1;
    const out = await collect(readJsonLines(chunks(full.slice(0, splitAt), full.slice(splitAt))));
    expect(out[0]?.text).toBe("世界");
  });

  test("handles CRLF line endings transparently", async () => {
    const line = enc.encode('{"type":"a"}\r\n{"type":"b"}\r\n');
    const out = await collect(readJsonLines(chunks(line)));
    expect(out.map(m => m.type)).toEqual(["a", "b"]);
  });

  test("emits a final frame that has no trailing newline (upstream EOF)", async () => {
    const out = await collect(readJsonLines(chunks(enc.encode('{"type":"result"}'))));
    expect(out).toEqual([{ type: "result" }]);
  });

  test("fails closed on malformed stream-json line with CodingAgentProtocolError", async () => {
    const line = enc.encode('{"type":"ok"}\nnot-json\n');
    const gen = readJsonLines(chunks(line));
    await expect(collect(gen)).rejects.toThrow("Malformed stream-json frame received from coding-agent CLI");
  });

  test("fails closed on non-object JSON frame (array or primitive)", async () => {
    const line = enc.encode('[1,2]\n');
    const gen = readJsonLines(chunks(line));
    await expect(collect(gen)).rejects.toThrow("Non-object stream-json frame received from coding-agent CLI");
  });

  test("ignores blank and whitespace padding lines between valid frames", async () => {
    const line = enc.encode('   \n\n{"type":"ok"}\n  \n');
    const out = await collect(readJsonLines(chunks(line)));
    expect(out).toEqual([{ type: "ok" }]);
  });

  test("enforces the total byte ceiling", async () => {
    const gen = readJsonLines(chunks(enc.encode("x".repeat(100))), { maxTotalBytes: 10 });
    await expect(collect(gen)).rejects.toThrow(/total byte ceiling/);
  });
});

describe("codebuddy stream-json event mapping", () => {
  test("classifies coding-agent auth, rate-limit, and unavailable-model results", () => {
    const frame = (detail: string) => mapStreamMessageToEvents(
      { type: "result", subtype: "error_during_execution", is_error: true, errors: [detail] },
      { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false },
    )[0];
    expect(frame("Not logged in; invalid token")).toMatchObject({ status: 401, code: "invalid_api_key", retryable: false });
    expect(frame("Too many requests: rate limit reached")).toMatchObject({ status: 429, code: "rate_limit_exceeded", retryable: true });
    expect(frame("Model is unavailable")).toMatchObject({ status: 400, code: "model_not_found", retryable: false });
  });

  test("maps partial text and thinking deltas and decouples their state", () => {
    const state = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false };
    const text = mapStreamMessageToEvents(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } },
      state,
    );
    expect(text).toEqual([{ type: "text_delta", text: "Hi" }]);
    expect(state.sawPartialText).toBe(true);
    expect(state.sawPartialThinking).toBe(false);

    const thinking = mapStreamMessageToEvents(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "let me see" } } },
      state,
    );
    expect(thinking).toEqual([{ type: "thinking_delta", thinking: "let me see" }]);
    expect(state.sawPartialThinking).toBe(true);
  });

  test("assistant fallback matrix: independently decouples partial text and partial thinking", () => {
    // Case 1: Partial text seen, partial thinking NOT seen -> assistant emits thinking only, no duplicate text
    const state1 = { sawPartialText: true, sawPartialThinking: false, sawTerminalResult: false };
    const events1 = mapStreamMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: "final answer" },
          ],
        },
      },
      state1,
    );
    expect(events1).toEqual([{ type: "thinking_delta", thinking: "reasoning..." }]);

    // Case 2: Partial thinking seen, partial text NOT seen -> assistant emits text only, no duplicate thinking
    const state2 = { sawPartialText: false, sawPartialThinking: true, sawTerminalResult: false };
    const events2 = mapStreamMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: "final answer" },
          ],
        },
      },
      state2,
    );
    expect(events2).toEqual([{ type: "text_delta", text: "final answer" }]);

    // Case 3: Both partials seen -> assistant emits nothing
    const state3 = { sawPartialText: true, sawPartialThinking: true, sawTerminalResult: false };
    const events3 = mapStreamMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: "final answer" },
          ],
        },
      },
      state3,
    );
    expect(events3).toEqual([]);

    // Case 4: Neither partial seen -> assistant emits both thinking and text
    const state4 = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false };
    const events4 = mapStreamMessageToEvents(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning..." },
            { type: "text", text: "final answer" },
          ],
        },
      },
      state4,
    );
    expect(events4).toEqual([
      { type: "thinking_delta", thinking: "reasoning..." },
      { type: "text_delta", text: "final answer" },
    ]);
  });

  test("maps a successful result frame to done with usage and marks sawTerminalResult", () => {
    const state = { sawPartialText: true, sawPartialThinking: false, sawTerminalResult: false };
    const events = mapStreamMessageToEvents(
      { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } },
      state,
    );
    expect(state.sawTerminalResult).toBe(true);
    expect(events).toEqual([{
      type: "done",
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, cacheReadInputTokens: 2 },
    }]);
  });

  test("maps an errored result frame to an upstream error, keeping usage without marking success", () => {
    const state = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false };
    const events = mapStreamMessageToEvents(
      { type: "result", subtype: "error_during_execution", is_error: true, result: "boom", usage: { input_tokens: 3, output_tokens: 0 } },
      state,
    );
    expect(state.sawTerminalResult).toBe(false);
    expect(events[0]).toMatchObject({ type: "error", status: 502, errorType: "upstream_error", message: "boom" });
  });

  test("ignores system/init and background task frames", () => {
    const state = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false };
    expect(mapStreamMessageToEvents({ type: "system", subtype: "init" }, state)).toEqual([]);
    expect(mapStreamMessageToEvents({ type: "system", subtype: "task_started" }, state)).toEqual([]);
  });

  test("parses tool_use blocks defensively even though v1 disables tools", () => {
    const state = { sawPartialText: false, sawPartialThinking: false, sawTerminalResult: false, openToolCallId: undefined as string | undefined };
    const start = mapStreamMessageToEvents(
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "exec" } } },
      state,
    );
    expect(start).toEqual([{ type: "tool_call_start", id: "t1", name: "exec" }]);
    const delta = mapStreamMessageToEvents(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } } },
      state,
    );
    expect(delta).toEqual([{ type: "tool_call_delta", arguments: "{\"a\":1}" }]);
    const stop = mapStreamMessageToEvents({ type: "stream_event", event: { type: "content_block_stop" } }, state);
    expect(stop).toEqual([{ type: "tool_call_end" }]);
    expect(state.openToolCallId).toBeUndefined();
  });

  test("usageFromResult returns undefined when no usage is present", () => {
    expect(usageFromResult({ type: "result" })).toBeUndefined();
  });
});

describe("codebuddy conversation input builder (Strategy C projection)", () => {
  test("folds system + developer prompts and skips developer messages in the input stream", () => {
    const parsed = parsedRequest({
      context: {
        systemPrompt: ["You are Codex."],
        messages: [
          { role: "developer", content: "Policy: be brief.", timestamp: 0 },
          { role: "user", content: "hello", timestamp: 1 },
        ],
      },
    });
    expect(buildSystemPrompt(parsed)).toBe("You are Codex.\n\nPolicy: be brief.");
    const lines = buildConversationInput(parsed).map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } });
  });

  test("projects multi-turn conversation into legal user-message frames with clear context separation", () => {
    const parsed = parsedRequest({
      context: {
        messages: [
          { role: "user", content: "Check the files.", timestamp: 0 },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I will call exec" },
              { type: "toolCall", id: "c1", name: "exec", arguments: { cmd: "ls" } },
            ],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "exec",
            content: "file1.txt\nfile2.txt",
            isError: false,
            timestamp: 2,
          },
          { role: "user", content: "Now read file1.txt", timestamp: 3 },
        ],
      },
    });

    const lines = buildConversationInput(parsed).map(line => JSON.parse(line));
    // Must ONLY emit legal user message frames; zero assistant replay frames!
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("user");
    expect(lines[0].message.role).toBe("user");

    const text = lines[0].message.content[0].text as string;
    expect(text).toContain("Prior conversation context:");
    expect(text).toContain("USER:\nCheck the files.");
    expect(text).toContain("ASSISTANT:\n[Thinking: I will call exec]\n[Tool call: exec (call_id: c1)");
    expect(text).toContain("TOOL RESULT (call_id: c1):\nfile1.txt\nfile2.txt");
    expect(text).toContain("Current user request:\n\nNow read file1.txt");

    // Must NOT contain raw assistant frames
    for (const raw of buildConversationInput(parsed)) {
      expect(raw).not.toContain('"type":"assistant"');
    }
  });

  test("encodes a base64 image part and never silently drops a remote image", () => {
    const dataUrl = buildInputLines({ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,QUJD" }], timestamp: 0 } as never)
      .map(line => JSON.parse(line));
    expect(dataUrl[0].message.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    const remote = buildInputLines({ role: "user", content: [{ type: "image", imageUrl: "https://x.test/a.png" }], timestamp: 0 } as never)
      .map(line => JSON.parse(line));
    expect(remote[0].message.content[0]).toEqual({ type: "image", source: { type: "url", url: "https://x.test/a.png" } });
  });

  test("preserves images attached during multi-turn conversation projection", () => {
    const parsed = parsedRequest({
      context: {
        messages: [
          { role: "user", content: "Here is the layout", timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "Show me the screenshot" }], timestamp: 1 },
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this screenshot" },
              { type: "image", imageUrl: "data:image/png;base64,QUJD" },
            ],
            timestamp: 2,
          },
        ],
      },
    });

    const lines = buildConversationInput(parsed).map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("user");
    const content = lines[0].message.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Current user request:\n\nLook at this screenshot");
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    });
  });
});
