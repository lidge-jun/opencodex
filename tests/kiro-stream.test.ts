import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import {
  KIRO_COMPLETION_RETRY_MESSAGE,
  KIRO_COMPLETION_TOOL_NAME,
} from "../src/adapters/kiro-constants";
import { parseKiroEvent } from "../src/adapters/kiro-events";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { estimateTokens } from "../src/lib/token-estimate";
import type { OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../src/types";

const enc = new TextEncoder();
const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
const origCredsFile = process.env.KIRO_CREDS_FILE;
const origCredentialsFile = process.env.KIRO_CREDENTIALS_FILE;
const origDebugFrames = process.env.OCX_DEBUG_FRAMES;
const realFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-stream-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_CREDS_FILE;
  delete process.env.KIRO_CREDENTIALS_FILE;
  delete process.env.OCX_DEBUG_FRAMES;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  if (origCredsFile === undefined) delete process.env.KIRO_CREDS_FILE; else process.env.KIRO_CREDS_FILE = origCredsFile;
  if (origCredentialsFile === undefined) delete process.env.KIRO_CREDENTIALS_FILE; else process.env.KIRO_CREDENTIALS_FILE = origCredentialsFile;
  if (origDebugFrames === undefined) delete process.env.OCX_DEBUG_FRAMES; else process.env.OCX_DEBUG_FRAMES = origDebugFrames;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };

function parsedWith(messages: unknown[], tools?: unknown[], modelId = "claude-sonnet-4.5"): OcxParsedRequest {
  return { modelId, stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

function inferredEventType(obj: unknown): string {
  const event = obj as Record<string, unknown>;
  if ("content" in event) return "assistantResponseEvent";
  if ("conversationId" in event || "utteranceId" in event) return "messageMetadataEvent";
  if ("tokenUsage" in event || "contextUsagePercentage" in event) return "metadataEvent";
  if ("name" in event || "toolUseId" in event || "input" in event || "stop" in event) return "toolUseEvent";
  return "assistantResponseEvent";
}
const eventFrame = (obj: unknown, eventType = inferredEventType(obj)) =>
  encodeMessage({ ":message-type": "event", ":event-type": eventType }, enc.encode(JSON.stringify(obj)));
function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < frames.length) c.enqueue(frames[i++]);
      else c.close();
    },
  });
}

