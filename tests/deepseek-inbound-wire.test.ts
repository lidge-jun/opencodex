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
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry, providerModelResponsesUpstreamStreaming, PROVIDER_REGISTRY } from "../src/providers/registry";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
import { MAX_SYNTHESIZED_OUTPUT_ITEMS } from "../src/server/responses-json-events";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const MODEL = "deepseek-v4-flash";

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

  test("an explicit true config value overrides a false registry default", async () => {
    const provider = fixtureProvider({ modelResponsesUpstreamStreaming: { [FIXTURE_MODEL]: true } });
    expect(providerModelResponsesUpstreamStreaming(FIXTURE_ID, provider, FIXTURE_MODEL)).toBe(true);
    const captured: Array<{ stream?: boolean }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean });
      return completedWithPlaceholderIds();
    }) as typeof fetch;
    const response = await driveFixture(provider);
    expect(captured[0]?.stream).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("the policy lookup is case-insensitive exact and does not inherit colon families", () => {
    const provider = fixtureProvider({
      modelResponsesUpstreamStreaming: { "FIXTURE-MODEL": false },
    });
    expect(providerModelResponsesUpstreamStreaming(FIXTURE_ID, provider, "fixture-model")).toBe(false);
    expect(providerModelResponsesUpstreamStreaming(FIXTURE_ID, provider, "fixture-model:variant")).toBeUndefined();
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
      output: Array.from(
        { length: MAX_SYNTHESIZED_OUTPUT_ITEMS + 1 },
        (_, index) => ({ type: "message", id: `msg_${index}` }),
      ),
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

describe("custom providers can opt into the bounded-JSON Responses path", () => {
  const originalFetch = globalThis.fetch;
  const PROVIDER = "custom-bounded-responses";
  const MODEL_ID = "fixture-model";

  afterEach(() => { globalThis.fetch = originalFetch; });

  function customProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
    return {
      adapter: "openai-responses",
      baseUrl: "https://custom-bounded.example.test/v1",
      authMode: "key",
      apiKey: "sk-test",
      modelResponsesUpstreamStreaming: { "FIXTURE-MODEL": false },
      ...overrides,
    };
  }

  async function drive(
    provider: OcxProviderConfig,
    websocket = false,
    abortSignal: AbortSignal = AbortSignal.timeout(5_000),
  ): Promise<Response> {
    return handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${PROVIDER}/${MODEL_ID}`, input: "ping", stream: true }),
      }),
      { providers: { [PROVIDER]: provider } } as unknown as OcxConfig,
      { model: "", provider: "" },
      websocket
        ? { inboundWire: "responses", inboundTransport: "websocket" }
        : { abortSignal },
    );
  }

  test("a case-insensitive config match changes only upstream stream and synthesizes HTTP SSE", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({
        id: "resp_custom",
        object: "response",
        status: "completed",
        output: [{
          id: "msg_custom",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await drive(customProvider());
    expect(captured).toHaveLength(1);
    expect(captured[0]?.stream).toBe(false);
    expect(captured[0]?.model).toBe(MODEL_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text.match(/"type":"response\.created"/g)).toHaveLength(1);
    expect(text.match(/"type":"response\.output_item\.done"/g)).toHaveLength(1);
    expect(text.match(/"type":"response\.completed"/g)).toHaveLength(1);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("failed and incomplete terminal statuses survive HTTP synthesis", async () => {
    for (const status of ["failed", "incomplete"] as const) {
      globalThis.fetch = (async () => Response.json({
        id: `resp_${status}`,
        object: "response",
        status,
        output: [],
        ...(status === "failed"
          ? { error: { code: "upstream_failure", message: "fixture" } }
          : { incomplete_details: { reason: "max_output_tokens" } }),
      })) as typeof fetch;
      const response = await drive(customProvider());
      const text = await response.text();
      expect(text).toContain(`"type":"response.${status}"`);
      expect(text).not.toContain('"type":"response.completed"');
    }
  });

  test("an upstream SSE that ignores stream:false fails once without entering tee", async () => {
    let calls = 0;
    let cancelled = false;
    let aborted = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'));
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const response = await Promise.race([
      drive(customProvider()),
      Bun.sleep(250).then(() => { throw new Error("bounded policy waited for body cancellation"); }),
    ]);
    expect(response.status).toBe(502);
    expect(calls).toBe(1);
    expect(aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(await response.text()).not.toContain("response.completed");
  });

  test("malformed terminal JSON fails closed for HTTP and WebSocket handoff", async () => {
    for (const websocket of [false, true]) {
      globalThis.fetch = (async () => Response.json({
        id: "resp_invalid",
        object: "response",
        status: "still_running",
        output: [],
      })) as typeof fetch;
      const response = await drive(customProvider(), websocket);
      expect(response.status).toBe(502);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).toContain("terminal status");
    }
  });

  test("snapshot repair cannot promote a malformed bounded response to completed", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "resp_invalid",
      object: "response",
    })) as typeof fetch;
    const response = await drive(customProvider({ responsesSnapshotRepair: true }));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("terminal status");
  });

  test("a per-model Responses wire override is settled before the policy", async () => {
    const captured: Array<{ stream?: boolean }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean });
      return Response.json({ id: "resp_mixed", status: "completed", output: [] });
    }) as typeof fetch;
    const response = await drive(customProvider({
      adapter: "openai-chat",
      modelAdapters: { [MODEL_ID]: "openai-responses" },
    }));
    expect(response.status).toBe(200);
    expect(captured[0]?.stream).toBe(false);
    expect(await response.text()).toContain('"type":"response.completed"');
  });

  test("client cancellation aborts a pending bounded JSON read", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const controller = new AbortController();
    const pending = drive(customProvider(), false, controller.signal);
    await Bun.sleep(5);
    controller.abort(new DOMException("fixture cancel", "AbortError"));
    const response = await pending;
    expect(response.status).toBe(499);
    expect(cancelled).toBe(true);
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
});
