import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../../src/providers/derive";
import { resolveOpenCodeGoTransport } from "../../src/providers/opencode-go-transport";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleResponses } from "../../src/server/responses/core";
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

function upstreamResponse(url: string): Response {
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
} = {}): Promise<{ url: string; headers: Headers }> {
  const providerName = input.providerName ?? "opencode-go";
  const model = input.model ?? MUSE_MODEL;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    const url = String(requestInput);
    requests.push({ url, headers: new Headers(init?.headers) });
    return upstreamResponse(url);
  }) as typeof fetch;

  const config = {
    providers: { [providerName]: input.provider ?? opencodeGo() },
  } as unknown as OcxConfig;
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: codexHeaders(input.child),
      body: JSON.stringify({ model: `${providerName}/${model}`, input: "ping", stream: false }),
    }),
    config,
    { model: "", provider: "" },
    { inboundWire: "responses" },
  );

  expect(response.status).toBe(200);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("OpenCode Go session affinity (#3344)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

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
