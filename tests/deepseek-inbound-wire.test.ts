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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { safeConfigDTO, providerManagementConfigError } from "../src/server/auth-cors";
import {
  modelResponsesCompatibilityConfigError,
  modelResponsesTerminalRepairConfigError,
  responsesTerminalRepairConfigError,
} from "../src/config";
import type { OcxConfig } from "../src/types";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import {
  getProviderRegistryEntry,
  providerModelResponsesTerminalRepair,
  PROVIDER_REGISTRY,
} from "../src/providers/registry";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
import { MAX_SYNTHESIZED_OUTPUT_ITEMS } from "../src/server/responses-json-events";
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
  pending(): number { return this.jobs.size; }
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

function deepseekReasoningProvider(): OcxProviderConfig {
  return { ...deepseekProvider(), preserveResponsesReasoningContent: true };
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

  test("terminal repair rejects a fractional grace that normalizes to zero", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "deepseek");
    const policy = entry?.modelResponsesTerminalRepair?.[MODEL];
    if (!policy) throw new Error("missing DeepSeek terminal-repair fixture");
    const originalGraceMs = policy.graceMs;
    try {
      policy.graceMs = 0.5;
      expect(providerModelResponsesTerminalRepair("deepseek", deepseekProvider(), MODEL)).toBeUndefined();
    } finally {
      policy.graceMs = originalGraceMs;
    }
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

  test("a Codex WebSocket turn keeps real streaming upstream", async () => {
    // The #875 bounded-JSON force is retired for deepseek: the documented terminal
    // (response.completed, no [DONE]) closes the stream, so WS turns stream live.
    const request = await drive("responses", "websocket");
    expect(request.url).toBe("https://api.deepseek.com/responses");
    expect(request.body.stream).toBe(true);
  });

  test("ordinary HTTP Responses requests keep stream:true upstream (#875 retired)", async () => {
    const request = await drive("responses");
    expect(request.body.stream).toBe(true);
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
      for (let attempts = 0; attempts < 20 && scheduler.pending() === 0; attempts += 1) {
        await Bun.sleep(0);
      }
      expect(scheduler.pending()).toBe(1);
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

  test("a documented no-[DONE] DeepSeek stream relays live and closes with a synthesized [DONE]", async () => {
    // DeepSeek's Responses guide: the stream ends with response.completed /
    // response.incomplete / response.failed — "there is no data: [DONE] message."
    // The relay's terminal boundary must close on the terminal event and append
    // the conventional sentinel itself.
    const upstreamFrames = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_ds", status: "in_progress", output: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: "{\"q\":\"docs\"}", status: "completed" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_ds", status: "completed", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: "{\"q\":\"docs\"}", status: "completed" }] } })}\n\n`,
      // No data: [DONE] — and the connection stays open like a lazy gateway.
    ];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      expect(body.stream).toBe(true);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of upstreamFrames) controller.enqueue(encoder.encode(frame));
          // Deliberately never controller.close(): the terminal boundary must cut it.
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const deadline = AbortSignal.timeout(5_000);
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: deadline },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const sequence = [...text.matchAll(/"type":"(response\.[^"]+)"/g)].map(match => match[1]);
    expect(sequence).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(text).toContain("data: [DONE]");
    // The function-call item survives with id/call_id byte-identical.
    expect(text).toContain('"fc_1"');
    expect(text).toContain('"call_1"');
  });

  test("a streamed DeepSeek turn repairs UUID item ids on the live SSE path (#938)", async () => {
    // Integration proof for the STREAMING id-repair path (relay rewrite), which the
    // bounded-JSON era never exercised end to end: UUID output_item.added → delta →
    // terminal snapshot, no [DONE]; canonical msg_/rs_ ids must reach the client.
    const UUID_MSG = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const UUID_RS = "1b9d6bcd-bbfd-4b2d-9b9d-5c0a2fb41a1b";
    const upstreamFrames = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_ds", status: "in_progress", output: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: UUID_RS, summary: [] } })}\n\n`,
      // DeepSeek wraps streamed reasoning in content parts; content_part.* is mapped
      // as a "message" event type, so this only repairs through the cross-table
      // fallback (the live-probe leak this test pins).
      `data: ${JSON.stringify({ type: "response.content_part.added", item_id: UUID_RS, output_index: 0, content_index: 0, part: { type: "reasoning_text", text: "" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: UUID_MSG, role: "assistant", status: "in_progress", content: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: UUID_MSG, output_index: 1, delta: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_ds", status: "completed", output: [
        { type: "reasoning", id: UUID_RS, summary: [] },
        { type: "message", id: UUID_MSG, role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
      ] } })}\n\n`,
    ];
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of upstreamFrames) controller.enqueue(encoder.encode(frame));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    // The plain provider seed carries no explicit repair config; the registry's
    // { repairInvalidIds: true } policy must reach the live route via backfill.
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { abortSignal: AbortSignal.timeout(5_000) },
    );
    const text = await response.text();
    expect(text).not.toContain(UUID_MSG);
    expect(text).not.toContain(UUID_RS);
    expect(text).toMatch(/"id":"msg_ocx_[0-9a-f]+/);
    expect(text).toMatch(/"id":"rs_ocx_[0-9a-f]+/);
    expect(text).toContain("data: [DONE]");
  });

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

});

