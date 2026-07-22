import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { antigravitySessionId, isLikelyRealThoughtSignature } from "../src/adapters/google-antigravity-wire";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_MODEL_EFFORTS } from "../src/providers/antigravity-models";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(text = "hello world", stream = false, modelId = "gemini-3-pro"): OcxParsedRequest {
  return {
    modelId,
    stream,
    context: { messages: [{ role: "user", content: text }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

function parsedWithEffort(modelId: string, effort?: string): OcxParsedRequest {
  return {
    modelId,
    stream: false,
    context: { messages: [{ role: "user", content: "test" }], systemPrompt: [], tools: [] },
    options: effort ? { reasoning: effort } : {},
  } as unknown as OcxParsedRequest;
}

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
} as OcxProviderConfig;

const effortProvider = {
  ...provider,
  modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS,
} as OcxProviderConfig;

describe("antigravity CCA envelope", () => {
  test("wraps the gemini body in the CCA envelope with project/userAgent/requestType/requestId/sessionId", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    const env = JSON.parse(req.body);
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(env.model).toBe("gemini-3-pro");
    // The envelope BODY userAgent is the protocol constant; the versioned CLI UA rides in the header.
    expect(env.userAgent).toBe("antigravity");
    expect(env.requestType).toBe("agent");
    expect(env.project).toBe("proj-123");
    expect(env.requestId).toMatch(/^agent-/);
    expect(env.request.contents).toBeDefined();
    expect(env.request.sessionId).toMatch(/^-/);
    expect(env.request.model).toBeUndefined();
    expect(env.request.safetySettings).toBeUndefined();
    expect(req.headers["Authorization"]).toBe("Bearer ya29.token");
    expect(req.headers["User-Agent"]).toMatch(/^antigravity\/cli\/[\d.]+ \(aidev_client; os_type=\w+; arch=\w+\)$/);
    // The literal "antigravity" giveaway UA must no longer be sent.
    expect(req.headers["User-Agent"]).not.toBe("antigravity");
    // x-goog-api-client is NOT sent on runtime requests (CLIProxyAPI only uses it during onboarding).
    expect(req.headers["x-goog-api-client"]).toBeUndefined();
    // sessionId lives only at request.sessionId (no top-level / snake_case duplicate).
    expect(env.request.sessionId).toMatch(/^-/);
    expect(env.request.session_id).toBeUndefined();
    expect(env.sessionId).toBeUndefined();
  });

  test("stream uses :streamGenerateContent?alt=sse", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("x", true));
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("exposes only Gemini 3.6 Flash tiers while hidden compatibility aliases resolve to them", async () => {
    // Collapsed picker: base models only.
    expect(ANTIGRAVITY_MODELS).toEqual([
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    for (const hidden of [
      "gemini-3.6-flash-low",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-high",
      "gemini-3.1-pro-low",
      "gemini-pro-agent",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash-extra-low",
      "gemini-3.5-flash-low",
      "gemini-3.5-flash-mid",
      "gemini-3.5-flash-high",
      "gemini-3-flash-agent",
      "gemini-3.6-flash-tiered",
    ]) {
      expect(ANTIGRAVITY_MODELS).not.toContain(hidden);
    }

    for (const [alias, wire] of [
      ["gemini-3.5-flash-extra-low", "gemini-3.6-flash-low"],
      ["gemini-3.5-flash-low", "gemini-3.6-flash-medium"],
      ["gemini-3.5-flash-mid", "gemini-3.6-flash-medium"],
      ["gemini-3.5-flash-high", "gemini-3.6-flash-high"],
      ["gemini-3-flash-agent", "gemini-3.6-flash-high"],
      ["gemini-3.1-pro-high", "gemini-pro-agent"],
      ["gemini-3.1-pro-preview", "gemini-pro-agent"],
    ]) {
      const req = await createGoogleAdapter(provider).buildRequest(parsed("x", false, alias));
      expect(JSON.parse(req.body).model).toBe(wire);
    }

    for (const modelId of ["gemini-3.6-flash-low", "gemini-3.6-flash-medium", "gemini-3.6-flash-high"]) {
      const req = await createGoogleAdapter(provider).buildRequest(parsed("x", false, modelId));
      expect(JSON.parse(req.body).model).toBe(modelId);
    }
  });

  test("throws when no project id is available", async () => {
    const noProj = { ...provider, project: undefined } as OcxProviderConfig;
    await expect(createGoogleAdapter(noProj).buildRequest(parsed())).rejects.toThrow(/project id/);
  });

  test("sessionId is deterministic for the same first user text", () => {
    expect(antigravitySessionId(parsed("same"))).toBe(antigravitySessionId(parsed("same")));
    expect(antigravitySessionId(parsed("a"))).not.toBe(antigravitySessionId(parsed("b")));
  });

  test("claude-on-antigravity forces toolConfig.functionCallingConfig.mode=VALIDATED", async () => {
    const claudeProvider = { ...provider } as OcxProviderConfig;
    const withTools = {
      modelId: "claude-opus-4-6",
      stream: false,
      context: {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: [],
        tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(claudeProvider).buildRequest(withTools);
    const env = JSON.parse(req.body);
    expect(env.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
  });

  test("gemini-on-antigravity does NOT get the VALIDATED override", async () => {
    const withTools = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [{ role: "user", content: "hi" }],
        systemPrompt: [],
        tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(withTools);
    const env = JSON.parse(req.body);
    expect(env.request.toolConfig?.functionCallingConfig?.mode).toBeUndefined();
  });

  // ── Effort routing: base model + effort → wire model ID + thinkingConfig ──

  test("gemini-3.6-flash with effort=high routes to gemini-3.6-flash-high + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-high");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("gemini-3.6-flash with effort=low routes to gemini-3.6-flash-low + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash", "low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-low");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  test("gemini-3.6-flash with no effort defaults to medium wire ID, no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-medium");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("gemini-3.6-flash with effort=max clamps to high", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash", "max"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-high");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("gemini-3.1-pro with effort=low routes to gemini-3.1-pro-low + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro", "low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.1-pro-low");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  test("gemini-3.1-pro with effort=high routes to gemini-pro-agent + thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-pro-agent");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("gemini-3.1-pro with no effort defaults to gemini-pro-agent (high)", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-pro-agent");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("gemini-3.1-pro with effort=medium clamps to low", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.1-pro", "medium"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.1-pro-low");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("low");
  });

  // ── Suffix-ID precedence: suffix IS the effort, no thinkingConfig ──

  test("suffix ID gemini-3.6-flash-low with effort=high keeps suffix, no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash-low", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-low");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("suffix ID gemini-3.6-flash-low with no effort keeps suffix, no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.6-flash-low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-low");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("legacy compat alias gemini-3.5-flash-high resolves to gemini-3.6-flash-high, no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gemini-3.5-flash-high", "low"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gemini-3.6-flash-high");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  // ── Claude Opus effort via thinkingConfig (no suffix variants) ──

  test("claude-opus-4-6-thinking with effort=high sends thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-opus-4-6-thinking with effort=max sends thinkingConfig max", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking", "max"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("max");
  });

  test("claude-opus-4-6-thinking with effort=ultra clamps to max", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking", "ultra"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("max");
  });

  test("claude-opus-4-6-thinking with no effort sends no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-opus-4-6-thinking"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-opus-4-6-thinking");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  // ── Non-effort models: no thinkingConfig regardless of effort ──

  test("claude-sonnet-4-6 with effort=high sends thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-sonnet-4-6", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("high");
  });

  test("claude-sonnet-4-6 with effort=max sends thinkingConfig max", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-sonnet-4-6", "max"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.request.generationConfig?.thinkingConfig?.thinkingLevel).toBe("max");
  });

  test("claude-sonnet-4-6 with no effort sends no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("claude-sonnet-4-6"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });

  test("gpt-oss-120b-medium with any effort sends no thinkingConfig", async () => {
    const req = await createGoogleAdapter(effortProvider).buildRequest(parsedWithEffort("gpt-oss-120b-medium", "high"));
    const env = JSON.parse(req.body);
    expect(env.model).toBe("gpt-oss-120b-medium");
    expect(env.request.generationConfig?.thinkingConfig).toBeUndefined();
  });
});

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("antigravity parseStream unwraps response", () => {
  test("reads response.candidates and response.usageMetadata", async () => {
    const adapter = createGoogleAdapter(provider);
    const chunks = [
      { response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } },
      { response: { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, cachedContentTokenCount: 3 } } },
    ];
    const events: AdapterEvent[] = [];
    for await (const ev of adapter.parseStream(sseResponse(chunks))) events.push(ev);
    expect(events.some(e => e.type === "text_delta" && e.text === "hi")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(4);
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.cachedInputTokens).toBe(3);
  });
});

describe("antigravity parseResponse unwraps response (non-streaming)", () => {
  test("reads response.candidates + response.usageMetadata from the CCA envelope", async () => {
    const adapter = createGoogleAdapter(provider);
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, cachedContentTokenCount: 7 } } });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 }));
    expect(events.some(e => e.type === "text_delta" && e.text === "hello")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(9);
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.cachedInputTokens).toBe(7);
  });

  test("non-streaming observes thoughtSignatures so the next turn can replay them", async () => {
    const { __resetAntigravityReplayCache, applyAntigravityReplay } = await import("../src/adapters/google-antigravity-replay");
    __resetAntigravityReplayCache();
    const adapter = createGoogleAdapter(provider);
    // buildRequest first to set the per-adapter model/session, then parseResponse to observe.
    await adapter.buildRequest(parsed("hello world"));
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "do_x", args: { a: 1 } }, thoughtSignature: "sig-nonstream0000000" } ] } }] } });
    await adapter.parseResponse!(new Response(body, { status: 200 }));
    // A follow-up request's history should now get the signature re-injected.
    const followup = parsed("hello world");
    const contents = [{ role: "model", parts: [{ functionCall: { name: "do_x", args: { a: 1 } } }] }];
    applyAntigravityReplay("gemini-3-pro", antigravitySessionId(followup), contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("sig-nonstream0000000");
  });
});

