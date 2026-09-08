import { describe, expect, jest, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { parseRequest } from "../../src/responses/parser";
import {
  COMPACT_PROMPT,
  OPAQUE_COMPACTION_NOTE,
  SUMMARY_PREFIX,
  buildCompactV1Output,
  decodeCompactionSummary,
  encodeCompactionSummary,
  extractCompactUserMessages,
} from "../../src/responses/compaction";
import type { AdapterEvent } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { bufferCompactResponse, COMPACT_RESPONSE_MAX_BYTES } from "../../src/server/responses/compact";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

// These non-concurrent tests scope Bun's fake timers like responses/ws-upstream.test.ts.
// The real bounded-body reader and idleDeadline run; upstream pull acknowledgements
// synchronize chunk consumption before advancing time, without sleeps or mocking either helper.
async function withCompactBodyClock(run: () => Promise<void>): Promise<void> {
  jest.useFakeTimers();
  try {
    await run();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
}

function compactBodySource(onCancel?: () => void) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let nextRead = Promise.withResolvers<void>();
  const cancellationReasons: unknown[] = [];
  let ended = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { nextRead.resolve(); },
    cancel(reason) {
      ended = true;
      cancellationReasons.push(reason);
      onCancel?.();
      // A deadline must return even if the upstream's cancellation cleanup never finishes.
      return new Promise<void>(() => {});
    },
  }, { highWaterMark: 0 });
  return {
    body, cancellationReasons,
    waitingForRead: () => nextRead.promise,
    async send(bytes: Uint8Array) {
      await nextRead.promise;
      nextRead = Promise.withResolvers<void>();
      controller.enqueue(bytes);
      await nextRead.promise;
    },
    close() { if (!ended) { ended = true; controller.close(); } },
  };
}

describe("native compact response body deadline", () => {
  test("headers followed by silence expire at the default 300 seconds without waiting for cancel", () => withCompactBodyClock(async () => {
    const source = compactBodySource();
    const pending = bufferCompactResponse(new Response(source.body), new AbortController().signal);
    try {
      await source.waitingForRead();
      jest.advanceTimersByTime(299_999);
      expect(jest.getTimerCount()).toBe(1);
      expect(source.cancellationReasons).toHaveLength(0);
      jest.advanceTimersByTime(1);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: { type: "upstream_stall_timeout", code: "upstream_stall_timeout" } });
      expect(source.cancellationReasons).toHaveLength(1);
      expect(source.cancellationReasons[0]).toBeInstanceOf(DOMException);
      expect((source.cancellationReasons[0] as DOMException).name).toBe("TimeoutError");
      expect(source.body.locked).toBe(false);
    } finally { source.close(); await pending; }
  }));

  test("nonempty chunks rearm the deadline and success preserves exact bytes and header hints", () => withCompactBodyClock(async () => {
    const source = compactBodySource();
    const expected = new Uint8Array([0, 255, 128, 195, 40]);
    const pending = bufferCompactResponse(new Response(source.body, {
      status: 201, statusText: "Compact ready",
      headers: {
        "content-type": "application/octet-stream", "content-length": "999",
        "retry-after": "42", "x-codex-primary-reset-at": "1900000000",
        "x-codex-secondary-reset-at": "1900000001", "x-codex-tertiary-reset-at": "1900000002",
        location: "/compact-result", "set-cookie": "ignored=1", "transfer-encoding": "chunked",
      },
    }), new AbortController().signal, 2);
    try {
      await source.waitingForRead();
      for (let i = 0; i < expected.length; i++) {
        jest.advanceTimersByTime(1_500);
        await source.send(expected.subarray(i, i + 1));
      }
      source.close();
      const response = await pending;
      expect(response.status).toBe(201);
      expect(response.statusText).toBe("Compact ready");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
      expect(Object.fromEntries(response.headers)).toEqual({
        "content-type": "application/octet-stream", "retry-after": "42",
        "x-codex-primary-reset-at": "1900000000", "x-codex-secondary-reset-at": "1900000001",
        "x-codex-tertiary-reset-at": "1900000002", location: "/compact-result",
      });
      expect(source.cancellationReasons).toHaveLength(0);
      expect(source.body.locked).toBe(false);
    } finally { source.close(); await pending; }
  }));

  test("empty chunks do not rearm the byte inactivity deadline", () => withCompactBodyClock(async () => {
    const source = compactBodySource();
    const pending = bufferCompactResponse(new Response(source.body), new AbortController().signal, 2);
    try {
      await source.waitingForRead();
      jest.advanceTimersByTime(1_000);
      await source.send(new Uint8Array(0));
      jest.advanceTimersByTime(999);
      expect(source.cancellationReasons).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect((await pending).status).toBe(504);
      expect(source.cancellationReasons).toHaveLength(1);
      expect(source.body.locked).toBe(false);
    } finally { source.close(); await pending; }
  }));

  for (const idleAlsoFires of [false, true]) {
    test(`client cancellation unblocks a pending read and wins over idle expiry (${idleAlsoFires})`, () => withCompactBodyClock(async () => {
      const client = new AbortController();
      // Abort during the timeout's source-cleanup callback, before the wrapper
      // classifies its result. Advancing fake time can already flush promises.
      const source = compactBodySource(idleAlsoFires ? () => client.abort(new Error("client stopped")) : undefined);
      const pending = bufferCompactResponse(new Response(source.body), client.signal, 2);
      try {
        await source.waitingForRead();
        if (idleAlsoFires) jest.advanceTimersByTime(2_000);
        else client.abort(new Error("client stopped"));
        const response = await pending;
        expect(client.signal.aborted).toBe(true);
        expect(response.status).toBe(499);
        expect(await response.json()).toMatchObject({ error: { code: "client_cancelled" } });
        expect(source.cancellationReasons).toHaveLength(1);
        expect(source.body.locked).toBe(false);
      } finally { source.close(); await pending; }
    }));
  }

  test("cancellation after a completed timeout does not retroactively replace its 504", () => withCompactBodyClock(async () => {
    const source = compactBodySource();
    const client = new AbortController();
    const pending = bufferCompactResponse(new Response(source.body), client.signal, 2);
    try {
      await source.waitingForRead();
      jest.advanceTimersByTime(2_000);
      const response = await pending;
      expect(response.status).toBe(504);
      client.abort(new Error("late cancellation"));
      expect(response.status).toBe(504);
      expect(source.cancellationReasons).toHaveLength(1);
    } finally { source.close(); await pending; }
  }));

  test("declared and observed oversize bodies retain the 32 MiB limit without waiting for cancel", () => withCompactBodyClock(async () => {
    for (const declared of [true, false]) {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(COMPACT_RESPONSE_MAX_BYTES + 1)); },
        cancel() { cancelled++; return new Promise<void>(() => {}); },
      }, { highWaterMark: 0 });
      const response = await bufferCompactResponse(new Response(body, {
        headers: declared ? { "content-length": String(COMPACT_RESPONSE_MAX_BYTES + 1) } : {},
      }), new AbortController().signal, 2);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: "compact_response_too_large" } });
      expect(cancelled).toBe(1);
      expect(body.locked).toBe(false);
    }
    const atLimit = new Uint8Array(COMPACT_RESPONSE_MAX_BYTES);
    atLimit[atLimit.length - 1] = 255;
    const response = await bufferCompactResponse(new Response(atLimit), new AbortController().signal, 2);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(COMPACT_RESPONSE_MAX_BYTES);
    expect(bytes[0]).toBe(0);
    expect(bytes[bytes.length - 1]).toBe(255);
  }));
});

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

