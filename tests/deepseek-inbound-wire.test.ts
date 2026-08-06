/**
 * DeepSeek V4 Flash is native on BOTH the Responses API and Chat Completions, so the
 * wire it should ride depends on what the CLIENT already speaks:
 *
 * - Codex speaks Responses natively -> go out on Responses, zero translation hops.
 * - Claude Code (Anthropic Messages) and OpenAI-compatible Chat clients -> stay on the
 *   provider-wide Chat wire, which DeepSeek serves natively too.
 *
 * The subtle part is that the Chat and Anthropic surfaces translate their body into a
 * Responses shape and REPLAY through handleResponses. A resolver-only test would pass
 * while that replay silently flipped the wire back, so the end-to-end cases below
 * assert the captured upstream URL, which is externally observable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import {
  getProviderRegistryEntry,
  providerModelResponsesTerminalRepair,
} from "../src/providers/registry";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
import type { ResponsesTerminalRepairScheduler } from "../src/server/responses-terminal-repair";
import { sendResponseToWebSocket } from "../src/server/ws-bridge";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const MODEL = "deepseek-v4-flash";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ManualTerminalScheduler implements ResponsesTerminalRepairScheduler {
  private current = 0;
  private nextId = 1;
  private readonly jobs = new Map<number, { at: number; callback: () => void }>();

  nowMs(): number { return this.current; }
  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.current + delayMs, callback });
    return id;
  }
  cancel(handle: unknown): void { this.jobs.delete(handle as number); }
  advance(ms: number): void {
    this.current += ms;
    for (const [id, job] of [...this.jobs.entries()]) {
      if (job.at > this.current || !this.jobs.delete(id)) continue;
      job.callback();
    }
  }
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function controlledSse(): {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  cancel(): void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  return {
    stream: new ReadableStream<Uint8Array>({ start(next) { controller = next; } }),
    push(text) { controller?.enqueue(encoder.encode(text)); },
    cancel() { try { controller?.close(); } catch { /* already closed */ } },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
): Promise<string> {
  let out = "";
  while (!out.includes(pattern)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream closed before ${pattern}`);
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function drainReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

function deepseekProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
}

describe("DeepSeek wire selection is scoped to the inbound protocol", () => {
  test("a Responses inbound rides the native Responses wire", () => {
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider(), "responses");
    expect(resolved.adapter).toBe("openai-responses");
  });

  test("an omitted inbound defaults to Responses", () => {
    // Most call sites are genuine Responses requests and rely on the default.
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider());
    expect(resolved.adapter).toBe("openai-responses");
  });

  test("an Anthropic inbound stays on the provider Chat wire", () => {
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider(), "anthropic");
    expect(resolved.adapter).toBe("openai-chat");
  });

  test("a Chat inbound stays on the provider Chat wire", () => {
    const resolved = resolveWireProtocolOverride("deepseek", MODEL, deepseekProvider(), "chat");
    expect(resolved.adapter).toBe("openai-chat");
  });

  test("an explicit per-model override still wins on every inbound", () => {
    // User intent outranks a registry default, or the override would be unusable on
    // the two surfaces the scope excludes.
    const provider = { ...deepseekProvider(), modelAdapters: { [MODEL]: "openai-responses" } };
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("deepseek", MODEL, provider, inbound).adapter)
        .toBe("openai-responses");
    }
  });

  test("a model with no declared default is untouched on every inbound", () => {
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("deepseek", "deepseek-chat", deepseekProvider(), inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("the official DeepSeek Responses route opts into terminal repair", () => {
    const provider = deepseekProvider();
    expect(providerModelResponsesTerminalRepair("deepseek", provider, MODEL)).toEqual({ graceMs: 5_000 });
    expect(providerModelResponsesTerminalRepair("deepseek", provider, "deepseek-chat")).toBeUndefined();
    expect(providerModelResponsesTerminalRepair("custom-deepseek", provider, MODEL)).toBeUndefined();
  });
});

describe("the inbound scope survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function captureUpstreamRequests(): Array<{ url: string; body: Record<string, unknown> }> {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({
        id: "resp_deepseek",
        object: "response",
        status: "completed",
        output: [],
      });
    }) as typeof fetch;
    return requests;
  }

  async function drive(
    inboundWire?: "responses" | "chat" | "anthropic",
    inboundTransport?: "websocket",
  ): Promise<{ url: string; body: Record<string, unknown> }> {
    const requests = captureUpstreamRequests();
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      {
        ...(inboundWire === undefined ? {} : { inboundWire }),
        ...(inboundTransport === undefined ? {} : { inboundTransport }),
      },
    );
    return requests[0] ?? { url: "", body: {} };
  }

  test("a native Responses request reaches the documented /responses route", async () => {
    expect((await drive("responses")).url).toBe("https://api.deepseek.com/responses");
  });

  test("an Anthropic replay reaches /chat/completions, not /responses", async () => {
    // Regression guard for the audit's critical finding: editing only the pre-flight
    // resolution in claude-messages.ts left this URL on /responses.
    expect((await drive("anthropic")).url).toBe("https://api.deepseek.com/chat/completions");
  });

  test("a Chat replay reaches /chat/completions, not /responses", async () => {
    expect((await drive("chat")).url).toBe("https://api.deepseek.com/chat/completions");
  });

  test("Codex HTTP and WebSocket turns keep DeepSeek streaming upstream", async () => {
    const http = await drive("responses");
    const websocket = await drive("responses", "websocket");
    expect(http.url).toBe("https://api.deepseek.com/responses");
    expect(websocket.url).toBe("https://api.deepseek.com/responses");
    expect(http.body.stream).toBe(true);
    expect(websocket.body.stream).toBe(true);
  });

  test("HTTP streams a DeepSeek delta before safely repairing a missing terminal", async () => {
    const source = controlledSse();
    const scheduler = new ManualTerminalScheduler();
    const requestBodies: Record<string, unknown>[] = [];
    const testAbort = new AbortController();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(source.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const options = {
      abortSignal: testAbort.signal,
      responsesTerminalRepairScheduler: scheduler,
    } as Parameters<typeof handleResponses>[3];
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      options,
    );
    const reader = response.body!.getReader();
    try {
      source.push([
        sse({ type: "response.created", response: { id: "resp_http", status: "in_progress", output: [] }, sequence_number: 0 }),
        sse({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_http", status: "in_progress", content: [] }, output_index: 0, sequence_number: 1 }),
        sse({ type: "response.reasoning_text.delta", item_id: "rs_http", output_index: 0, delta: "thinking", sequence_number: 2 }),
      ].join(""));
      const first = await readUntil(reader, "response.reasoning_text.delta");
      expect(first).toContain("thinking");
      expect(requestBodies[0]?.stream).toBe(true);

      source.push([
        sse({
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_http", status: "completed", content: [{ type: "reasoning_text", text: "thinking" }], summary: [] },
          output_index: 0,
          sequence_number: 3,
        }),
        sse({ type: "response.output_item.added", item: { type: "function_call", id: "fc_http", status: "in_progress", arguments: "", call_id: "call_http", name: "probe" }, output_index: 1, sequence_number: 4 }),
        sse({ type: "response.function_call_arguments.done", item_id: "fc_http", output_index: 1, arguments: "{\"text\":\"OK\"}", sequence_number: 5 }),
        sse({
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_http", status: "completed", arguments: "{\"text\":\"OK\"}", call_id: "call_http", name: "probe" },
          output_index: 1,
          sequence_number: 6,
        }),
      ].join(""));
      await Bun.sleep(0);
      scheduler.advance(5_000);
      const remainder = await Promise.race([
        drainReader(reader),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("terminal repair did not close")), 200)),
      ]);
      expect(remainder).toContain("response.completed");
      expect(remainder).toContain("data: [DONE]");
      expect(remainder).toContain('"call_id":"call_http"');
    } finally {
      testAbort.abort("test cleanup");
      source.cancel();
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  });

  test("WebSocket delivery preserves progressive DeepSeek frames and accepts the repaired tool result", async () => {
    const source = controlledSse();
    const scheduler = new ManualTerminalScheduler();
    const requestBodies: Record<string, unknown>[] = [];
    let requestNumber = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      requestNumber += 1;
      if (requestNumber === 1) {
        return new Response(source.stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "resp_ws_followup",
        object: "response",
        status: "completed",
        output: [],
      });
    }) as typeof fetch;
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const abort = new AbortController();
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      {
        abortSignal: abort.signal,
        inboundTransport: "websocket",
        responsesTerminalRepairScheduler: scheduler,
      },
    );
    const sent: string[] = [];
    const ws = {
      readyState: 1,
      data: {},
      send(message: string) { sent.push(message); return 1; },
    } as Parameters<typeof sendResponseToWebSocket>[0];
    try {
      const pump = sendResponseToWebSocket(ws, response, () => true);
      source.push([
        sse({ type: "response.created", response: { id: "resp_ws", status: "in_progress", output: [] }, sequence_number: 0 }),
        sse({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_ws", status: "in_progress", content: [] }, output_index: 0, sequence_number: 1 }),
        sse({ type: "response.reasoning_text.delta", item_id: "rs_ws", output_index: 0, delta: "thinking", sequence_number: 2 }),
      ].join(""));
      for (let i = 0; i < 20 && !sent.some(frame => JSON.parse(frame).type === "response.reasoning_text.delta"); i += 1) {
        await Bun.sleep(0);
      }
      expect(sent.some(frame => JSON.parse(frame).type === "response.reasoning_text.delta")).toBe(true);
      expect(sent.some(frame => JSON.parse(frame).type === "response.completed")).toBe(false);

      source.push([
        sse({
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_ws", status: "completed", content: [{ type: "reasoning_text", text: "thinking" }], summary: [] },
          output_index: 0,
          sequence_number: 3,
        }),
        sse({ type: "response.output_item.added", item: { type: "function_call", id: "fc_ws", status: "in_progress", arguments: "", call_id: "call_ws", name: "probe" }, output_index: 1, sequence_number: 4 }),
        sse({ type: "response.function_call_arguments.done", item_id: "fc_ws", output_index: 1, arguments: "{\"text\":\"OK\"}", sequence_number: 5 }),
        sse({
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_ws", status: "completed", arguments: "{\"text\":\"OK\"}", call_id: "call_ws", name: "probe" },
          output_index: 1,
          sequence_number: 6,
        }),
      ].join(""));
      for (let i = 0; i < 20 && !sent.some(frame => JSON.parse(frame).type === "response.output_item.done"); i += 1) {
        await Bun.sleep(0);
      }
      scheduler.advance(5_000);
      await pump;

      const eventTypes = sent.map(frame => JSON.parse(frame).type as string);
      expect(eventTypes.filter(type => type === "response.completed")).toHaveLength(1);
      expect(eventTypes).toContain("response.output_item.done");

      const followup = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            input: [
              { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "probe", arguments: "{\"text\":\"OK\"}" },
              { type: "function_call_output", call_id: "call_ws", output: "OK" },
            ],
            stream: true,
          }),
        }),
        config,
        { model: "", provider: "" },
        { inboundTransport: "websocket" },
      );
      await followup.text();
      expect(requestBodies[1]?.input).toEqual([
        { type: "function_call", call_id: "call_ws", name: "probe", arguments: "{\"text\":\"OK\"}" },
        { type: "function_call_output", call_id: "call_ws", output: "OK" },
      ]);
    } finally {
      abort.abort("test cleanup");
      source.cancel();
    }
  });

  function completedWithPlaceholderIds(): Response {
    return Response.json({
      id: "resp_deepseek",
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_placeholder", summary: [] },
        {
          type: "message",
          id: "msg_placeholder",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    });
  }

  test("streaming terminal repair composes with canonical item-id repair", async () => {
    const source = controlledSse();
    const scheduler = new ManualTerminalScheduler();
    globalThis.fetch = (async () => new Response(source.stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const abort = new AbortController();
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: abort.signal, responsesTerminalRepairScheduler: scheduler },
    );
    const reader = response.body!.getReader();
    const uuidReasoning = "1b9d6bcd-bbfd-4b2d-9b9d-5c0a2fb41a1b";
    const uuidMessage = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const uuidFunction = "550e8400-e29b-41d4-a716-446655440000";
    try {
      source.push([
        sse({ type: "response.created", response: { id: "resp_ids", status: "in_progress", output: [] }, sequence_number: 0 }),
        sse({ type: "response.output_item.added", item: { type: "reasoning", id: uuidReasoning, status: "in_progress", content: [] }, output_index: 0, sequence_number: 1 }),
        sse({ type: "response.output_item.done", item: { type: "reasoning", id: uuidReasoning, status: "completed", content: [{ type: "reasoning_text", text: "thinking" }], summary: [] }, output_index: 0, sequence_number: 2 }),
        sse({ type: "response.output_item.added", item: { type: "message", id: uuidMessage, role: "assistant", status: "in_progress", content: [] }, output_index: 1, sequence_number: 3 }),
        sse({ type: "response.output_text.delta", item_id: uuidMessage, output_index: 1, delta: "hello", sequence_number: 4 }),
        sse({ type: "response.output_item.done", item: { type: "message", id: uuidMessage, role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }, output_index: 1, sequence_number: 5 }),
        sse({ type: "response.output_item.added", item: { type: "function_call", id: uuidFunction, status: "in_progress", arguments: "", call_id: "call_stream", name: "probe" }, output_index: 2, sequence_number: 6 }),
        sse({ type: "response.function_call_arguments.done", item_id: uuidFunction, output_index: 2, arguments: "{\"text\":\"OK\"}", sequence_number: 7 }),
        sse({ type: "response.output_item.done", item: { type: "function_call", id: uuidFunction, status: "completed", arguments: "{\"text\":\"OK\"}", call_id: "call_stream", name: "probe" }, output_index: 2, sequence_number: 8 }),
      ].join(""));
      const prefix = await readUntil(reader, '"sequence_number":8');
      scheduler.advance(5_000);
      const text = prefix + await drainReader(reader);
      const payloads = text
        .split(/\r?\n/)
        .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const reasoningAdded = payloads.find(event => event.type === "response.output_item.added" && event.output_index === 0)!;
      const reasoningDone = payloads.find(event => event.type === "response.output_item.done" && event.output_index === 0)!;
      const messageAdded = payloads.find(event => event.type === "response.output_item.added" && event.output_index === 1)!;
      const messageDone = payloads.find(event => event.type === "response.output_item.done" && event.output_index === 1)!;
      const completed = payloads.find(event => event.type === "response.completed")!;
      const output = (completed.response as { output: Array<{ id: string; call_id?: string }> }).output;
      const reasoningId = (reasoningAdded.item as { id: string }).id;
      const messageId = (messageAdded.item as { id: string }).id;
      expect(reasoningId).toMatch(/^rs_ocx_/);
      expect(messageId).toMatch(/^msg_ocx_/);
      expect((reasoningDone.item as { id: string }).id).toBe(reasoningId);
      expect((messageDone.item as { id: string }).id).toBe(messageId);
      expect(output[0]?.id).toBe(reasoningId);
      expect(output[1]?.id).toBe(messageId);
      expect(output[2]).toMatchObject({ id: uuidFunction, call_id: "call_stream" });
      expect(text).not.toContain(uuidReasoning);
      expect(text).not.toContain(uuidMessage);
    } finally {
      abort.abort("test cleanup");
      source.cancel();
      try { await reader.cancel(); } catch { /* already closed */ }
    }
  });

  test("a JSON fallback without id repair keeps its body byte-identical", async () => {
    globalThis.fetch = (async () => completedWithPlaceholderIds()) as typeof fetch;
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping" }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses", inboundTransport: "websocket" },
    );
    const text = await response.text();
    expect(text).toContain("msg_placeholder");
    expect(text).toContain("rs_placeholder");
  });

  test("an oversized upstream JSON body fails closed instead of buffering without limit", async () => {
    // Every application/json fallback materializes the whole body, so the read must
    // have a hard byte ceiling. 33 MiB is
    // one MiB over MAX_UPSTREAM_JSON_BODY_BYTES.
    globalThis.fetch = (async () => new Response(" ".repeat(33 * 1024 * 1024), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses", inboundTransport: "websocket" },
    );

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(payload.error?.code).toBe("upstream_server_error");
    expect(payload.error?.message).toContain("exceeded the safe body limit");
  });
});

/**
 * DeepSeek documents "the API is stateless: responses and conversations are not
 * stored on the server", so parameters that reference server-held state can never be
 * honoured. Multi-turn context still works because the proxy expands
 * previous_response_id into a full input replay before the adapter runs.
 */
describe("stateless Responses upstreams get no stateful parameters", () => {
  function buildBody(provider: OcxProviderConfig, rawBody: Record<string, unknown>): Record<string, unknown> {
    const built = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: MODEL,
      context: { messages: [] },
      stream: true,
      options: {},
      _rawBody: { model: MODEL, input: "ping", ...rawBody },
    } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    return JSON.parse(String(built.body)) as Record<string, unknown>;
  }

  const STATEFUL = {
    previous_response_id: "resp_abc",
    conversation: "conv_abc",
    background: true,
    metadata: { k: "v" },
    prompt: { id: "pmpt_abc" },
  };

  test("the documented stateful parameters are dropped and store is pinned", () => {
    const body = buildBody({ ...deepseekProvider(), adapter: "openai-responses" }, STATEFUL);
    for (const key of Object.keys(STATEFUL)) expect(body).not.toHaveProperty(key);
    expect(body.store).toBe(false);
  });

  test("service_tier survives, because the server sets it for fast mode", () => {
    // Deleting a configured knob inside an adapter would be action-at-a-distance;
    // forwarding a parameter the upstream ignores is the reversible choice.
    const body = buildBody({ ...deepseekProvider(), adapter: "openai-responses" }, { service_tier: "priority" });
    expect(body.service_tier).toBe("priority");
  });

  test("a provider without the capability keeps every one of them", () => {
    // Negative control: the strip must be capability-gated, not global.
    const body = buildBody(
      { adapter: "openai-responses", baseUrl: "https://api.openai.example", authMode: "key", apiKey: "sk-test" },
      STATEFUL,
    );
    expect(body.previous_response_id).toBe("resp_abc");
    expect(body.metadata).toEqual({ k: "v" });
    expect(body.store).toBeUndefined();
  });

  test("the seed and backfill carry the capability, and only for declaring entries", () => {
    expect(providerConfigSeed(getProviderRegistryEntry("deepseek")!).statelessResponses).toBe(true);
    expect(providerConfigSeed(getProviderRegistryEntry("cerebras")!).statelessResponses).toBeUndefined();
  });

  test("a replay miss does not forward an orphaned tool result", () => {
    // On a replay miss the delta can open with a function_call_output whose paired
    // function_call sat in the prefix that was never expanded. A stateless upstream
    // cannot resolve the pair from its own storage, so forwarding the orphan earns a
    // 400 -- dropping stateful params is not much use if the body is unparseable.
    const built = createResponsesPassthroughAdapter({ ...deepseekProvider(), adapter: "openai-responses" })
      .buildRequest({
        modelId: MODEL,
        context: { messages: [] },
        stream: true,
        options: {},
        previousResponseId: "resp_missing",
        _rawBody: {
          model: MODEL,
          previous_response_id: "resp_missing",
          input: [
            { type: "function_call_output", call_id: "call_orphan", output: "42" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
          ],
        },
      } as Parameters<ReturnType<typeof createResponsesPassthroughAdapter>["buildRequest"]>[0], { headers: new Headers() });
    const input = (JSON.parse(String(built.body)) as { input: Array<{ type?: string; call_id?: string }> }).input;
    expect(input.some(item => item.call_id === "call_orphan")).toBe(false);
    expect(input.some(item => item.type === "message")).toBe(true);
  });
});
