/**
 * OpenCode Go is a mixed-wire provider. Its endpoint matrix assigns GPT 5.6 Luna
 * to Responses while its provider-wide default and most sibling models use Chat.
 * These tests protect both the exact-model correction and the explicit override
 * boundary that lets operators opt out if the upstream changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { parseRequest } from "../../src/responses/parser";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const MODEL = "gpt-5.6-luna";
const GO_RESPONSES_MODELS = [MODEL, "grok-4.6", "muse-spark-1.3-contributor"];

function opencodeGo(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key", ...overrides };
}

describe("OpenCode Go GPT 5.6 Luna wire selection (#1482)", () => {
  test("uses Responses from every inbound surface", () => {
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", MODEL, opencodeGo(), inbound).adapter)
        .toBe("openai-responses");
    }
  });

  test("an explicit Chat override wins from every inbound surface", () => {
    const provider = opencodeGo({ modelAdapters: { [MODEL]: "openai-chat" } });
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", MODEL, provider, inbound).adapter)
        .toBe("openai-chat");
    }
  });

  test("other OpenCode Go models keep their existing wire", () => {
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("opencode-go", "glm-5.2", opencodeGo(), inbound).adapter)
        .toBe("openai-chat");
    }
  });
});

describe("OpenCode Go stateless Responses", () => {
  test("seeds and backfills the canonical preset while preserving explicit false and custom names", () => {
    expect(opencodeGo().statelessResponses).toBe(true);
    const stale = opencodeGo();
    delete stale.statelessResponses;
    enrichProviderFromRegistry("opencode-go", stale);
    expect(stale.statelessResponses).toBe(true);
    const overridden = opencodeGo({ statelessResponses: false });
    enrichProviderFromRegistry("opencode-go", overridden);
    expect(overridden.statelessResponses).toBe(false);
    const renamed = opencodeGo();
    delete renamed.statelessResponses;
    enrichProviderFromRegistry("my-go", renamed);
    expect(renamed.statelessResponses).toBeUndefined();
    expect(providerConfigSeed(getProviderRegistryEntry("cerebras")!).statelessResponses).toBeUndefined();
  });

  test.each(GO_RESPONSES_MODELS)("%s repairs orphan calls/results and preserves paired results", model => {
    const input = [
      { type: "function_call", call_id: "call_done", name: "probe", arguments: "{}" },
      { type: "function_call", call_id: "call_missing", name: "probe", arguments: "{}" },
      { type: "function_call_output", call_id: "call_done", output: "actual result" },
      { type: "function_call_output", call_id: "call_unknown", output: "orphan result" },
    ];
    const raw = { model, input, previous_response_id: "resp_unrecorded_go", stream: true };
    const original = structuredClone(raw);
    for (const expanded of [false, true]) {
      const parsed = parseRequest(raw);
      parsed._previousResponseInputExpanded = expanded;
      const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
        ...opencodeGo(), adapter: "openai-responses",
      }));
      const sent = JSON.parse(adapter.buildRequest(parsed).body);
      expect(sent.previous_response_id).toBeUndefined();
      expect(sent.store).toBe(false);
      expect(sent.input).toEqual([
        input[0], input[1], input[2],
        expect.objectContaining({ type: "function_call_output", call_id: "call_missing", output: expect.stringContaining("no tool result was recorded") }),
        expect.objectContaining({ type: "message", role: "user", content: expect.any(Array) }),
      ]);
      expect(JSON.stringify(sent.input[4])).toContain("orphan result");
      expect(raw).toEqual(original);
    }
    const stateful = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      ...opencodeGo({ statelessResponses: false }), adapter: "openai-responses",
    }));
    const sent = JSON.parse(stateful.buildRequest(parseRequest(raw)).body);
    expect(sent.previous_response_id).toBe("resp_unrecorded_go");
    expect(sent.store).not.toBe(false);
    expect(sent.input).toEqual(input);
  });
});

describe("OpenCode Go stateless reasoning and continuation routes", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const continuations = [
    { id: "full", name: "full history", fullHistory: true, summary: "auto" },
    { id: "delta", name: "delta", fullHistory: false, summary: "auto" },
    { id: "hidden", name: "hidden-summary full history", fullHistory: true, summary: "none" },
  ];
  for (const model of GO_RESPONSES_MODELS) for (const streaming of [true, false]) for (const continuation of continuations) {
    test(`${model} preserves ${continuation.name} across two ${streaming ? "SSE" : "JSON"} turns`, async () => {
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      // Opaque synthetic provider state, never a real credential or decrypted task.
      const blob = "provider-minted-go-reasoning-state";
      const prefix = `${model.replaceAll(".", "_")}_${streaming ? "sse" : "json"}_${continuation.id}`;
      const reasoning = [
        { type: "reasoning", id: `rs_${prefix}_summary`, status: "completed", summary: [{ type: "summary_text", text: "Already summarized" }] },
        { type: "reasoning", id: `rs_${prefix}_content`, status: "completed", content: [{ type: "reasoning_text", text: "Visible thinking" }], summary: [] },
        { type: "reasoning", id: `rs_${prefix}_blob`, status: "completed", content: [{ type: "reasoning_text", text: "Opaque item trace" }], summary: [], encrypted_content: blob },
      ];
      const call = { type: "function_call", id: `fc_${prefix}`, status: "completed", call_id: `call_${prefix}`, name: "probe", arguments: "{}" };
      const priorMessage = { type: "message", id: `msg_${prefix}_prior`, status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "Probe requested", annotations: [] }],
      };
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
        const output = requests.length === 1 ? [...reasoning, call, priorMessage] : [{
          type: "message", id: `msg_${prefix}`, status: "completed", role: "assistant",
          content: [{ type: "output_text", text: "Continuation accepted", annotations: [] }],
        }];
        const response = { id: `resp_${prefix}_${requests.length}`, object: "response", status: "completed", model, output };
        if (!streaming) return Response.json(response);
        const payloads: Record<string, unknown>[] = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
        for (const [index, item] of output.entries()) {
          payloads.push({ type: "response.output_item.added", output_index: index, item });
          if (requests.length === 1 && index === 1) payloads.push({
            type: "response.reasoning_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: "Visible thinking",
          });
          payloads.push({ type: "response.output_item.done", output_index: index, item });
        }
        payloads.push({ type: "response.completed", response });
        return new Response(payloads.map((payload, sequence_number) =>
          `data: ${JSON.stringify({ ...payload, sequence_number })}\n\n`
        ).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;
      const config = { providers: { "opencode-go": opencodeGo() } } as unknown as OcxConfig;
      const drive = async (body: Record<string, unknown>) => {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: `opencode-go/${model}`, stream: streaming, reasoning: { summary: continuation.summary },
            tools: [{ type: "function", name: "probe", parameters: { type: "object" } }], ...body }),
        }), config, { model: "", provider: "" }, { inboundWire: "responses" });
        expect(response.status).toBe(200);
        const text = await response.text();
        if (!streaming) return { document: JSON.parse(text), text };
        const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const terminal = events.find(event => event.type === "response.completed");
        expect(terminal).toBeDefined();
        return { document: terminal.response, text };
      };
      const initial = { type: "message", role: "user", content: [{ type: "input_text", text: "Run probe" }] };
      const first = await drive({ input: [initial] });
      expect(first.document.output[0]).toEqual(reasoning[0]);
      expect(first.document.output[1]).toEqual(continuation.summary === "auto" ? {
        type: "reasoning", id: `rs_${prefix}_content`, status: "completed", summary: [{ type: "summary_text", text: "Visible thinking" }],
      } : reasoning[1]);
      expect(first.document.output[2]).toEqual(reasoning[2]);
      expect(first.document.output[3]).toMatchObject(call);
      expect(first.document.output[4]).toEqual(priorMessage);
      if (streaming) {
        const channel = continuation.summary === "auto" ? "reasoning_summary_text" : "reasoning_text";
        expect(first.text).toContain(`"type":"response.${channel}.delta"`);
      }
      const result = { type: "function_call_output", call_id: call.call_id, output: "probe succeeded" };
      // Echo exactly the client-visible history through handleResponses. An upstream-shape
      // cache would prepend it again after the content-to-summary rewrite (F1).
      const nextBody = {
        input: continuation.fullHistory ? [initial, ...first.document.output, result] : [result],
        previous_response_id: first.document.id, store: true,
        conversation: "conversation_fixture", background: true, metadata: { fixture: "go" }, prompt: { id: "prompt_fixture" },
      };
      const originalHistory = structuredClone(nextBody);
      const second = await drive(nextBody);
      for (const field of ["previous_response_id", "conversation", "background", "metadata", "prompt"]) {
        expect(requests[1]!.body[field]).toBeUndefined();
      }
      expect(nextBody).toEqual(originalHistory);
      expect(second.text).toContain("Continuation accepted");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe("https://opencode.ai/zen/go/v1/responses");
        expect(request.body.previous_response_id).toBeUndefined();
        expect(request.body.store).toBe(false);
        expect(request.body.stream).toBe(streaming);
      }
      const replay = requests[1]!.body.input as Array<Record<string, unknown>>;
      expect(replay.filter(item => item.type === "function_call")).toEqual([
        expect.objectContaining({ call_id: call.call_id, name: "probe", arguments: "{}" }),
      ]);
      expect(replay.filter(item => item.type === "function_call_output")).toEqual([result]);
      expect(replay.filter(item => item.type === "message" && item.role === "user")).toEqual([initial]);
      expect(replay.filter(item => item.type === "message" && item.role === "assistant")).toEqual([
        expect.objectContaining({ role: "assistant", content: priorMessage.content }),
      ]);
      expect(replay.filter(item => item.type === "reasoning")).toHaveLength(3);
      expect(replay).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: blob }));
      expect(JSON.stringify(replay)).toContain("Already summarized");
      if (continuation.summary === "auto") expect(replay).toContainEqual(expect.objectContaining({
        type: "reasoning", summary: [{ type: "summary_text", text: "Visible thinking" }],
      }));
      expect(JSON.stringify(replay)).not.toContain("no tool result was recorded");
    });
  }
});

describe("OpenCode Go Luna Responses route (#1482)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("handleResponses sends Luna to the documented /responses endpoint", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({
        id: "resp_opencode_go_luna",
        object: "response",
        status: "completed",
        output: [],
      });
    }) as typeof fetch;

    const config = {
      providers: { "opencode-go": opencodeGo() },
    } as unknown as OcxConfig;
    const response = await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `opencode-go/${MODEL}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://opencode.ai/zen/go/v1/responses");
    // The endpoint fix does not silently impose the separate bounded-JSON policy.
    expect(requests[0]?.body.stream).toBe(true);
  });
});
