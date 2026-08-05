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
import { getProviderRegistryEntry } from "../src/providers/registry";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";
import { handleResponses } from "../src/server/responses/core";
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

  test("a Codex WebSocket turn asks DeepSeek for bounded JSON upstream", async () => {
    const request = await drive("responses", "websocket");
    expect(request.url).toBe("https://api.deepseek.com/responses");
    expect(request.body.stream).toBe(false);
  });

  test("a Codex WebSocket turn keeps plain JSON downstream (no SSE synthesis)", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "resp_deepseek",
      object: "response",
      status: "completed",
      output: [],
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
      { inboundTransport: "websocket" },
    );
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
  });

  test("ordinary HTTP Responses requests also use bounded JSON upstream (#875)", async () => {
    // The reliability policy is transport-neutral: DeepSeek's Responses stream can
    // deliver output without a terminal, so HTTP turns get the same bounded JSON
    // upstream as WS turns — and a synthesized terminal SSE back.
    const request = await drive("responses");
    expect(request.body.stream).toBe(false);
  });

  test("an HTTP streaming client receives a synthesized terminal SSE instead of a stall (#875)", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      if (body.stream === true) {
        // Old world: a terminal-less SSE that never closes — the stall the issue
        // reported. The policy must never send stream:true, so fail loudly here.
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "resp_deepseek",
        object: "response",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "search",
          arguments: "{\"q\":\"docs\"}",
          status: "completed",
        }],
      });
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

  /**
   * Review finding on this layer: the bounded-JSON answer never touches the SSE
   * relay, so it never picks up the relay's item-id rewrite. Without the
   * normalization added here, enabling this reliability policy would silently
   * DISABLE id repair for a provider that has it configured — the client would
   * get canonical ids while streaming and placeholder ids the moment the policy
   * switched the upstream to bounded JSON.
   */
  function repairingProvider(): OcxProviderConfig {
    return {
      ...deepseekProvider(),
      responsesItemIdRepair: { message: ["msg_placeholder"], reasoning: ["rs_placeholder"] },
    } as OcxProviderConfig;
  }

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

  test("the synthesized terminal SSE carries repaired item ids, not the upstream placeholders", async () => {
    globalThis.fetch = (async () => completedWithPlaceholderIds()) as typeof fetch;
    const config = { providers: { deepseek: repairingProvider() } } as unknown as OcxConfig;
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
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).not.toContain("msg_placeholder");
    expect(text).not.toContain("rs_placeholder");
    expect(text).toMatch(/"id":"msg_ocx_[0-9a-f]{8}/);
    expect(text).toMatch(/"id":"rs_ocx_[0-9a-f]{8}/);
  });

  test("the WebSocket bounded-JSON reframe carries the same repaired ids", async () => {
    globalThis.fetch = (async () => completedWithPlaceholderIds()) as typeof fetch;
    const config = { providers: { deepseek: repairingProvider() } } as unknown as OcxConfig;
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
    const text = await response.text();
    expect(text).not.toContain("msg_placeholder");
    expect(text).not.toContain("rs_placeholder");
    expect(text).toMatch(/"id":"msg_ocx_[0-9a-f]{8}/);
  });

  test("a provider without id repair keeps the bounded-JSON body byte-identical", async () => {
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
    // Review finding: the WebSocket bounded-JSON path (and every non-streaming upstream)
    // materializes the whole body, so the read must have a hard byte ceiling. 33 MiB is
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