describe("antigravity history preserves tool-call thoughtSignature", () => {
  test("a prior assistant toolCall with thoughtSignature carries it into the CCA request part", async () => {
    const p = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_x", namespace: "mcp__t", arguments: { a: 1 }, thoughtSignature: "sig-abcdef0123456789" }] },
        ],
        systemPrompt: [], tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(p);
    const env = JSON.parse(req.body);
    const modelTurn = (env.request.contents as { role: string; parts: Record<string, unknown>[] }[]).find(c => c.role === "model");
    const fcPart = modelTurn?.parts.find(part => "functionCall" in part);
    expect(fcPart?.thoughtSignature).toBe("sig-abcdef0123456789");
  });

  test("a synthetic Responses item id (fc_...) is NOT forwarded as a thoughtSignature", async () => {
    const p = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_x", namespace: "mcp__t", arguments: {}, thoughtSignature: "fc_d8df7548e31a4130b7624f3d27571cdd" }] },
        ],
        systemPrompt: [], tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(p);
    const env = JSON.parse(req.body);
    const modelTurn = (env.request.contents as { role: string; parts: Record<string, unknown>[] }[]).find(c => c.role === "model");
    const fcPart = modelTurn?.parts.find(part => "functionCall" in part);
    expect(fcPart?.thoughtSignature).toBeUndefined();
  });

  test("custom_tool_call item ids (ctc_...) from Claude/mixed history are NOT forwarded (issue #174)", async () => {
    const p = {
      modelId: "gemini-3-pro",
      stream: false,
      context: {
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_x", namespace: "mcp__t", arguments: {}, thoughtSignature: "ctc_038f26d3f20962bc016a54f0fcfa208190a8ec0f289c2ba211" }] },
        ],
        systemPrompt: [], tools: [],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    const req = await createGoogleAdapter(provider).buildRequest(p);
    const env = JSON.parse(req.body);
    const modelTurn = (env.request.contents as { role: string; parts: Record<string, unknown>[] }[]).find(c => c.role === "model");
    const fcPart = modelTurn?.parts.find(part => "functionCall" in part);
    expect(fcPart?.thoughtSignature).toBeUndefined();
  });
});

