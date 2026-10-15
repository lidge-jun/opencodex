import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../src/adapters/google";
import { providerConfigSeed } from "../../src/providers/derive";
import { fastPolicyForModel } from "../../src/providers/service-tier";
import { isOpenCodeGoGeminiDestination } from "../../src/types/opencode-go";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { captureRouteStaticPolicy, routedProviderConfig } from "../../src/router";
import { buildProtocolProviderSummary } from "../../src/protocols/provider-summary";
import { parseRequest } from "../../src/responses/parser";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED, type OcxConfig, type OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const MODEL = "gemini-4-argon-contributor";
const ENDPOINT = `https://opencode.ai/inference/go/v1/models/${MODEL}`;
const BASES = ["https://opencode.ai/zen/go/v1", "https://opencode.ai/inference/go/v1", "https://custom.invalid/v1"];
const SIGNATURE = "synthetic-gemini-thought-signature-for-tool-continuation";

/** Build a synthetic URL with embedded credentials to exercise the destination rejection. */
function endpointWithUserInfo(): string {
  const url = new URL(BASES[0]!);
  url.username = "test";
  url.password = "test";
  return url.href;
}

/** Seed the canonical Go fixture, with overrides for destination and authentication cases. */
function go(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("opencode-go")!), apiKey: "test-key", ...overrides };
}

describe("OpenCode Go Gemini wire (#7097)", () => {
  test("runtime, static policy, Fast and protocol summary agree on the exact pin", () => {
    for (const baseUrl of BASES) {
      const configured = go({ baseUrl, modelAdapters: { [MODEL]: "openai-responses" } });
      expect(captureRouteStaticPolicy("opencode-go", MODEL, configured).model.adapter).toBe("google");
      expect(fastPolicyForModel(configured, MODEL, "opencode-go").adapter).toBe("google");
      const provider = routedProviderConfig("opencode-go", configured);
      expect(provider.baseUrl).toBe(BASES[0]!);
      for (const inbound of ["responses", "chat", "anthropic"] as const) {
        const policy = captureRouteStaticPolicy("opencode-go", MODEL, provider, undefined, inbound);
        expect(policy.model.adapter).toBe("google");
        expect(policy.provenance.model.adapter).toBe("hard-pin");
        const resolved = resolveWireProtocolOverride("opencode-go", MODEL, provider, inbound);
        expect(resolved.adapter).toBe("google");
        expect(resolveWireProtocolOverride("opencode-go", MODEL, resolved, inbound).adapter).toBe("google");
        expect(fastPolicyForModel(provider, MODEL, "opencode-go", inbound).adapter).toBe("google");
      }
      const summary = buildProtocolProviderSummary({ providers: { "opencode-go": go({ baseUrl, models: [] }) } } as OcxConfig, "opencode-go");
      expect(summary?.modelOverrides).toContainEqual({ model: MODEL, adapter: "google", source: "hard-pin" });
    }
    expect(MODEL_ADAPTER_OVERRIDE_ALLOWED.has("google")).toBe(false);
  });

  test("sibling models and another provider name keep their existing wires", () => {
    for (const [model, adapter] of [
      ["glm-5.2", "openai-chat"], ["gpt-5.6-luna", "openai-responses"],
      ["muse-spark-1.3-contributor", "openai-responses"], ["minimax-m3", "anthropic"],
      ["claude-haiku-5-5", "anthropic"], ["gemini-future", "openai-chat"],
    ]) expect(resolveWireProtocolOverride("opencode-go", model!, go()).adapter).toBe(adapter!);
    expect(resolveWireProtocolOverride("custom-go", MODEL, go()).adapter).toBe("openai-chat");
  });

  test.each([
    { baseUrl: "https://custom.invalid/v1" },
    { baseUrl: "https://opencode.ai.evil.invalid/zen/go/v1" },
    { baseUrl: "https://opencode.ai/zen/v1" },
    { baseUrl: "https://opencode.ai/zen/go/v1?key=fixture" },
    { baseUrl: "https://opencode.ai/zen/go/v1#fragment" },
    { baseUrl: endpointWithUserInfo() },
    { baseUrl: "http://opencode.ai/zen/go/v1" },
    { baseUrl: "https://opencode.ai:8443/zen/go/v1" },
    { authMode: "oauth" }, { authMode: "forward" },
    { googleMode: "vertex" }, { googleMode: "cloud-code-assist" },
  ] satisfies Partial<OcxProviderConfig>[])("does not pin an unrelated destination or auth mode: %j", overrides => {
    const provider = go(overrides);
    expect(isOpenCodeGoGeminiDestination(provider)).toBe(false);
    const name = overrides.baseUrl ? "custom-go" : "opencode-go";
    expect(resolveWireProtocolOverride(name, MODEL, provider).adapter).toBe("openai-chat");
    expect(captureRouteStaticPolicy(name, MODEL, provider).model.adapter).not.toBe("google");
    expect(fastPolicyForModel(provider, MODEL, name).adapter).not.toBe("google");
    if (overrides.baseUrl) expect(routedProviderConfig(name, provider).baseUrl).toBe(overrides.baseUrl);
  });

  test("AI Studio keeps its own endpoint and API-key header", async () => {
    const adapter = withTestTranslatorBudget(createGoogleAdapter({
      adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "studio-key",
    }));
    const request = await adapter.buildRequest(parseRequest({ model: MODEL, input: "ping", stream: false }));
    expect(request.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("studio-key");
    expect(new Headers(request.headers).has("authorization")).toBe(false);
    await expect(withTestTranslatorBudget(createGoogleAdapter({
      adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: " ",
    })).buildRequest(parseRequest({ model: MODEL, input: "ping" })))
      .rejects.toThrow("google (AI Studio) requires a non-empty API key");
  });

  test("Go normalizes endpoint spelling, owns its key header, and preserves an explicit session", async () => {
    const provider = go({ baseUrl: " https://OPENCODE.AI:443/zen/go/v1/// ", headers: {
      authorization: "Bearer stale-fixture", "X-Goog-Api-Key": "stale-fixture", "X-Opencode-Session": "operator-session",
    } });
    const resolved = resolveWireProtocolOverride("opencode-go", MODEL, provider);
    expect(resolved.adapter).toBe("google");
    const adapter = withTestTranslatorBudget(createGoogleAdapter(resolved));
    const request = await adapter.buildRequest(parseRequest({ model: MODEL, input: "ping", stream: false }));
    expect(request.url).toBe(`${ENDPOINT}:generateContent`);
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.has("x-goog-api-key")).toBe(false);
    expect(headers.get("x-opencode-session")).toBe("operator-session");
    await expect(withTestTranslatorBudget(createGoogleAdapter({ ...resolved, apiKey: " " }))
      .buildRequest(parseRequest({ model: MODEL, input: "ping" }))).rejects.toThrow("OpenCode Go requires a non-empty API key");
  });
});