describe("native Responses compaction passthrough", () => {
  const provider = {
    adapter: "openai-responses",
    baseUrl: "https://responses.example/v1",
    authMode: "key" as const,
    apiKey: "test-key",
  };

  test("buffered ciphertext-only completion yields done without a text delta", async () => {
    const adapter = createResponsesPassthroughAdapterProduction(provider);
    const encryptedContent = "gAAAAABm-native-buffered-ciphertext";
    const budget = createTranslatorBudget();
    try {
      const events = await adapter.parseResponse!(Response.json({
        status: "completed",
        output: [{ type: "compaction", encrypted_content: encryptedContent }],
      }), budget);

      expect(events).toEqual([{ type: "done", compactionEncryptedContent: encryptedContent }]);
    } finally {
      budget.dispose();
    }
  });

  test("streaming ciphertext is charged before the compaction item takes ownership", async () => {
    const adapter = createResponsesPassthroughAdapterProduction(provider);
    const encryptedContent = "gAAAAABm-native-streaming-ciphertext";
    const budget = createTranslatorBudget();
    try {
      const events: AdapterEvent[] = [];
      const stream = [
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "compaction", encrypted_content: encryptedContent }],
          },
        })}`,
        "",
        "",
      ].join("\n");
      for await (const event of adapter.parseStream(new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }), budget)) events.push(event);

      expect(events).toEqual([{ type: "done", compactionEncryptedContent: encryptedContent }]);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(encryptedContent));

      const json = buildResponseJSON(events, "test/model", {
        compaction: true,
        translatorBudget: budget,
      }) as { output: Array<{ type: string; encrypted_content?: string }> };
      expect(json.output).toEqual([expect.objectContaining({
        type: "compaction",
        encrypted_content: encryptedContent,
      })]);
      expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(JSON.stringify(json.output[0])));
    } finally {
      budget.dispose();
    }
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
