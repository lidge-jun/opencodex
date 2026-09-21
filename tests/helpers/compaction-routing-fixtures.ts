import type { OcxConfig, OcxProviderConfig } from "../../src/types";

/**
 * Config, request and upstream-response fixtures for the compaction-routing suite.
 *
 * Moved verbatim out of tests/responses/responses-compaction-routing.test.ts: that file sits at
 * its file-size cap, and the repository answer to a cap is a sibling helper rather than
 * compressed control flow. Nothing here decides anything; every value is the one its callers
 * were already building inline.
 */
export function keyProviderConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    defaultProvider: "gw",
    providers: {
      gw: {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "test-key",
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

export function nativePoolConfig(): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [{
      id: "pool-a",
      email: "pool@example.test",
      isMain: false,
      chatgptAccountId: "pool_acc",
    }],
  } as OcxConfig;
}

/** Two-account pool: the alternate-attempt tests need somewhere for the retry to go. */
export function twoAccountPoolConfig(): OcxConfig {
  const config = nativePoolConfig();
  config.codexAccounts = [
    { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
    { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
  ] as OcxConfig["codexAccounts"];
  return config;
}

export function compactionRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal,
  });
}

export function baseCompactionBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gw/some-model",
    stream: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "earlier turn" }] },
      { type: "compaction_trigger" },
    ],
    tools: [{ type: "function", name: "shell" }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...extra,
  };
}

export function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function completedPayload(text: string): Record<string, unknown> {
  return {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

export function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(e => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