describe("OpenCode Go Gemini Responses dispatch", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;
  afterEach(() => { globalThis.fetch = originalFetch; releaseSpendHome?.(); releaseSpendHome = undefined; });

  for (const baseUrl of BASES) for (const stream of [false, true]) {
    test(`Gemini request, completion and tool continuation (${baseUrl}, stream=${stream})`, async () => {
      releaseSpendHome = acquireOwnedSpendHome();
      const requests: Array<{ url: string; headers: Headers; body: any }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        const parts = requests.length === 1
          ? [{ functionCall: { id: "call_probe", name: "probe", args: { path: "src" } }, thoughtSignature: SIGNATURE }]
          : [{ text: "Done" }];
        const body = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } };
        return stream
          ? new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { "content-type": "text/event-stream" } })
          : Response.json(body);
      }) as typeof fetch;
      const config = { providers: { "opencode-go": go({ baseUrl }) } } as OcxConfig;
      /** Dispatch one turn and return the completed Responses object from JSON or SSE. */
      const send = async (input: unknown[]) => {
        const response = await handleResponses(new Request("http://localhost/v1/responses", {
          method: "POST", headers: { "content-type": "application/json", "thread-id": "gemini-fixture-thread" },
          body: JSON.stringify({ model: `opencode-go/${MODEL}`, input, stream, store: false,
            reasoning: { effort: stream ? "xhigh" : "high" },
            tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: { path: { type: "string" } } } }],
          }),
        }), config, { model: "", provider: "" });
        expect(response.status).toBe(200);
        const text = await response.text();
        if (!stream) return JSON.parse(text);
        const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        expect(events.some(event => event.type === "response.failed" || event.type === "error")).toBe(false);
        return events.find(event => event.type === "response.completed")?.response;
      };
      const input = [{ role: "user", content: "Inspect src using probe" }];
      const first = await send(input);
      expect(first?.status).toBe("completed");
      const call = first.output.find((item: any) => item.type === "function_call");
      expect(call).toMatchObject({ name: "probe", arguments: '{"path":"src"}' });
      const second = await send([...input, ...first.output, { type: "function_call_output", call_id: call.call_id, output: "found files" }]);
      expect(second?.status).toBe("completed");
      expect(JSON.stringify(second.output)).toContain("Done");
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe(`${ENDPOINT}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        expect(request.headers.has("x-goog-api-key")).toBe(false);
        expect(request.headers.get("x-opencode-session")).toMatch(/^ocx_[a-f0-9]{32}$/);
        expect(request.body.contents[0]).toMatchObject({ role: "user" });
        expect(request.body.messages).toBeUndefined();
        expect(request.body.reasoning_effort).toBeUndefined();
        expect(request.body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
        expect(request.body.tools[0].functionDeclarations[0].name).toBe("probe");
      }
      expect(requests[1]!.headers.get("x-opencode-session")).toBe(requests[0]!.headers.get("x-opencode-session"));
      const contents = requests[1]!.body.contents;
      const callIndex = contents.findIndex((turn: any) => turn.parts.some((part: any) => part.functionCall));
      expect(contents[callIndex].parts[0]).toMatchObject({ functionCall: { name: "probe", args: { path: "src" } }, thoughtSignature: SIGNATURE });
      expect(contents[callIndex + 1].parts[0]).toMatchObject({ functionResponse: { name: "probe", response: { result: "found files" } } });
    });
  }

  test("a differently named custom provider sends its key only to its configured destination", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const requests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `custom-go/${MODEL}`, input: "ping", stream: false }),
    }), { providers: { "custom-go": { adapter: "openai-chat", baseUrl: "https://custom.invalid/v1", apiKey: "custom-key" } } } as OcxConfig,
    { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://custom.invalid/v1/chat/completions");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer custom-key");
    expect(requests[0]!.headers.has("x-opencode-session")).toBe(false);
  });
});