/**
 * Bounded-JSON reliability mechanism (#875) — deepseek no longer opts in, so these
 * tests keep the mechanism reachable through a synthetic registry entry. The knob
 * is deliberately retained as a one-line rollback for public-beta upstreams; if it
 * ever loses all users AND this fixture, delete the mechanism itself.
 */
describe("the bounded-JSON mechanism stays alive behind a synthetic registry entry", () => {
  const originalFetch = globalThis.fetch;
  const FIXTURE_ID = "bounded-json-fixture";
  const FIXTURE_MODEL = "fixture-model";
  const FIXTURE_BASE = "https://bounded-json.fixture.example";
  const mutableRegistry = PROVIDER_REGISTRY as unknown as Array<Record<string, unknown>>;

  beforeEach(() => {
    mutableRegistry.push({
      id: FIXTURE_ID,
      label: "Bounded JSON fixture",
      baseUrl: FIXTURE_BASE,
      adapter: "openai-responses",
      authKind: "key",
      models: [FIXTURE_MODEL],
      defaultModel: FIXTURE_MODEL,
      modelResponsesUpstreamStreaming: { [FIXTURE_MODEL]: false },
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    const index = mutableRegistry.findIndex(entry => entry.id === FIXTURE_ID);
    if (index >= 0) mutableRegistry.splice(index, 1);
  });

  function fixtureProvider(overrides?: Partial<OcxProviderConfig>): OcxProviderConfig {
    return {
      adapter: "openai-responses",
      baseUrl: FIXTURE_BASE,
      authMode: "key",
      apiKey: "sk-test",
      models: [FIXTURE_MODEL],
      ...overrides,
    } as OcxProviderConfig;
  }

  function repairingFixtureProvider(): OcxProviderConfig {
    return fixtureProvider({
      responsesItemIdRepair: { message: ["msg_placeholder"], reasoning: ["rs_placeholder"] },
    } as Partial<OcxProviderConfig>);
  }

  function completedWithPlaceholderIds(): Response {
    return Response.json({
      id: "resp_fixture",
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

  async function driveFixture(
    provider: OcxProviderConfig,
    options: { stream?: boolean; websocket?: boolean } = {},
  ): Promise<Response> {
    const config = { providers: { [FIXTURE_ID]: provider } } as unknown as OcxConfig;
    return handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: `${FIXTURE_ID}/${FIXTURE_MODEL}`,
          input: "ping",
          ...(options.stream === false ? {} : { stream: true }),
        }),
      }),
      config,
      { model: "", provider: "" },
      {
        ...(options.websocket ? { inboundWire: "responses" as const, inboundTransport: "websocket" as const } : { abortSignal: AbortSignal.timeout(5_000) }),
      },
    );
  }

  test("an opted-in model gets stream:false upstream and a synthesized terminal SSE", async () => {
    const captured: Array<{ stream?: boolean }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean });
      return completedWithPlaceholderIds();
    }) as typeof fetch;
    const response = await driveFixture(fixtureProvider());
    expect(captured[0]?.stream).toBe(false);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"type":"response.completed"');
  });

  test("the synthesized terminal SSE carries repaired item ids, not the upstream placeholders", async () => {
    globalThis.fetch = (async () => completedWithPlaceholderIds()) as typeof fetch;
    const response = await driveFixture(repairingFixtureProvider());
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).not.toContain("msg_placeholder");
    expect(text).not.toContain("rs_placeholder");
    expect(text).toMatch(/"id":"msg_ocx_[0-9a-f]{8}/);
    expect(text).toMatch(/"id":"rs_ocx_[0-9a-f]{8}/);
  });

  test("an over-cap HTTP synthesis fails closed with 502", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "resp_fixture",
      object: "response",
      status: "completed",
      output: Array.from({ length: MAX_SYNTHESIZED_OUTPUT_ITEMS + 1 }, () => null),
    })) as typeof fetch;
    const response = await driveFixture(fixtureProvider());
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    const body = JSON.parse(text) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("server_error");
    expect(body.error?.message).toContain("synthesized SSE item limit");
    expect(text).not.toContain("data: [DONE]");
  });

  test("the WebSocket bounded-JSON reframe carries the same repaired ids", async () => {
    globalThis.fetch = (async () => completedWithPlaceholderIds()) as typeof fetch;
    const response = await driveFixture(repairingFixtureProvider(), { websocket: true });
    const text = await response.text();
    expect(text).not.toContain("msg_placeholder");
    expect(text).not.toContain("rs_placeholder");
    expect(text).toMatch(/"id":"msg_ocx_[0-9a-f]{8}/);
  });

  test("a provider without id repair keeps the bounded-JSON body byte-identical", async () => {
    globalThis.fetch = (async () => completedWithPlaceholderIds()) as typeof fetch;
    const response = await driveFixture(fixtureProvider(), { websocket: true, stream: false });
    const text = await response.text();
    expect(text).toContain("msg_placeholder");
    expect(text).toContain("rs_placeholder");
  });

  test("an oversized upstream JSON body fails closed instead of buffering without limit", async () => {
    // The bounded-JSON path materializes the whole body, so the read must have a
    // hard byte ceiling. 33 MiB is one MiB over MAX_UPSTREAM_JSON_BODY_BYTES.
    globalThis.fetch = (async () => new Response(" ".repeat(33 * 1024 * 1024), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const response = await driveFixture(fixtureProvider(), { websocket: true });
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
    expect(providerConfigSeed(getProviderRegistryEntry("deepseek")!).requiresAdjacentResponsesToolResults).toBe(true);
    expect(providerConfigSeed(getProviderRegistryEntry("cerebras")!).statelessResponses).toBeUndefined();
    expect(providerConfigSeed(getProviderRegistryEntry("cerebras")!).requiresAdjacentResponsesToolResults).toBeUndefined();

    const stale = deepseekProvider();
    delete stale.requiresAdjacentResponsesToolResults;
    enrichProviderFromRegistry("deepseek", stale);
    expect(stale.requiresAdjacentResponsesToolResults).toBe(true);
  });

  test("DeepSeek makes a matched tool result adjacent without dropping injected developer context", () => {
    const call = { type: "function_call", call_id: "call_plan", name: "shell_command", arguments: "{}" };
    const injected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[planning-with-files] ACTIVE PLAN" }],
    };
    const output = { type: "function_call_output", call_id: "call_plan", output: "Exit code: 0" };
    const tail = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };

    const body = buildBody(deepseekProvider(), { input: [call, injected, output, tail] }) as { input: unknown[] };
    expect(body.input).toEqual([call, output, injected, tail]);
  });

  test("DeepSeek keeps a parallel call batch attached to one reasoning turn", () => {
    const reasoning = {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "read both files" }],
      summary: [],
    };
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{}" };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };

    const body = buildBody(deepseekReasoningProvider(), {
      input: [reasoning, callA, callB, outputA, outputB],
    }) as { input: unknown[] };
    expect(body.input).toEqual([reasoning, callA, callB, outputA, outputB]);
  });

  test("DeepSeek moves injected context after the complete parallel call and result batches", () => {
    const reasoning = {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "read both files" }],
      summary: [],
    };
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{}" };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };
    const injected = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "[planning-with-files] ACTIVE PLAN" }],
    };
    const tail = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };

    const body = buildBody(deepseekReasoningProvider(), {
      input: [reasoning, callA, injected, callB, outputA, outputB, tail],
    }) as { input: unknown[] };
    expect(body.input).toEqual([
      reasoning,
      callA,
      callB,
      outputA,
      outputB,
      injected,
      tail,
    ]);
  });

  test("DeepSeek keeps sequential reasoning and tool rounds separate", () => {
    const reasoningA = {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "first" }],
      summary: [],
    };
    const reasoningB = {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "second" }],
      summary: [],
    };
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{}" };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };

    const body = buildBody(deepseekReasoningProvider(), {
      input: [reasoningA, callA, outputA, reasoningB, callB, outputB],
    }) as { input: unknown[] };
    expect(body.input).toEqual([reasoningA, callA, outputA, reasoningB, callB, outputB]);
  });

  test("DeepSeek leaves duplicate call ids unchanged rather than guessing a batch", () => {
    const uniqueCall = { type: "function_call", call_id: "call_unique", name: "unique", arguments: "{}" };
    const uniqueOutput = { type: "function_call_output", call_id: "call_unique", output: "unique" };
    const firstCall = { type: "function_call", call_id: "call_dup", name: "first", arguments: "{}" };
    const secondCall = { type: "function_call", call_id: "call_dup", name: "second", arguments: "{}" };
    const injected = { type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] };
    const output = { type: "function_call_output", call_id: "call_dup", output: "ambiguous" };
    const input = [uniqueCall, injected, uniqueOutput, firstCall, secondCall, output];

    const body = buildBody(deepseekProvider(), { input }) as { input: unknown[] };
    expect(body.input).toEqual(input);
  });

  test("DeepSeek synthesizes a placeholder result when a collected call has no matching result", () => {
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{}" };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };
    const injected = { type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] };
    const input = [callA, callB, injected, outputB];

    const body = buildBody(deepseekProvider(), { input }) as { input: unknown[] };
    const repaired = body.input as Array<Record<string, unknown>>;
    // The parallel call batch stays contiguous: the synthetic output for call_a is
    // emitted after call_b, and the injected context moves after the whole batch.
    expect(repaired[0]).toMatchObject({ type: "function_call", call_id: "call_a" });
    expect(repaired[1]).toMatchObject({ type: "function_call", call_id: "call_b" });
    const synthesized = repaired[2] as Record<string, unknown>;
    expect(synthesized.type).toBe("function_call_output");
    expect(synthesized.call_id).toBe("call_a");
    expect(String(synthesized.output)).toContain("no tool result was recorded");
    // The real result for call_b survives untouched.
    expect(repaired[3]).toMatchObject({ type: "function_call_output", call_id: "call_b", output: "B" });
    expect(repaired[4]).toMatchObject({ type: "message", role: "developer" });
  });

  test("DeepSeek fails closed when a collected call/result pair is backwards", () => {
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{}" };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const input = [callB, callA, outputB, outputA];

    const body = buildBody(deepseekProvider(), { input }) as { input: unknown[] };
    expect(body.input).toEqual(input);
  });
  test("DeepSeek leaves reversed outputs in their original order", () => {
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const callB = { type: "function_call", call_id: "call_b", name: "read_file", arguments: "{}" };
    const outputB = { type: "function_call_output", call_id: "call_b", output: "B" };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const injected = { type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] };
    const input = [callA, callB, injected, outputB, outputA];

    const body = buildBody(deepseekProvider(), { input }) as { input: unknown[] };
    expect(body.input).toEqual(input);
  });

  test("DeepSeek keeps a valid pair in order when an unrelated output has no matching call", () => {
    // The orphan-output repair runs before the normalizer and flattens the unmatched
    // tool result into a user message, so the matched pair is still normalized and the
    // unmatchable output is never forwarded as a raw tool output.
    const callA = { type: "function_call", call_id: "call_a", name: "read_file", arguments: "{}" };
    const outputA = { type: "function_call_output", call_id: "call_a", output: "A" };
    const injected = { type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] };
    const orphanOutput = { type: "function_call_output", call_id: "call_orphan", output: "orphan" };
    const tail = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };
    const input = [callA, injected, outputA, orphanOutput, tail];

    const body = buildBody(deepseekProvider(), { input }) as { input: unknown[] };
    expect(body.input[0]).toEqual(callA);
    expect(body.input[1]).toEqual(outputA);
    expect(body.input).toContainEqual(injected);
    expect(body.input).toContainEqual(tail);
    expect(body.input.some(item => item.type === "function_call_output")).toBe(true);
    // The orphan output must not be forwarded raw; it is flattened into a user message.
    expect(body.input.some(item => item.type === "function_call_output" && item.call_id === "call_orphan")).toBe(false);
  });


  test("tolerant Responses providers keep interleaved tool history unchanged", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      authMode: "key",
      apiKey: "sk-test",
    };
    const input = [
      { type: "function_call", call_id: "call_plan", name: "shell_command", arguments: "{}" },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "plan" }] },
      { type: "function_call_output", call_id: "call_plan", output: "done" },
    ];

    const body = buildBody(provider, { input }) as { input: unknown[] };
    expect(body.input).toEqual(input);
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

  describe("Custom provider Responses terminal repair escape hatch (#1809)", () => {
    test("custom provider opts into default 500ms terminal repair via modelResponsesCompatibility", () => {
      const customProv = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesCompatibility: {
          "My-Model": "terminal-repair" as const,
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "my-model")).toEqual({ graceMs: 500 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "MY-MODEL")).toEqual({ graceMs: 500 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "My-Model")).toEqual({ graceMs: 500 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "other-model")).toBeUndefined();
    });

    test("custom provider specifies explicit graceMs via modelResponsesTerminalRepair", () => {
      const customProv = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesTerminalRepair: {
          "Model-Num": 1500,
          "Model-Obj": { graceMs: 2000 },
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "model-num")).toEqual({ graceMs: 1500 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "MODEL-NUM")).toEqual({ graceMs: 1500 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "model-obj")).toEqual({ graceMs: 2000 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "MODEL-OBJ")).toEqual({ graceMs: 2000 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProv, "unconfigured")).toBeUndefined();
    });

    test("custom provider specifies provider-level responsesTerminalRepair", () => {
      const customProvString = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        responsesTerminalRepair: "terminal-repair" as const,
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProvString, "any-model")).toEqual({ graceMs: 500 });

      const customProvNumber = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        responsesTerminalRepair: 750,
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", customProvNumber, "any-model")).toEqual({ graceMs: 750 });
    });

    test("rejects repair for non-responses wires even when compatibility is set", () => {
      const chatProv = {
        adapter: "openai-chat",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesCompatibility: {
          "my-model": "terminal-repair" as const,
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", chatProv, "my-model")).toBeUndefined();
    });

    test("respects per-model modelAdapters overrides", () => {
      const hybridProv = {
        adapter: "openai-chat",
        baseUrl: "https://custom-gateway.test/v1",
        modelAdapters: {
          "responses-model": "openai-responses",
        },
        modelResponsesCompatibility: {
          "responses-model": "terminal-repair" as const,
          "chat-model": "terminal-repair" as const,
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", hybridProv, "responses-model")).toEqual({ graceMs: 500 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", hybridProv, "chat-model")).toBeUndefined();
    });

    test("fails closed on non-positive or invalid grace values", () => {
      const invalidProv = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        responsesTerminalRepair: 750,
        modelResponsesTerminalRepair: {
          "zero-grace": 0,
          "neg-grace": -500,
          "nan-grace": NaN,
        },
        modelResponsesCompatibility: {
          "compat-zero": "terminal-repair" as const,
          "compat-neg": "terminal-repair" as const,
          "compat-nan": "terminal-repair" as const,
        },
      };
      const invalidCompatProv = {
        ...invalidProv,
        modelResponsesTerminalRepair: {
          "compat-zero": 0,
          "compat-neg": -500,
          "compat-nan": NaN,
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", invalidProv, "zero-grace")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", invalidProv, "neg-grace")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", invalidProv, "nan-grace")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", invalidCompatProv, "compat-zero")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", invalidCompatProv, "compat-neg")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", invalidCompatProv, "compat-nan")).toBeUndefined();
    });

    test("canonical ChatGPT forward provider never undergoes terminal repair", () => {
      const canonicalOpenAi = {
        adapter: "openai-responses",
        authMode: "forward" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        responsesTerminalRepair: "terminal-repair" as const,
        modelResponsesTerminalRepair: { "gpt-5": 1000 },
        modelResponsesCompatibility: { "gpt-5": "terminal-repair" as const },
      };
      expect(providerModelResponsesTerminalRepair("openai", canonicalOpenAi, "gpt-5")).toBeUndefined();
    });

    test("duplicate case-folded keys fail closed on ambiguity", () => {
      const conflictProv = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesTerminalRepair: {
          "My-Model": 500,
          "my-model": 1500,
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", conflictProv, "My-Model")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", conflictProv, "my-model")).toBeUndefined();
      expect(providerModelResponsesTerminalRepair("custom-gateway", conflictProv, "MY-MODEL")).toBeUndefined();
    });

    test("clamps grace period to maximum 60,000 ms", () => {
      const hugeProv = {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesTerminalRepair: {
          "huge-model": 120_000,
          "max-safe": Number.MAX_SAFE_INTEGER,
        },
      };
      expect(providerModelResponsesTerminalRepair("custom-gateway", hugeProv, "huge-model")).toEqual({ graceMs: 60_000 });
      expect(providerModelResponsesTerminalRepair("custom-gateway", hugeProv, "max-safe")).toEqual({ graceMs: 60_000 });
    });

    test("safeConfigDTO preserves terminal-repair configuration keys", () => {
      const config: OcxConfig = {
        providers: {
          "custom-gw": {
            adapter: "openai-responses",
            baseUrl: "https://custom-gateway.test/v1",
            modelResponsesCompatibility: { "my-model": "terminal-repair" },
            modelResponsesTerminalRepair: { "my-model": 1500 },
            responsesTerminalRepair: { graceMs: 800 },
          },
        },
      } as unknown as OcxConfig;
      const dto = safeConfigDTO(config) as { providers: Record<string, Record<string, unknown>> };
      expect(dto.providers["custom-gw"].modelResponsesCompatibility).toEqual({ "my-model": "terminal-repair" });
      expect(dto.providers["custom-gw"].modelResponsesTerminalRepair).toEqual({ "my-model": 1500 });
      expect(dto.providers["custom-gw"].responsesTerminalRepair).toEqual({ graceMs: 800 });
    });

    test("providerManagementConfigError validates terminal-repair configuration", () => {
      expect(providerManagementConfigError("custom-gw", {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesCompatibility: { "my-model": "terminal-repair" },
        modelResponsesTerminalRepair: { "my-model": 1500 },
        responsesTerminalRepair: 800,
      })).toBeNull();

      expect(providerManagementConfigError("custom-gw", {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        modelResponsesCompatibility: { "my-model": "invalid" },
      })).toContain('modelResponsesCompatibility.my-model must be "terminal-repair"');

      expect(providerManagementConfigError("custom-gw", {
        adapter: "openai-responses",
        baseUrl: "https://custom-gateway.test/v1",
        responsesTerminalRepair: -500,
      })).toContain('responsesTerminalRepair must be "terminal-repair", a positive number');

      const canonicalOpenAi = {
        adapter: "openai-responses",
        authMode: "forward",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      };
      expect(responsesTerminalRepairConfigError("terminal-repair", "responsesTerminalRepair", "openai", canonicalOpenAi))
        .toContain("responsesTerminalRepair is not supported on the canonical ChatGPT forward provider");
      expect(modelResponsesCompatibilityConfigError({ "gpt-5": "terminal-repair" }, "modelResponsesCompatibility", "openai", canonicalOpenAi))
        .toContain("modelResponsesCompatibility is not supported on the canonical ChatGPT forward provider");
      expect(modelResponsesTerminalRepairConfigError({ "gpt-5": 500 }, "modelResponsesTerminalRepair", "openai", canonicalOpenAi))
        .toContain("modelResponsesTerminalRepair is not supported on the canonical ChatGPT forward provider");
    });
  });
});
