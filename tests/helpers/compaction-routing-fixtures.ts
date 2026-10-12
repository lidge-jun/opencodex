import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { afterAll, beforeAll } from "bun:test";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { removeTreeWithRetry } from "./remove-tree";

/**
 * Config, request and upstream-response fixtures for the compaction-routing suite.
 *
 * Moved verbatim out of tests/responses/responses-compaction-routing.test.ts: that file sits at
 * its file-size cap, and the repository answer to a cap is a sibling helper rather than
 * compressed control flow. Fixture teardown also owns the continuation writes started by
 * direct handler calls, so they cannot survive a fixture-home switch.
 */
export function installCompactionRoutingAclFixture(): void {
  // These cases prove routing and replay with synthetic credentials, not Windows DACLs.
  // Actual ACL contracts have their own subprocess tests; incidental spawns here can
  // outlive a case timeout and mutate the next fixture's continuation state.
  beforeAll(() => {
    const ok = { success: true, exitCode: 0, timedOut: false, stdout: "" };
    setIcaclsRunnerForTests(() => ok);
    setAsyncIcaclsRunnerForTests(async () => ok);
  });
  afterAll(async () => {
    try { await flushConfigDirHardeningForTests(); } finally {
      setIcaclsRunnerForTests(null);
      setAsyncIcaclsRunnerForTests(null);
    }
  });
}

export async function drainCompactionResponseState(): Promise<void> {
  await flushResponseState();
  clearResponseStateForTests();
  closeRequestHistoryIndex();
}

export async function removeCompactionFixture(path: string): Promise<void> {
  await drainCompactionResponseState();
  removeTreeWithRetry(path);
}

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