describe("isLikelyRealThoughtSignature", () => {
  test("rejects synthetic Responses/tool-call ids (underscore and hyphen variants)", () => {
    for (const id of [
      "fc_d8df7548e31a4130b7624f3d27571cdd",
      "ctc_038f26d3f20962bc016a54f0fcfa208190a8ec0f289c2ba211",
      "tsc_0123456789abcdef01234567",
      "call_1f57fdea0000",
      "function-call-1234567890",
      "tool-call-abcdef123456",
      "toolu_01AbCdEfGhIjKlMnOpQrStUv",
      "msg_0123456789abcdef",
      "rs_0123456789abcdef",
    ]) {
      expect(isLikelyRealThoughtSignature(id)).toBe(false);
    }
  });
  test("rejects too-short or non-base64 values", () => {
    expect(isLikelyRealThoughtSignature("short")).toBe(false);
    expect(isLikelyRealThoughtSignature("has spaces in it here")).toBe(false);
    expect(isLikelyRealThoughtSignature(undefined)).toBe(false);
  });
  test("accepts an opaque base64/base64url signature blob", () => {
    expect(isLikelyRealThoughtSignature("CisBVKhc7+abcDEF0123456789/xyz==")).toBe(true);
    expect(isLikelyRealThoughtSignature("abcd1234abcd1234abcd1234")).toBe(true);
    // `sig-…` shapes are used by replay fixtures / some upstream blobs — must NOT be deny-listed.
    expect(isLikelyRealThoughtSignature("sig-abcdef0123456789")).toBe(true);
  });
});