async function collectAdapterEvents(events: AsyncGenerator<import("../src/types").AdapterEvent>) {
  const out: import("../src/types").AdapterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function completionFrames(answer: string, id = "complete-1"): Uint8Array[] {
  const encoded = JSON.stringify({ answer });
  const split = Math.max(1, Math.floor(encoded.length / 2));
  return [
    eventFrame({ name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    eventFrame({ input: encoded.slice(0, split), name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    eventFrame({ input: encoded.slice(split), name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    eventFrame({ name: KIRO_COMPLETION_TOOL_NAME, stop: true, toolUseId: id }),
  ];
}

async function doneUsage(adapter: ReturnType<typeof createKiroAdapter>, ...frames: Uint8Array[]): Promise<OcxUsage> {
  let done: OcxUsage | undefined;
  for await (const e of adapter.parseStream(new Response(streamOf(...frames)))) {
    if (e.type === "done") done = e.usage;
  }
  expect(done).toBeDefined();
  return done!;
}

describe("kiro adapter — parseStream", () => {
  test("Kiro event parser preserves usage and context usage frames", async () => {
    expect(parseKiroEvent("metadataEvent", enc.encode(JSON.stringify({ contextUsagePercentage: 25.5 })))).toEqual({
      type: "metadata",
      contextUsagePercentage: 25.5,
    });
    expect(parseKiroEvent("messageMetadataEvent", enc.encode(JSON.stringify({ conversationId: "returned-conversation-1" })))).toEqual({
      type: "message_metadata",
      conversationId: "returned-conversation-1",
    });
  });

  test("unknown event types are ignored without parsing their payload", async () => {
    const unknown = encodeMessage(
      { ":message-type": "event", ":event-type": "futureEvent" },
      enc.encode("not-json and must not enter diagnostics"),
    );
    const events = await collectAdapterEvents(createKiroAdapter(provider).parseStream(new Response(streamOf(
      unknown,
      eventFrame({ content: "ok" }),
    ))));
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      expect.objectContaining({ type: "done", endTurn: true }),
    ]);
  });

  test("unsupported Smithy message types and malformed known events fail closed", async () => {
    const unsupported = encodeMessage(
      { ":message-type": "unexpected", ":event-type": "assistantResponseEvent" },
      enc.encode(JSON.stringify({ content: "must not leak" })),
    );
    const malformed = eventFrame({ text: 42 }, "reasoningContentEvent");
    for (const [frame, expected] of [
      [unsupported, "unsupported Smithy message type"],
      [malformed, "invalid Kiro reasoningContentEvent payload"],
    ] as const) {
      const events = await collectAdapterEvents(createKiroAdapter(provider).parseStream(new Response(streamOf(frame))));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", code: "kiro_stream_protocol_error", retryable: false });
      expect((events[0] as { message: string }).message).toContain(expected);
      expect(JSON.stringify(events)).not.toContain("must not leak");
    }
  });

  test("a new tool event without its Smithy identity fails closed", async () => {
    const events = await collectAdapterEvents(createKiroAdapter(provider).parseStream(new Response(streamOf(
      eventFrame({ input: "{}" }, "toolUseEvent"),
    ))));
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        code: "kiro_stream_protocol_error",
        retryable: false,
      }),
    ]);
    expect((events[0] as { message: string }).message).toContain("missing toolUseId or name");
  });

  test("valid returned message metadata replaces the generated continuation id", async () => {
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    let providerState: unknown;
    for await (const event of adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "done" }),
      eventFrame({ conversationId: "returned-conversation-1" }),
    )))) {
      if (event.type === "done") providerState = event.providerState;
    }
    expect(providerState).toEqual({ kiro: { conversationId: "returned-conversation-1" } });
  });

  test("invalid returned message metadata cannot poison continuation state", async () => {
    const adapter = createKiroAdapter(provider);
    const request = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    const generated = JSON.parse(request.body).conversationState.conversationId;
    let providerState: unknown;
    for await (const event of adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "done" }),
      eventFrame({ conversationId: "bad id with spaces" }),
    )))) {
      if (event.type === "done") providerState = event.providerState;
    }
    expect(providerState).toEqual({ kiro: { conversationId: generated } });
  });

  test("maps CW events (name repeated on every tool chunk) to AdapterEvents with accumulated args", async () => {
    const frames = [
      eventFrame({ content: "Hi " }),
      eventFrame({ content: "there" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"ec', name: "bash", toolUseId: "t1" }),
      eventFrame({ input: 'ho hi"}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const events: string[] = [];
    let args = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "text_delta") events.push(`text:${e.text}`);
      else if (e.type === "tool_call_start") events.push(`start:${e.id}:${e.name}`);
      else if (e.type === "tool_call_delta") { args += e.arguments; events.push("delta"); }
      else events.push(e.type);
    }
    expect(events).toEqual(["text:Hi ", "text:there", "heartbeat", "heartbeat", "heartbeat", "start:t1:bash", "delta", "delta", "tool_call_end", "done"]);
    expect(JSON.parse(args)).toEqual({ command: "echo hi" });
  });

  test("normalized tool name round-trips: Kiro echoes the safe name, parser restores the wire name", async () => {
    // A wire name with a space (codex_apps workspace agents) is sent to Kiro normalized; when Kiro
    // echoes that normalized name back, the parser must restore the original so the bridge can route it.
    const adapter = createKiroAdapter(provider);
    const tool = {
      name: "workspace agents_create_agent",
      namespace: "mcp__codex_apps__workspace_agents",
      description: "create",
      parameters: { type: "object" },
    };
    const { body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], [tool]));
    const sentName = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0].toolSpecification.name;
    const wireName = "mcp__codex_apps__workspace_agents__workspace agents_create_agent";
    expect(sentName).not.toBe(wireName);
    expect(sentName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    // Kiro replies using the normalized name it was given.
    const frames = [
      eventFrame({ name: sentName, toolUseId: "t1" }),
      eventFrame({ input: "{}", name: sentName, toolUseId: "t1" }),
      eventFrame({ name: sentName, stop: true, toolUseId: "t1" }),
    ];
    let restored: string | undefined;
    for await (const e of adapter.parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "tool_call_start") restored = e.name;
    }
    expect(restored).toBe(wireName);
  });

  test("tool-enabled commentary can finish only through a fragmented private completion call", async () => {
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));

    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "Checking the result." }),
      ...completionFrames("Task complete."),
    ))));

    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Checking the result.", phase: "commentary" },
      { type: "text_delta", text: "Task complete.", phase: "final_answer" },
    ]);
    expect(events.some(event => event.type === "tool_call_start" || event.type === "tool_call_delta")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(JSON.stringify(events)).not.toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  test("post-tool-result and explicit user follow-up turns still require private completion", async () => {
    const histories = [
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
      ],
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
        { role: "user", content: "summarize that" },
      ],
    ];
    for (const history of histories) {
      const adapter = createKiroAdapter(provider);
      const request = await adapter.buildRequest(parsedWith(history, [bashTool]));
      const tools = JSON.parse(request.body).conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
      expect(tools.at(-1).toolSpecification.name).toBe(KIRO_COMPLETION_TOOL_NAME);
      const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(...completionFrames("Done.")))));
      expect(events.filter(event => event.type === "text_delta")).toEqual([
        { type: "text_delta", text: "Done.", phase: "final_answer" },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    }
  });

  test("progress-only required response makes exactly one structural text fallback", async () => {
    const requests: Record<string, any>[] = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(streamOf(eventFrame({ content: "Final from fallback." })));
    }) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));

    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "I am checking." }),
      eventFrame({ conversationId: "returned-conversation-42" }),
    ))));

    expect(requests).toHaveLength(1);
    const retry = requests[0].conversationState;
    expect(retry.conversationId).toBe("returned-conversation-42");
    expect(retry.history.at(-1).assistantResponseMessage).toEqual({ content: "I am checking." });
    expect(retry.currentMessage.userInputMessage.content).toBe(KIRO_COMPLETION_RETRY_MESSAGE);
    expect(retry.currentMessage.userInputMessage.userInputMessageContext.tools.map(
      (tool: { toolSpecification: { name: string } }) => tool.toolSpecification.name,
    )).toEqual(["bash", KIRO_COMPLETION_TOOL_NAME]);
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "I am checking.", phase: "commentary" },
      { type: "text_delta", text: "Final from fallback.", phase: "final_answer" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      endTurn: true,
      providerState: { kiro: { conversationId: "returned-conversation-42" } },
    });
  });

  test.each([
    ["plain text", [eventFrame({ content: "  I am   checking.\n" })]],
    ["private completion", completionFrames(" I am checking. ")],
  ])("suppresses a whitespace-equivalent repeated %s fallback", async (_label, frames) => {
    globalThis.fetch = (async () => new Response(streamOf(...frames))) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));

    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "I am checking." }),
    ))));

    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "I am checking.", phase: "commentary" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(JSON.stringify(events)).not.toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  test("keeps a distinct private-completion fallback as the final answer", async () => {
    globalThis.fetch = (async () => new Response(streamOf(...completionFrames("Done.")))) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "do it" }], [bashTool]));

    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "I am checking." }),
    ))));

    expect(events.filter(event => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "I am checking.", phase: "commentary" },
      { type: "text_delta", text: "Done.", phase: "final_answer" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  });

  test("reasoning-only required response receives one fallback and can finish in plain text", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(streamOf(eventFrame({ content: "Reasoning checked; done." })));
    }) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "solve" }], [bashTool]));

    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "<thinking>private plan</thinking>" }),
    ))));

    expect(fetches).toBe(1);
    expect(events.some(event => event.type === "reasoning_raw_delta")).toBe(true);
    expect(events.find(event => event.type === "text_delta")).toEqual({
      type: "text_delta", text: "Reasoning checked; done.", phase: "final_answer",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  });

  test("normal Responses cancellation aborts the adapter-owned fallback without another replay", async () => {
    const abort = new AbortController();
    let fetches = 0;
    let fallbackSignal: AbortSignal | undefined;
    let markFallbackStarted!: () => void;
    const fallbackStarted = new Promise<void>(resolve => { markFallbackStarted = resolve; });
    globalThis.fetch = (async (_input, init) => {
      fetches++;
      if (fetches === 1) {
        return new Response(streamOf(eventFrame({ content: "Still working." })));
      }
      fallbackSignal = init?.signal ?? undefined;
      markFallbackStarted();
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(fallbackSignal?.reason ?? new DOMException("aborted", "AbortError"));
        if (fallbackSignal?.aborted) rejectAbort();
        else fallbackSignal?.addEventListener("abort", rejectAbort, { once: true });
      });
    }) as typeof fetch;

    const adapter = createKiroAdapter(provider);
    const request = await adapter.buildRequest(parsedWith([{ role: "user", content: "work" }], [bashTool]));
    const firstResponse = await adapter.fetchResponse!(request, { abortSignal: abort.signal, stream: true });
    const collecting = collectAdapterEvents(adapter.parseStream(firstResponse));
    await fallbackStarted;
    abort.abort(new DOMException("client closed", "AbortError"));
    const events = await collecting;

    expect(fetches).toBe(2);
    expect(fallbackSignal?.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
  });

  test("real tools never trigger the fallback and always leave endTurn false", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("unexpected fallback");
    }) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "run" }], [bashTool]));
    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ name: "bash", toolUseId: "call-1" }),
      eventFrame({ input: "{\"command\":\"pwd\"}", name: "bash", toolUseId: "call-1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "call-1" }),
    ))));
    expect(fetches).toBe(0);
    expect(events.find(event => event.type === "tool_call_start")).toMatchObject({ name: "bash" });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
  });

  test("a fallback real tool remains incomplete rather than becoming final text", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(streamOf(
        eventFrame({ name: "bash", toolUseId: "call-2" }),
        eventFrame({ input: "{\"command\":\"pwd\"}", name: "bash", toolUseId: "call-2" }),
        eventFrame({ name: "bash", stop: true, toolUseId: "call-2" }),
      ));
    }) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "run" }], [bashTool]));
    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "I need one more check." }),
    ))));
    expect(fetches).toBe(1);
    expect(events.find(event => event.type === "tool_call_start")).toMatchObject({ name: "bash" });
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: false });
  });

  test.each([
    ["empty", [] as Uint8Array[], "empty_kiro_fallback"],
    ["reasoning-only", [eventFrame({ content: "<thinking>still working</thinking>" })], "reasoning_only_kiro_fallback"],
  ])("%s fallback is retryable incomplete and never starts a third attempt", async (_label, fallbackFrames, reason) => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(streamOf(...fallbackFrames));
    }) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "work" }], [bashTool]));
    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "Working." }),
    ))));
    expect(fetches).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason, retryable: true, endTurn: false });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  test("empty successful required stream is retryable incomplete without an internal replay", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("unexpected fallback");
    }) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "work" }], [bashTool]));
    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf())));
    expect(fetches).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "empty_kiro_stream", retryable: true, endTurn: false });
  });

  test.each([
    ["empty answer", JSON.stringify({ answer: "   " })],
    ["malformed JSON", "{\"answer\":"],
  ])("fallback rejects %s completion as retryable incomplete", async (_label, input) => {
    globalThis.fetch = (async () => new Response(streamOf(
      eventFrame({ name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "complete-bad" }),
      eventFrame({ input, name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "complete-bad" }),
      eventFrame({ name: KIRO_COMPLETION_TOOL_NAME, stop: true, toolUseId: "complete-bad" }),
    ))) as typeof fetch;
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "work" }], [bashTool]));
    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(
      eventFrame({ content: "Working." }),
    ))));
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "malformed_kiro_completion", retryable: true });
    expect(JSON.stringify(events)).not.toContain(KIRO_COMPLETION_TOOL_NAME);
  });

  test("duplicate completion and completion mixed with real tools fail closed", async () => {
    const cases: Uint8Array[][] = [
      [...completionFrames("one", "complete-1"), ...completionFrames("two", "complete-2")],
      [
        eventFrame({ name: "bash", toolUseId: "call-1" }),
        eventFrame({ input: "{}", name: "bash", toolUseId: "call-1" }),
        eventFrame({ name: "bash", stop: true, toolUseId: "call-1" }),
        ...completionFrames("done", "complete-3"),
      ],
      [
        ...completionFrames("done", "complete-4"),
        eventFrame({ name: "bash", toolUseId: "call-2" }),
        eventFrame({ input: "{}", name: "bash", toolUseId: "call-2" }),
        eventFrame({ name: "bash", stop: true, toolUseId: "call-2" }),
      ],
    ];
    for (const frames of cases) {
      const adapter = createKiroAdapter(provider);
      await adapter.buildRequest(parsedWith([{ role: "user", content: "work" }], [bashTool]));
      const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(...frames))));
      expect(events.at(-1)?.type).toBe("error");
      expect(events.some(event => event.type === "done")).toBe(false);
    }
  });

  test("reserved private completion name never leaks as a client tool in disabled mode", async () => {
    const events = await collectAdapterEvents(createKiroAdapter(provider).parseStream(new Response(streamOf(
      eventFrame({ input: JSON.stringify({ answer: "hallucinated" }), name: KIRO_COMPLETION_TOOL_NAME, toolUseId: "bad" }),
    ))));
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(event => event.type === "tool_call_start")).toBe(false);
    expect(JSON.stringify(events)).not.toContain('"type":"tool_call_start"');
  });

  test("emits error for an exception frame", async () => {
    const frame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out[0]).toBe("error:Kiro rate limit exceeded: ThrottlingException: rate limited");
  });

  test("exception frame is terminal: no trailing done", async () => {
    const errFrame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const contentFrame = eventFrame({ content: "leaked text" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(errFrame, contentFrame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["error:Kiro rate limit exceeded: ThrottlingException: rate limited"]);
    expect(out).not.toContain("done");
    expect(out).not.toContain("text_delta");
  });

  test("exception mid-stream closes an open tool call then stops", async () => {
    const start = eventFrame({ name: "shell", toolUseId: "tu_1" });
    const errFrame = encodeMessage({ ":message-type": "error", ":error-type": "InternalServerException" }, enc.encode("boom"));
    const tail = eventFrame({ content: "should not appear" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(start, errFrame, tail)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["heartbeat", "error:Kiro upstream error: InternalServerException: boom"]);
    expect(out).not.toContain("tool_call_start");
    expect(out).not.toContain("tool_call_end");
    expect(out).not.toContain("done");
  });

  test("open tool input at EOF fails closed instead of emitting partial JSON", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"ec', name: "bash", toolUseId: "t1" }),
    ];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "error") out.push(`error:${e.message}`);
      else if (e.type === "tool_call_delta") out.push(`delta:${e.arguments}`);
      else out.push(e.type);
    }
    expect(out).toEqual(["heartbeat", "heartbeat", "error:Kiro response truncated upstream before the tool call completed (stream ended before tool stop)"]);
    expect(out.some(item => item.startsWith("delta:"))).toBe(false);
    expect(out).not.toContain("done");
  });

  test("open tool with complete JSON but no stop is recovered at EOF", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"pwd"}', name: "bash", toolUseId: "t1" }),
    ];
    const out: string[] = [];
    let args = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "tool_call_delta") { args += e.arguments; out.push("delta"); }
      else out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["heartbeat", "heartbeat", "tool_call_start", "delta", "tool_call_end", "done"]);
    expect(JSON.parse(args)).toEqual({ command: "pwd" });
  });

  test("tool stop without an open tool emits an adapter error", async () => {
    const frame = eventFrame({ name: "bash", stop: true, toolUseId: "t1" });
    const out: string[] = [];

    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }

    expect(out).toEqual([
      "error:Kiro response protocol error: tool stop received without an open tool call",
    ]);
    expect(out).not.toContain("done");
  });

  test("explicit Kiro truncation marker fails without done", async () => {
    const frame = eventFrame({ finish_reason: "max_tokens" }, "assistantResponseEvent");
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["error:Kiro response truncated upstream before the tool call completed (max_tokens)"]);
    expect(out).not.toContain("done");
  });

  test("duplicate tool name starts before input do not create duplicate tool calls", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"pwd"}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const starts: string[] = [];
    const events: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "tool_call_start") starts.push(e.name);
      events.push(e.type);
    }
    expect(starts).toEqual(["bash"]);
    expect(events).toEqual(["heartbeat", "heartbeat", "heartbeat", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
  });

  test("tool input for a different toolUseId before stop fails closed (no merged args)", async () => {
    const frames = [
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"a"}', name: "bash", toolUseId: "t1" }),
      // Input for a different tool id arrives before t1 stops — must not be merged into t1.
      eventFrame({ input: '{"pattern":"b"}', name: "grep", toolUseId: "t2" }),
    ];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out.some(s => s.startsWith("error:"))).toBe(true);
    expect(out).not.toContain("tool_call_end");
    expect(out).not.toContain("done");
  });

  test("exception payload errors redact secrets, profile ARNs, raw JSON, and local paths", async () => {
    const secretPayload = JSON.stringify({
      __type: "ValidationException",
      message: "accessToken=aoa-secret refreshToken=rt-secret clientSecret=client-secret profile arn:aws:codewhisperer:us-east-1:123456789012:profile/demo path /Users/example/private/file.json",
      accessToken: "aoa-secret",
      refreshToken: "rt-secret",
      clientSecret: "client-secret",
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
    });
    const frame = encodeMessage({ ":message-type": "exception", ":exception-type": "ValidationException" }, enc.encode(secretPayload));
    const errors: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      if (e.type === "error") errors.push(e.message);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Kiro invalid request: ValidationException");
    expect(errors[0]).not.toContain("aoa-secret");
    expect(errors[0]).not.toContain("rt-secret");
    expect(errors[0]).not.toContain("client-secret");
    expect(errors[0]).not.toContain("arn:aws");
    expect(errors[0]).not.toContain("/Users/example");
    expect(errors[0]).not.toContain("{");
  });

  test("auth and model exceptions become actionable Kiro errors", async () => {
    const authFrame = encodeMessage(
      { ":message-type": "exception", ":exception-type": "AccessDeniedException" },
      enc.encode(JSON.stringify({ message: "expired token for profileArn=arn:aws:codewhisperer:us-east-1:123456789012:profile/demo" })),
    );
    const modelFrame = encodeMessage(
      { ":message-type": "exception", ":exception-type": "ValidationException" },
      enc.encode(JSON.stringify({ message: "model not found in this region" })),
    );
    const messages: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(authFrame)))) {
      if (e.type === "error") messages.push(e.message);
    }
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(modelFrame)))) {
      if (e.type === "error") messages.push(e.message);
    }
    expect(messages[0]).toContain("Kiro authentication failed: AccessDeniedException");
    expect(messages[0]).not.toContain("arn:aws");
    expect(messages[1]).toContain("Kiro invalid request: ValidationException");
    expect(messages[1]).toContain("model not found");
  });

  test("stream parser catch path redacts thrown error details", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("decoder failed refreshToken=rt-secret clientSecret=client-secret /Users/example/private/file.json");
      },
    });
    const errors: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(broken))) {
      if (e.type === "error") errors.push(e.message);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Kiro upstream error");
    expect(errors[0]).not.toContain("rt-secret");
    expect(errors[0]).not.toContain("client-secret");
    expect(errors[0]).not.toContain("/Users/example");
  });

  test("leading thinking block is emitted as raw reasoning, not visible text", async () => {
    const frames = [eventFrame({ content: "<thinking>private plan</thinking>visible answer" })];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "reasoning_raw_delta") out.push(`reason:${e.text}`);
      else if (e.type === "text_delta") out.push(`text:${e.text}`);
      else out.push(e.type);
    }
    expect(out).toEqual(["reason:private plan", "text:visible answer", "done"]);
    expect(out.join("|")).not.toContain("<thinking>");
  });

  test("native reasoningContentEvent is emitted as reasoning, not assistant text", async () => {
    const events = await collectAdapterEvents(createKiroAdapter(provider).parseStream(new Response(streamOf(
      eventFrame({ text: "private plan" }, "reasoningContentEvent"),
      eventFrame({ content: "visible answer" }),
    ))));
    expect(events).toEqual([
      { type: "reasoning_raw_delta", text: "private plan" },
      { type: "text_delta", text: "visible answer" },
      expect.objectContaining({ type: "done", endTurn: true }),
    ]);
  });

  test("thinking tags split across chunks are parsed as reasoning", async () => {
    const frames = [
      eventFrame({ content: "<think" }),
      eventFrame({ content: "ing>split" }),
      eventFrame({ content: " thought</thinking>\nanswer" }),
    ];
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "reasoning_raw_delta") out.push(`reason:${e.text}`);
      else if (e.type === "text_delta") out.push(`text:${e.text}`);
      else out.push(e.type);
    }
    expect(out).toEqual(["reason:split thought", "text:answer", "done"]);
  });

  test("non-leading thinking tag remains visible text", async () => {
    const frame = eventFrame({ content: "answer <thinking>literal</thinking>" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      if (e.type === "text_delta") out.push(e.text);
    }
    expect(out.join("")).toBe("answer <thinking>literal</thinking>");
  });

  test("unterminated leading thinking block flushes as reasoning at stream end", async () => {
    const frames = [eventFrame({ content: "<reasoning>still private" })];
    const out: string[] = [];
    let reasoning = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "reasoning_raw_delta") reasoning += e.text;
      else if (e.type === "text_delta") out.push(`text:${e.text}`);
      else out.push(e.type);
    }
    expect(reasoning).toBe("still private");
    expect(out).toEqual(["done"]);
  });

  test("done carries heuristic usage (input from current turn, output from streamed text)", async () => {
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
    const done = await doneUsage(adapter, eventFrame({ content: "y".repeat(350) }));
    expect(done.inputTokens).toBe(200);
    expect(done.outputTokens).toBe(100);
    expect(done.estimated).toBe(true);
  });

  test("authoritative metadata token usage overrides estimates and preserves cache splits", async () => {
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
    const done = await doneUsage(
      adapter,
      eventFrame({ content: "answer" }),
      eventFrame({
        tokenUsage: {
          uncachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          outputTokens: 4,
          totalTokens: 19,
        },
      }, "metadataEvent"),
    );
    expect(done).toEqual({
      inputTokens: 15,
      cachedInputTokens: 3,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
      outputTokens: 4,
      totalTokens: 19,
    });
  });

  test("invalid provider token usage is rejected instead of replacing estimates", async () => {
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    const events = await collectAdapterEvents(adapter.parseStream(new Response(streamOf(eventFrame({
      tokenUsage: {
        uncachedInputTokens: -1,
        outputTokens: 4,
        totalTokens: 3,
      },
    }, "metadataEvent")))));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "kiro_stream_protocol_error",
      retryable: false,
    });
  });

  test("CONTENT_LENGTH_EXCEEDS_THRESHOLD is a permanent structured context error", async () => {
    const frame = encodeMessage(
      { ":message-type": "exception", ":exception-type": "ValidationException" },
      enc.encode(JSON.stringify({
        message: "Input content length exceeds threshold.",
        reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD",
      })),
    );
    const events = await collectAdapterEvents(createKiroAdapter(provider).parseStream(new Response(streamOf(frame))));
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        status: 400,
        errorType: "invalid_request_error",
        code: "context_length_exceeded",
        retryable: false,
      }),
    ]);
    expect((events[0] as { message: string }).message).toContain("Compact or reduce the history");
  });

  test("Kiro contextUsagePercentage remains diagnostic and does not override totals", async () => {
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
    const done = await doneUsage(
      adapter,
      eventFrame({ content: "y".repeat(350) }),
      eventFrame({ contextUsagePercentage: 25 }),
    );

    expect(done.inputTokens).toBe(200);
    expect(done.outputTokens).toBe(100);
    expect(done.totalTokens).toBeUndefined();
    expect(done.estimated).toBe(true);
  });

  test("Kiro auto ignores provider-level context window and falls back to heuristic totals", async () => {
    const adapter = createKiroAdapter({ ...provider, contextWindow: 200_000 });
    await adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }], undefined, "kiro-auto"));
    const done = await doneUsage(
      adapter,
      eventFrame({ content: "y".repeat(350) }),
      eventFrame({ contextUsagePercentage: 25 }),
    );

    expect(done.inputTokens).toBe(200);
    expect(done.outputTokens).toBe(100);
    expect(done.totalTokens).toBeUndefined();
  });

  test("fresh payload includes history while usage counts only the current turn", async () => {
    const latest = "please summarize recent commits";
    const shortMessages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: latest },
    ];
    const longMessages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: "another old question" },
      { role: "assistant", content: [{ type: "text", text: "another old answer" }] },
      { role: "user", content: latest },
    ];
    const shortAdapter = createKiroAdapter(provider);
    const shortBody = (await shortAdapter.buildRequest(parsedWith(shortMessages))).body;
    const shortUsage = await doneUsage(shortAdapter, eventFrame({ content: "ok" }));
    const longAdapter = createKiroAdapter(provider);
    const longBody = (await longAdapter.buildRequest(parsedWith(longMessages))).body;
    const longUsage = await doneUsage(longAdapter, eventFrame({ content: "ok" }));
    expect(longBody.length).toBeGreaterThan(shortBody.length + 10_000);
    expect(longUsage.inputTokens).toBe(shortUsage.inputTokens);
    expect(longUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
  });

  test("request log usage estimates the full Codex context while SSE usage stays current-turn", async () => {
    const latest = "please summarize recent commits";
    const messages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: latest },
    ];
    const adapter = createKiroAdapter(provider);
    const request = await adapter.buildRequest(parsedWith(messages));
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));

    expect(usage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
    expect(request.usageLog?.estimated).toBe(true);
    expect(request.usageLog?.inputTokens).toBeGreaterThan(usage.inputTokens + 4000);
  });

  test("resumed payload preserves the complete locally expanded history", async () => {
    const latest = "please summarize recent commits";
    const oldHistory = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: "another old question" },
      { role: "assistant", content: [{ type: "text", text: "another old answer" }] },
    ];
    const freshBody = (await createKiroAdapter(provider).buildRequest(parsedWith([...oldHistory, { role: "user", content: latest }]))).body;
    const resumedAdapter = createKiroAdapter(provider);
    const resumedBody = (await resumedAdapter.buildRequest({
      ...parsedWith([...oldHistory, { role: "user", content: latest }]),
      previousResponseId: "kiro-prev-1",
    })).body;
    const resumedUsage = await doneUsage(resumedAdapter, eventFrame({ content: "ok" }));
    const cs = JSON.parse(resumedBody).conversationState;
    expect(resumedBody.length).toBe(freshBody.length);
    expect(cs.history).toHaveLength(4);
    expect(cs.currentMessage.userInputMessage.content).toBe(latest);
    expect(resumedUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
  });

  test("tool-result follow-up counts new tool output without re-counting prior assistant tool args", async () => {
    const hugeArgs = { command: "x".repeat(8000) };
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: hugeArgs }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "done", isError: false },
    ];
    const adapter = createKiroAdapter(provider);
    const body = (await adapter.buildRequest(parsedWith(messages))).body;
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));
    expect(body).toContain("x".repeat(8000));
    expect(usage.inputTokens).toBeLessThan(50);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("resumed tool-result payload preserves the matching assistant toolUse context", async () => {
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = await createKiroAdapter(provider).buildRequest({ ...parsedWith(messages, [bashTool]), previousResponseId: "kiro-prev-1" });
    const cs = JSON.parse(body).conversationState;
    expect(cs.history).toHaveLength(2);
    expect(cs.history[0].userInputMessage.content).toContain("run a command");
    expect(cs.history[1].assistantResponseMessage.toolUses).toEqual([
      { name: "bash", input: { command: "pwd" }, toolUseId: "call-1" },
    ]);
    expect(cs.currentMessage.userInputMessage.content).toBe("");
    expect(cs.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
      { content: [{ text: "/tmp" }], status: "success", toolUseId: "call-1" },
    ]);
  });

  test("resumed tool-result usage remains current-turn only after payload repair", async () => {
    const messages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "x".repeat(8000) } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "done", isError: false },
    ];
    const adapter = createKiroAdapter(provider);
    await adapter.buildRequest({ ...parsedWith(messages), previousResponseId: "kiro-prev-1" });
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));
    expect(usage.inputTokens).toBeLessThan(50);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("buildRequest emits only redacted Kiro diagnostic breadcrumbs when enabled", async () => {
    process.env.OCX_DEBUG_FRAMES = "1";
    process.env.KIRO_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "secret prompt body" }], [bashTool]));
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[ocx:kiro:request]");
      expect(line).toContain("\"region\":\"us-east-1\"");
      expect(line).toContain("\"hasProfileArn\":true");
      expect(line).not.toContain("secret prompt body");
      expect(line).not.toContain("tok-123");
      expect(line).not.toContain("arn:aws:codewhisperer");
    } finally {
      error.mockRestore();
    }
  });
});

describe("kiro adapter — parseResponse (web-search sidecar non-streaming path)", () => {
  test("adapter exposes parseResponse so the web_search sidecar accepts kiro", async () => {
    expect(typeof createKiroAdapter(provider).parseResponse).toBe("function");
  });

  test("drains the same CW eventstream into an AdapterEvent[] (parity with parseStream)", async () => {
    const frames = [
      eventFrame({ content: "Hi " }),
      eventFrame({ content: "there" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"q":1}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const events = await createKiroAdapter(provider).parseResponse!(new Response(streamOf(...frames)));
    expect(events.map(e => e.type)).toEqual([
      "text_delta", "text_delta", "heartbeat", "heartbeat", "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    const start = events.find(e => e.type === "tool_call_start") as { id: string; name: string };
    expect(start).toMatchObject({ id: "t1", name: "bash" });
  });
});
