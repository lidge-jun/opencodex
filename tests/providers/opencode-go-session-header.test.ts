import { afterEach, describe, expect, test } from "bun:test";
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

  test("Claude metadata gives stable Go affinity across turns and distinct conversations", async () => {
    const input = { claude: true, model: CHAT_MODEL, metadataUserId: "user_test_account__session_conversation-a" };
    const first = await captureRequest(input);
    const continued = await captureRequest(input);
    const next = await captureRequest({ ...input, metadataUserId: "user_test_account__session_conversation-b" });
    expect(first.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    // Fixed SHA-256 vectors calculated independently of the production helpers.
    expect(first.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
    expect(continued.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
    expect(next.headers.get(SESSION_HEADER)).toBe("ocx_55fec02e7f2c7f9358958ab6d1589530");
    expect(first.headers.get(SESSION_HEADER)).not.toContain("conversation-a");
  });

  test("Claude recognizes renamed canonical Go destinations and isolates a request with no identity", async () => {
    const input = { claude: true, model: CHAT_MODEL, providerName: "renamed-go" };
    const metadata = await captureRequest({ ...input, metadataUserId: "user_test_account__session_conversation-a" });
    const desktop = await captureRequest(input);
    const secondDesktop = await captureRequest(input);
    expect(metadata.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
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
    expect(claude.headers.get(SESSION_HEADER)).toBe("ocx_516d593899f34b7baca2db37c7b0c8c5");
    expect(chat.headers.get(SESSION_HEADER)).toBe("ocx_516d593899f34b7baca2db37c7b0c8c5");
  });

  test("Claude affinity survives per-model Responses wire selection", async () => {
    const input = { claude: true, metadataUserId: "user_test_account__session_conversation-a" };
    const chat = await captureRequest({ ...input, model: CHAT_MODEL });
    const responses = await captureRequest({ ...input, model: MUSE_MODEL });
    expect(responses.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(chat.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
    expect(responses.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
    const explicit = await captureRequest({
      ...input, model: MUSE_MODEL,
      headers: { "content-type": "application/json", [SESSION_HEADER]: "client-session-a" },
    });
    expect(explicit.headers.get(SESSION_HEADER)).toBe("ocx_516d593899f34b7baca2db37c7b0c8c5");
  });

  for (const [model, url] of [
    [CHAT_MODEL, "https://opencode.ai/zen/go/v1/chat/completions"],
    [MUSE_MODEL, "https://opencode.ai/zen/go/v1/responses"],
  ] as const) {
    test(`Claude ${model} falls back to valid metadata after invalid explicit Go identity`, async () => {
      // Interior tab is constructible in HTTP Headers but rejected by the identity owner.
      for (const session of ["", "   ", "invalid\tidentity", "x".repeat(4097)]) {
        const captured = await captureRequest({
          claude: true, model, metadataUserId: "user_test_account__session_conversation-a",
          headers: { "content-type": "application/json", [SESSION_HEADER]: session },
        });
        expect(captured.url).toBe(url);
        expect(captured.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
        const invalidLane = await captureRequest({
          claude: true, model, metadataUserId: "user_test_account__session_conversation-a",
          headers: { "content-type": "application/json", session_id: session },
        });
        expect(invalidLane.url).toBe(url);
        expect(invalidLane.headers.get(SESSION_HEADER)).toBe("ocx_a89540229ef781fd5f7adf92a711b436");
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
      expect(explicit.headers.get(SESSION_HEADER)).toBe("ocx_516d593899f34b7baca2db37c7b0c8c5");
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
        expect(claude.headers.get(SESSION_HEADER)).toBe("ocx_a197dbb87311c29a5fbe51140e3845ce");
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
    expect(chat.headers.get(SESSION_HEADER)).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(chat.headers.get(SESSION_HEADER)).not.toContain("pi-conversation-a");
    expect(bridged.headers.get(SESSION_HEADER)).toBe(chat.headers.get(SESSION_HEADER));
  });

  // Fixed vectors independently calculated with SHA-256, including the domain separator.
  for (const [session, expected] of [
    ["client-session-a", "ocx_516d593899f34b7baca2db37c7b0c8c5"],
    ["ocx_0123456789abcdef0123456789abcdef", "ocx_60bcbfb9a85d3dc23b9b2b1cef3b0882"],
  ] as const) {
    test(`treats inbound ${session.startsWith("ocx_") ? "ocx-prefixed" : "raw"} identity as client input on every ingress`, async () => {
      const headers = { "content-type": "application/json", [SESSION_HEADER]: session };
      const native = await captureRequest({ nativeChat: true, model: "omen-alpha", headers });
      const bridged = await captureRequest({ nativeChat: true, model: MUSE_MODEL, headers });
      const responses = await captureRequest({ model: MUSE_MODEL, headers });
      expect(native.url).toEndWith("/chat/completions");
      expect(bridged.url).toEndWith("/responses");
      for (const request of [native, bridged, responses]) {
        expect(request.headers.get(SESSION_HEADER)).toBe(expected);
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
    for (const ingress of [
      { nativeChat: true, model: "omen-alpha" },
      { nativeChat: true, model: MUSE_MODEL },
      { model: MUSE_MODEL },
    ]) {
      const codex = await captureRequest({ ...ingress, headers });
      expect(codex.headers.get(SESSION_HEADER)).toBe("ocx_67b70584fb755130286eff5488a3be9d");
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

  test("sends one stable opaque session header on Responses and Chat wires", async () => {
    const responses = await captureRequest({ model: MUSE_MODEL });
    const chat = await captureRequest({ model: CHAT_MODEL });
    const responsesSession = responses.headers.get(SESSION_HEADER);
    const chatSession = chat.headers.get(SESSION_HEADER);

    expect(responses.url).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(chat.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(responsesSession).toMatch(/^ocx_[0-9a-f]{32}$/);
    expect(chatSession).toBe(responsesSession);
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
    expect(resolveOpenCodeGoTransport(configured, undefined)).toBe(configured);
    expect(resolveOpenCodeGoTransport(configured, undefined).headers?.[SESSION_HEADER]).toBeUndefined();
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
    return resolveOpenCodeGoTransport(opencodeGo(), getOrAllocateRequestSessionLane(req))
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
