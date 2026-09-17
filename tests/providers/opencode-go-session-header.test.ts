import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { providerConfigSeed } from "../../src/providers/derive";
import { resolveOpenCodeGoTransport } from "../../src/providers/opencode-go-transport";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesWithPolicyFallback, rankPolicyFallbackCandidates } from "../../src/server/responses/policy-fallback";
import { getOrAllocateRequestSessionLane } from "../../src/server/request-log-conversation";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const MUSE_MODEL = "muse-spark-1.3-contributor";
const CHAT_MODEL = "glm-5.2";
const SESSION_HEADER = "x-opencode-session";
const CHAT_SESSION_VECTORS = {
  metadataA: "ocx_402dc1464c08a86e3c55073186a7a8b1",
  metadataB: "ocx_db71da58bc580eca9aa75a5979573122",
  client: "ocx_2225190737b6ba32dad580bee01ba899",
  native: "ocx_5010ddace206624d21c39711cbb786c0",
  prefixed: "ocx_d956cf086e3f7fc34f56f465ee4c7601",
  codex: "ocx_b7724df20a058b5cbf53f86b6dd829ff",
} as const;
const RESPONSES_SESSION_VECTORS = {
  metadataA: "ocx_8eb3fc0d524fea055a33e64c0f4c1914",
  client: "ocx_7f1566030d3ebd6516c6fabb460fbda1",
  native: "ocx_409bae0177f90ebdc0653aff6b0e979f",
  prefixed: "ocx_c974cef031af8717276b933929f0c073",
  codex: "ocx_a0cfe09ee92e4bfa2e560579bc46c50e",
} as const;

function opencodeGo(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const entry = getProviderRegistryEntry("opencode-go");
  if (!entry) throw new Error("missing opencode-go registry fixture");
  return { ...providerConfigSeed(entry), apiKey: "test-key", ...overrides };
}

function codexHeaders(child = "child-thread-a"): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-codex-parent-thread-id": "raw-parent-thread",
    "thread-id": child,
    session_id: "raw-session-id",
  };
}

