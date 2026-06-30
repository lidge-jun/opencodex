import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { antigravitySessionId, isLikelyRealThoughtSignature } from "../src/adapters/google-antigravity-wire";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(text = "hello world", stream = false): OcxParsedRequest {
  return {
    modelId: "gemini-3-pro",
    stream,
    context: { messages: [{ role: "user", content: text }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
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
    expect(req.headers["x-goog-api-client"]).toBe("google-api-nodejs-client/10.3.0");
    // sessionId lives only at request.sessionId (no top-level / snake_case duplicate).
    expect(env.request.sessionId).toMatch(/^-/);
    expect(env.request.session_id).toBeUndefined();
    expect(env.sessionId).toBeUndefined();
  });

  test("stream uses :streamGenerateContent?alt=sse", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("x", true));
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
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
      { response: { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } } },
    ];
    const events: AdapterEvent[] = [];
    for await (const ev of adapter.parseStream(sseResponse(chunks))) events.push(ev);
    expect(events.some(e => e.type === "text_delta" && e.text === "hi")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(4);
  });
});

describe("antigravity parseResponse unwraps response (non-streaming)", () => {
  test("reads response.candidates + response.usageMetadata from the CCA envelope", async () => {
    const adapter = createGoogleAdapter(provider);
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } } });
    const events = await adapter.parseResponse!(new Response(body, { status: 200 }));
    expect(events.some(e => e.type === "text_delta" && e.text === "hello")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(9);
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
});

describe("isLikelyRealThoughtSignature", () => {
  test("rejects synthetic Responses/tool-call ids (underscore and hyphen variants)", () => {
    for (const id of ["fc_d8df7548e31a4130b7624f3d27571cdd", "call_1f57fdea0000", "function-call-1234567890", "tool-call-abcdef123456", "msg_0123456789abcdef", "rs_0123456789abcdef"]) {
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
  });
});