function upstreamResponse(url: string, stream = false): Response {
  if (stream && url.endsWith("/chat/completions")) {
    return new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  }
  if (url.endsWith("/responses")) {
    return Response.json({
      id: "resp_opencode_go_session",
      object: "response",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        total_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
      },
    });
  }
  return Response.json({
    id: "chatcmpl_opencode_go_session",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function captureRequest(input: {
  providerName?: string;
  model?: string;
  child?: string;
  provider?: OcxProviderConfig;
  nativeChat?: boolean;
  claude?: boolean;
  metadataUserId?: string;
  headers?: Record<string, string>;
} = {}): Promise<{ url: string; headers: Headers }> {
  const providerName = input.providerName ?? "opencode-go";
  const model = input.model ?? MUSE_MODEL;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const url = String(requestInput);
    requests.push({ url, headers: new Headers(init?.headers) });
    return upstreamResponse(url, input.claude);
  }) as typeof fetch;

  const config = {
    providers: { [providerName]: input.provider ?? opencodeGo() },
  } as unknown as OcxConfig;
  const response = input.claude ? await handleClaudeMessages(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: input.headers ?? { "content-type": "application/json" },
      body: JSON.stringify({
        model: `${providerName}/${model}`, max_tokens: 64, stream: false,
        system: "A shared system prompt is not a conversation identifier.",
        messages: [{ role: "user", content: "ping" }],
        ...(input.metadataUserId !== undefined ? { metadata: { user_id: input.metadataUserId } } : {}),
      }),
    }),
    config,
    { model: "", provider: "" },
  ) : input.nativeChat ? await handleChatCompletions(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: input.headers ?? codexHeaders(input.child),
      body: JSON.stringify({ model: `${providerName}/${model}`, messages: [{ role: "user", content: "ping" }], stream: false }),
    }),
    config,
    { model: "", provider: "" },
  ) : await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: input.headers ?? codexHeaders(input.child),
      body: JSON.stringify({ model: `${providerName}/${model}`, input: "ping", stream: false }),
    }),
    config,
    { model: "", provider: "" },
    { inboundWire: "responses" },
  );

  expect(response.status).toBe(200);
  await response.text();
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("OpenCode Go session affinity (#3344)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  for (const model of [CHAT_MODEL, MUSE_MODEL]) {
    // The policy target is deliberately renamed, so provider-name wire defaults do not apply;
    // both models retain the configured Chat adapter while destination recognition still applies.
    const sessionVectors = CHAT_SESSION_VECTORS;
    for (const preliminaryAdapter of ["openai-chat", "openai-responses"] as const) {
    for (const strategy of ["random", "failover"] as const) {
      for (const identity of [
        { name: "metadata", headers: {}, metadata: "user_test_account__session_conversation-a", expected: sessionVectors.metadataA },
        { name: "explicit Go header", headers: { [SESSION_HEADER]: "client-session-a" }, metadata: "other-session", expected: sessionVectors.client },
        { name: "explicit lane", headers: { session_id: "native-client-session", [SESSION_HEADER]: "client-session-a" }, metadata: "other-session", expected: sessionVectors.native },
        { name: "operator override", headers: {}, metadata: "user_test_account__session_conversation-a", operator: true, expected: "operator-session" },
        { name: "invalid explicit lane", headers: { session_id: "invalid\tidentity", [SESSION_HEADER]: "invalid\tidentity" }, metadata: "user_test_account__session_conversation-a", expected: sessionVectors.metadataA },
        { name: "invalid metadata", headers: {}, metadata: "invalid\u0000identity", expected: "isolated" },
        { name: "shared system only", headers: {}, metadata: undefined, expected: "isolated" },
      ]) {
      test(`Claude ${strategy} ${preliminaryAdapter} to Go uses ${identity.name} on ${model}`, async () => {
        // Without valid identity the final Go destination still receives a
        // request-scoped lane (#4172): well-formed, never the shared-system or
        // metadata-derived value, and distinct across independent requests.
        const observed: string[] = [];
        for (const round of [1, 2]) {
        clearComboSelectionState();
        clearComboTargetCooldowns();
        const requests: Array<{ url: string; headers: Headers }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          requests.push({ url, headers: new Headers(init?.headers) });
          if (url.startsWith("https://other.example")) {
            return Response.json({ error: { message: "model retired", code: "model_not_found" } }, { status: 404 });
          }
          return upstreamResponse(url, true);
        }) as typeof fetch;
        const config = {
          providers: {
            other: { adapter: preliminaryAdapter, authMode: "key", baseUrl: "https://other.example/v1", apiKey: "test-key", models: ["other"] },
            "renamed-go": opencodeGo(identity.operator ? { headers: { "X-OpenCode-Session": "operator-session" } } : {}),
          },
          combos: { affinity: { strategy, targets: [
            { provider: "other", model: "other" }, { provider: "renamed-go", model },
          ] } },
        } as unknown as OcxConfig;
        const entropy = spyOn(Math, "random").mockReturnValue(0.9);
        // Preliminary route checks the first target; dispatch independently picks Go.
        entropy.mockReturnValueOnce(0);
        try {
          const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
            method: "POST", headers: { "content-type": "application/json", ...identity.headers } as Record<string, string>,
            body: JSON.stringify({ model: "combo/affinity", max_tokens: 64, stream: false,
              messages: [{ role: "user", content: "ping" }],
              system: "Shared system prompt is not a session.",
              metadata: { user_id: identity.metadata } }),
          }), config, { model: "", provider: "" });
          await response.text();
          expect(response.status).toBe(200);
          expect(requests.at(-1)?.url).toStartWith("https://opencode.ai/zen/go/v1/");
          const lane = requests.at(-1)?.headers.get(SESSION_HEADER);
          if (identity.expected === "isolated") {
            expect(lane).toMatch(/^ocx_[0-9a-f]{32}$/);
            expect(lane).not.toBe(sessionVectors.metadataA);
            observed.push(lane!);
          } else {
            expect(lane).toBe(identity.expected);
          }
          if (strategy === "failover") {
            expect(requests).toHaveLength(2);
            expect(requests[0]?.headers.has(SESSION_HEADER)).toBe(false);
          } else {
            expect(requests).toHaveLength(1);
          }
        } finally {
          entropy.mockRestore();
          clearComboSelectionState();
          clearComboTargetCooldowns();
        }
        if (identity.expected !== "isolated" && round === 1) break;
        }
        if (identity.expected === "isolated") {
          expect(observed).toHaveLength(2);
          expect(observed[0]).not.toBe(observed[1]);
        }
      });
      }
    }
    }

    test(`Claude random Go preflight does not leak affinity to a final non-Go Responses target (${model})`, async () => {
      clearComboSelectionState();
      clearComboTargetCooldowns();
      const requests: Headers[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://other.example/v1/responses");
        requests.push(new Headers(init?.headers));
        return upstreamResponse(String(input));
      }) as typeof fetch;
      const config = {
        providers: {
          other: { adapter: "openai-responses", authMode: "key", baseUrl: "https://other.example/v1", apiKey: "test-key", models: ["other"] },
          "renamed-go": opencodeGo(),
        },
        combos: { affinity: { strategy: "random", targets: [
          { provider: "renamed-go", model }, { provider: "other", model: "other" },
        ] } },
      } as unknown as OcxConfig;
      const entropy = spyOn(Math, "random").mockReturnValue(0.9).mockReturnValueOnce(0);
      try {
        const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
          method: "POST", headers: { "content-type": "application/json", [SESSION_HEADER]: "client-session-a" },
          body: JSON.stringify({ model: "combo/affinity", max_tokens: 64, stream: false,
            messages: [{ role: "user", content: "ping" }],
            metadata: { user_id: "user_test_account__session_conversation-a" } }),
        }), config, { model: "", provider: "" });
        await response.text();
        expect(response.status).toBe(200);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.has(SESSION_HEADER)).toBe(false);
        expect(requests[0]?.has("session_id")).toBe(false);
      } finally {
        entropy.mockRestore();
        clearComboSelectionState();
        clearComboTargetCooldowns();
      }
    });
  }

  test("Claude metadata gives stable Go affinity across turns and distinct conversations", async () => {
    const input = { claude: true, model: CHAT_MODEL, metadataUserId: "user_test_account__session_conversation-a" };
    const first = await captureRequest(input);
    const continued = await captureRequest(input);
    const next = await captureRequest({ ...input, metadataUserId: "user_test_account__session_conversation-b" });
    expect(first.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    // Fixed SHA-256 vectors calculated independently of the production helpers.
    expect(first.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.metadataA);
    expect(continued.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.metadataA);
    expect(next.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.metadataB);
    expect(first.headers.get(SESSION_HEADER)).not.toContain("conversation-a");
  });

  test("Claude recognizes renamed canonical Go destinations and isolates a request with no identity", async () => {
    const input = { claude: true, model: CHAT_MODEL, providerName: "renamed-go" };
    const metadata = await captureRequest({ ...input, metadataUserId: "user_test_account__session_conversation-a" });
    const desktop = await captureRequest(input);
    const secondDesktop = await captureRequest(input);
    expect(metadata.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.metadataA);
    // A shared system prompt is not identity, so this request has none. It still has to carry the
    // header — Go rejects requests without one — but under a lane of its own rather than a shared value.
    expect(desktop.headers.get(SESSION_HEADER)).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(desktop.headers.get(SESSION_HEADER)).not.toBe(metadata.headers.get(SESSION_HEADER));
    expect(secondDesktop.headers.get(SESSION_HEADER)).not.toBe(desktop.headers.get(SESSION_HEADER));
  });

  test("Claude explicit Go header precedes metadata and matches native Chat affinity", async () => {
    const headers = { "content-type": "application/json", [SESSION_HEADER]: "client-session-a" };
    const claude = await captureRequest({ claude: true, model: CHAT_MODEL, headers, metadataUserId: "different-metadata-session" });
    const chat = await captureRequest({ nativeChat: true, model: CHAT_MODEL, headers });
    expect(claude.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.client);
    expect(chat.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.client);
  });

  test("Claude affinity survives per-model Responses wire selection", async () => {
    const input = { claude: true, metadataUserId: "user_test_account__session_conversation-a" };
    const chat = await captureRequest({ ...input, model: CHAT_MODEL });
    const responses = await captureRequest({ ...input, model: MUSE_MODEL });
    expect(responses.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(chat.headers.get(SESSION_HEADER)).toBe(CHAT_SESSION_VECTORS.metadataA);
    expect(responses.headers.get(SESSION_HEADER)).toBe(RESPONSES_SESSION_VECTORS.metadataA);
    expect(responses.headers.get(SESSION_HEADER)).not.toBe(chat.headers.get(SESSION_HEADER));
    const explicit = await captureRequest({
      ...input, model: MUSE_MODEL,
      headers: { "content-type": "application/json", [SESSION_HEADER]: "client-session-a" },
    });
    expect(explicit.headers.get(SESSION_HEADER)).toBe(RESPONSES_SESSION_VECTORS.client);
  });

  for (const [model, url, sessionVectors] of [
    [CHAT_MODEL, "https://opencode.ai/zen/go/v1/chat/completions", CHAT_SESSION_VECTORS],
    [MUSE_MODEL, "https://opencode.ai/zen/go/v1/responses", RESPONSES_SESSION_VECTORS],
  ] as const) {
    test(`Claude ${model} falls back to valid metadata after invalid explicit Go identity`, async () => {
      // Interior tab is constructible in HTTP Headers but rejected by the identity owner.
      for (const session of ["", "   ", "invalid\tidentity", "x".repeat(4097)]) {
        const captured = await captureRequest({
          claude: true, model, metadataUserId: "user_test_account__session_conversation-a",
          headers: { "content-type": "application/json", [SESSION_HEADER]: session },
        });
        expect(captured.url).toBe(url);
        expect(captured.headers.get(SESSION_HEADER)).toBe(sessionVectors.metadataA);
        const invalidLane = await captureRequest({
          claude: true, model, metadataUserId: "user_test_account__session_conversation-a",
          headers: { "content-type": "application/json", session_id: session },
        });
        expect(invalidLane.url).toBe(url);
        expect(invalidLane.headers.get(SESSION_HEADER)).toBe(sessionVectors.metadataA);
      }
    });

    test(`Claude ${model} isolates each request whose metadata identity is unusable`, async () => {
      const seen = new Set<string>();
      for (const metadataUserId of [undefined, "", " \t\n ", "invalid\u0000identity", "x".repeat(4097)]) {
        const captured = await captureRequest({ claude: true, model, metadataUserId });
        expect(captured.url).toBe(url);
        // Unusable identity is not the same as no header: the request still reaches Go, and it does
        // so under a lane nobody else shares.
        const lane = captured.headers.get(SESSION_HEADER);
        expect(lane).toMatch(/^ocx_[0-9a-f]{32}$/);
        expect(seen.has(lane!)).toBe(false);
        seen.add(lane!);
        expect(captured.headers.has("session_id")).toBe(false);
      }
    });

    test(`Claude ${model} keeps explicit and operator identity with empty metadata`, async () => {
      const input = {
        claude: true, model, metadataUserId: "",
        headers: { "content-type": "application/json", [SESSION_HEADER]: " client-session-a " },
      };
      const explicit = await captureRequest(input);
      expect(explicit.url).toBe(url);
      expect(explicit.headers.get(SESSION_HEADER)).toBe(sessionVectors.client);
      const operator = await captureRequest({ ...input, provider: opencodeGo({ headers: { "X-OpenCode-Session": "operator-session" } }) });
      expect(operator.url).toBe(url);
      expect(operator.headers.get(SESSION_HEADER)).toBe("operator-session");
    });

    test(`Claude ${model} preserves explicit session lanes and operator header precedence`, async () => {
      for (const laneHeader of ["session_id", "session-id", "thread-id", "x-codex-parent-thread-id"]) {
        const headers = { "content-type": "application/json", [laneHeader]: "native-client-session", [SESSION_HEADER]: "different-fallback" };
        const input = { claude: true, model, headers, metadataUserId: "different-metadata-session" };
        const claude = await captureRequest(input);
        expect(claude.url).toBe(url);
        expect(claude.headers.get(SESSION_HEADER)).toBe(sessionVectors.native);
        const operator = await captureRequest({ ...input, provider: opencodeGo({ headers: { "X-OpenCode-Session": "operator-session" } }) });
        expect(operator.url).toBe(url);
        expect(operator.headers.get(SESSION_HEADER)).toBe("operator-session");
      }
    });
  }

  test("Claude does not add Go affinity to custom or lookalike destinations", async () => {
    for (const baseUrl of ["https://custom.example/v1", "https://opencode.ai.evil.test/zen/go/v1"]) {
      const captured = await captureRequest({
        claude: true, model: CHAT_MODEL, providerName: "custom-go",
        provider: opencodeGo({ baseUrl }), metadataUserId: "user_test_account__session_conversation-a",
        headers: { "content-type": "application/json", [SESSION_HEADER]: "client-session-a" },
      });
      expect(captured.headers.has(SESSION_HEADER)).toBe(false);
    }
  });

  test("native Chat ingress preserves stable Go affinity and separates conversations", async () => {
    const provider = opencodeGo();
    const input = { nativeChat: true, model: "omen-alpha", provider };
    const first = await captureRequest(input);
    const continued = await captureRequest(input);
    const sibling = await captureRequest({ ...input, child: "child-thread-b" });
    expect(first.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(first.headers.get(SESSION_HEADER)).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(continued.headers.get(SESSION_HEADER)).toBe(first.headers.get(SESSION_HEADER));
    expect(sibling.headers.get(SESSION_HEADER)).not.toBe(first.headers.get(SESSION_HEADER));
    expect(provider.headers?.[SESSION_HEADER]).toBeUndefined();
  });

  test("native Chat honors configured session headers on renamed Go providers", async () => {
    const captured = await captureRequest({
      nativeChat: true, model: "omen-alpha", providerName: "renamed-go",
      provider: opencodeGo({ headers: { "X-OpenCode-Session": "operator-session" } }),
    });
    expect(captured.headers.get(SESSION_HEADER)).toBe("operator-session");
  });

  test("uses a Pi session header without Codex headers on native and bridged Chat", async () => {
    const headers = { "content-type": "application/json", "x-opencode-session": "pi-conversation-a" };
    const chat = await captureRequest({ nativeChat: true, model: "omen-alpha", headers });
    const bridged = await captureRequest({ nativeChat: true, model: MUSE_MODEL, headers });
    const responses = await captureRequest({ model: MUSE_MODEL, headers });
    expect(chat.headers.get(SESSION_HEADER)).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(chat.headers.get(SESSION_HEADER)).not.toContain("pi-conversation-a");
    expect(bridged.headers.get(SESSION_HEADER)).not.toBe(chat.headers.get(SESSION_HEADER));
    expect(bridged.headers.get(SESSION_HEADER)).toBe(responses.headers.get(SESSION_HEADER));
  });

  // Fixed vectors independently calculated with SHA-256, including the domain separator.
  for (const [session, chatExpected, responsesExpected] of [
    ["client-session-a", CHAT_SESSION_VECTORS.client, RESPONSES_SESSION_VECTORS.client],
    ["ocx_0123456789abcdef0123456789abcdef", CHAT_SESSION_VECTORS.prefixed, RESPONSES_SESSION_VECTORS.prefixed],
  ] as const) {
    test(`treats inbound ${session.startsWith("ocx_") ? "ocx-prefixed" : "raw"} identity as client input on every ingress`, async () => {
      const headers = { "content-type": "application/json", [SESSION_HEADER]: session };
      const native = await captureRequest({ nativeChat: true, model: "omen-alpha", headers });
      const bridged = await captureRequest({ nativeChat: true, model: MUSE_MODEL, headers });
      const responses = await captureRequest({ model: MUSE_MODEL, headers });
      expect(native.url).toEndWith("/chat/completions");
      expect(bridged.url).toEndWith("/responses");
      expect(native.headers.get(SESSION_HEADER)).toBe(chatExpected);
      for (const request of [bridged, responses]) {
        expect(request.headers.get(SESSION_HEADER)).toBe(responsesExpected);
        expect(request.headers.get(SESSION_HEADER)).not.toBe(session);
      }
      const override = await captureRequest({
        nativeChat: true, model: "omen-alpha", headers,
        provider: opencodeGo({ headers: { "X-OpenCode-Session": session } }),
      });
      expect(override.headers.get(SESSION_HEADER)).toBe(session);
    });
  }

  test("operator override precedes the Codex lane, which precedes client fallback on every ingress", async () => {
    const headers = { ...codexHeaders(), [SESSION_HEADER]: "different-client-fallback" };
    for (const [ingress, expected] of [
      [{ nativeChat: true, model: "omen-alpha" }, CHAT_SESSION_VECTORS.codex],
      [{ nativeChat: true, model: MUSE_MODEL }, RESPONSES_SESSION_VECTORS.codex],
      [{ model: MUSE_MODEL }, RESPONSES_SESSION_VECTORS.codex],
    ] as const) {
      const codex = await captureRequest({ ...ingress, headers });
      expect(codex.headers.get(SESSION_HEADER)).toBe(expected);
      const operator = await captureRequest({
        ...ingress, headers,
        provider: opencodeGo({ headers: { "X-OpenCode-Session": "different-operator-override" } }),
      });
      expect(operator.headers.get(SESSION_HEADER)).toBe("different-operator-override");
    }
  });

  test("native Chat does not send Go affinity to an unrelated destination", async () => {
    const captured = await captureRequest({
      nativeChat: true, model: "omen-alpha", providerName: "custom-go",
      provider: opencodeGo({ baseUrl: "https://opencode.ai.evil.test/zen/go/v1" }),
    });
    expect(captured.headers.has(SESSION_HEADER)).toBe(false);
  });

  test("keeps affinity stable within a final protocol and separates different protocols", async () => {
    const responses = await captureRequest({ model: MUSE_MODEL });
    const bridgedChat = await captureRequest({ nativeChat: true, model: MUSE_MODEL });
    const chat = await captureRequest({ model: CHAT_MODEL });
    const responsesSession = responses.headers.get(SESSION_HEADER);
    const bridgedChatSession = bridgedChat.headers.get(SESSION_HEADER);
    const chatSession = chat.headers.get(SESSION_HEADER);

    expect(responses.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(bridgedChat.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(chat.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(responsesSession).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(bridgedChatSession).toBe(responsesSession);
    expect(chatSession).not.toBe(responsesSession);
    expect([...responses.headers.keys()].filter(name => name === SESSION_HEADER)).toHaveLength(1);
  });

  test("separates sibling subagents without exposing raw Codex identities", async () => {
    const first = await captureRequest({ child: "child-thread-a" });
    const second = await captureRequest({ child: "child-thread-b" });
    const firstSession = first.headers.get(SESSION_HEADER);
    const secondSession = second.headers.get(SESSION_HEADER);

    expect(firstSession).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(secondSession).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(secondSession).not.toBe(firstSession);
    expect(firstSession).not.toContain("raw-parent-thread");
    expect(firstSession).not.toContain("child-thread-a");
    expect(firstSession).not.toContain("raw-session-id");
  });

  test("recognizes a renamed provider by its canonical OpenCode Go destination", async () => {
    const captured = await captureRequest({ providerName: "opencode-go-2" });
    expect(captured.headers.get(SESSION_HEADER)).toMatch(/^ocx_[0-9a-f]{32}$/);
  });

  test("preserves an explicit operator session header case-insensitively", async () => {
    const captured = await captureRequest({
      provider: opencodeGo({ headers: { "X-OpenCode-Session": "operator-session" } }),
    });
    expect(captured.headers.get(SESSION_HEADER)).toBe("operator-session");
    expect([...captured.headers.keys()].filter(name => name === SESSION_HEADER)).toHaveLength(1);
  });

  test("keeps generated affinity runtime-only and omits it without a stable lane", async () => {
    const configured = opencodeGo();
    await captureRequest({ provider: configured });
    expect(configured.headers?.[SESSION_HEADER]).toBeUndefined();
    expect(resolveOpenCodeGoTransport(configured, undefined, configured)).toBe(configured);
    expect(resolveOpenCodeGoTransport(configured, undefined, configured).headers?.[SESSION_HEADER]).toBeUndefined();
  });

  test("recognizes Go from the routed provider after the final adapter changes", () => {
    const destination = opencodeGo();
    const anthropic = { ...destination, adapter: "anthropic" } as OcxProviderConfig;
    const chat = resolveOpenCodeGoTransport(destination, "stable-lane", destination);
    const messages = resolveOpenCodeGoTransport(anthropic, "stable-lane", destination);
    const continuedMessages = resolveOpenCodeGoTransport(anthropic, "stable-lane", destination);
    const operator = resolveOpenCodeGoTransport({
      ...anthropic,
      headers: { "X-OpenCode-Session": "operator-session" },
    }, "stable-lane", destination);

    expect(chat.headers?.[SESSION_HEADER]).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(messages.headers?.[SESSION_HEADER]).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(continuedMessages.headers?.[SESSION_HEADER]).toBe(messages.headers?.[SESSION_HEADER]);
    expect(messages.headers?.[SESSION_HEADER]).not.toBe(chat.headers?.[SESSION_HEADER]);
    expect(operator.headers?.["X-OpenCode-Session"]).toBe("operator-session");
  });

  test("does not inject the header into a lookalike destination", async () => {
    const captured = await captureRequest({
      providerName: "custom-go",
      provider: opencodeGo({ baseUrl: "https://opencode.ai.evil.test/zen/go/v1" }),
    });
    expect(captured.headers.has(SESSION_HEADER)).toBe(false);
  });
});

describe("OpenCode Go affinity across the policy fallback retry (#4172)", () => {
  const policyTrace = {
    version: 1,
    decisionId: "decision-policy-go",
    createdAt: Date.now(),
    requestedModel: "policy/go",
    routeKind: "policy",
    profile: { id: "profile-go", revision: "rev-1" },
    requirements: [],
    candidates: [
      { provider: "opencode-go", model: MUSE_MODEL, eligible: true, exclusions: [], score: { total: 2 } },
      { provider: "opencode-go-2", model: MUSE_MODEL, eligible: true, exclusions: [], score: { total: 1 } },
    ],
    selected: { candidateIndex: 0, provider: "opencode-go", model: MUSE_MODEL, reason: "policy-test" },
  } as unknown as Parameters<typeof rankPolicyFallbackCandidates>[0];

  function sessionlessRequest(): Request {
    return new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "policy/go", input: "ping", stream: false }),
    });
  }

  function laneHeaderFor(req: Request): string | undefined {
    const destination = opencodeGo();
    return resolveOpenCodeGoTransport(destination, getOrAllocateRequestSessionLane(req), destination)
      .headers?.[SESSION_HEADER];
  }

  async function runPolicyFallback(req: Request): Promise<Request[]> {
    const seen: Request[] = [];
    let attempts = 0;
    const runCore = (async (coreReq: Request, _config: unknown, logCtx: { routeDecision?: unknown }) => {
      seen.push(coreReq);
      logCtx.routeDecision = policyTrace;
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: "upstream temporarily unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ id: "resp_policy_go", object: "response", status: "completed", output: [] });
    }) as unknown as NonNullable<Parameters<typeof handleResponsesWithPolicyFallback>[4]>["runCore"];

    const config = { providers: { "opencode-go": opencodeGo() } } as unknown as OcxConfig;
    const response = await handleResponsesWithPolicyFallback(
      req, config, { model: "", provider: "" } as never, {}, { runCore },
    );
    expect(response.status).toBe(200);
    return seen;
  }

  test("a sessionless request keeps one lane when the policy hops to the next candidate", async () => {
    const seen = await runPolicyFallback(sessionlessRequest());
    // The retry is a different Request object built by requestWithCandidate. Without the link it
    // would look sessionless again and be handed a second lane, splitting one turn across two Go
    // conversations — which is exactly what the header exists to prevent.
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    const first = laneHeaderFor(seen[0]!);
    expect(first).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(laneHeaderFor(seen[1]!)).toBe(first);
  });

  test("two independent sessionless requests do not share a lane through the same fallback", async () => {
    const firstTurn = await runPolicyFallback(sessionlessRequest());
    const secondTurn = await runPolicyFallback(sessionlessRequest());
    expect(laneHeaderFor(secondTurn[0]!)).not.toBe(laneHeaderFor(firstTurn[0]!));
    expect(laneHeaderFor(secondTurn[1]!)).toBe(laneHeaderFor(secondTurn[0]!));
  });

  test("real conversation identity still wins over the per-request allocation", async () => {
    const req = new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: codexHeaders("child-thread-policy"),
      body: JSON.stringify({ model: "policy/go", input: "ping", stream: false }),
    });
    const seen = await runPolicyFallback(req);
    const expected = laneHeaderFor(req);
    expect(laneHeaderFor(seen[0]!)).toBe(expected);
    expect(laneHeaderFor(seen[1]!)).toBe(expected);
  });
});
