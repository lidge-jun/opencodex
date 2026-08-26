/**
 * Regression coverage for the Claude Code thought-signature replay scope:
 *
 * Claude Code speaks Anthropic Messages and does not send Codex's
 * `x-codex-parent-thread-id`. The server must still create a reasoning-replay
 * scope for a real per-session `prompt_cache_key` (derived from
 * `metadata.user_id`) so Gemini/Antigravity thought signatures can be remembered
 * by call_id. The shared Desktop `prompt_cache_key` cohort must NOT get a scope.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const actualResolver = await import("../src/server/adapter-resolve");

let adapterFactory: ((provider: OcxProviderConfig) => ProviderAdapter) | undefined;

mock.module("../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    return adapterFactory?.(provider) ?? actualResolver.resolveAdapter(provider, cacheRetention);
  },
}));

const { handleResponses } = await import("../src/server/responses");

afterEach(() => {
  adapterFactory = undefined;
});

function captureAdapter(captured: OcxParsedRequest[]): ProviderAdapter {
  return {
    name: "capture-replay-scope",
    buildRequest: () => ({ url: "https://capture.test", method: "POST", headers: {}, body: "{}" }),
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "done" };
    },
    async runTurn(parsed: OcxParsedRequest, _incoming, emit) {
      captured.push(parsed);
      emit({ type: "done" });
    },
  };
}

function testConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://capture.test",
        authMode: "key",
        apiKey: "capture-key",
        models: ["m1"],
      },
    },
  } as OcxConfig;
}

async function drive(options: {
  promptCacheKey?: string;
  promptCacheKeyIsSharedCohort?: boolean;
}): Promise<OcxParsedRequest> {
  const captured: OcxParsedRequest[] = [];
  adapterFactory = () => captureAdapter(captured);
  const body: Record<string, unknown> = {
    model: "m1",
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
  if (options.promptCacheKey !== undefined) body.prompt_cache_key = options.promptCacheKey;

  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    testConfig(),
    { model: "", provider: "" },
    {
      inboundWire: "anthropic",
      ...(options.promptCacheKeyIsSharedCohort === undefined
        ? {}
        : { promptCacheKeyIsSharedCohort: options.promptCacheKeyIsSharedCohort }),
    },
  );
  await response.text();
  expect(captured.length).toBe(1);
  return captured[0]!;
}

describe("Claude Code Anthropic inbound reasoning-replay scope", () => {
  test("a real per-session prompt_cache_key creates a call_id replay scope", async () => {
    const parsed = await drive({ promptCacheKey: "session-key-123", promptCacheKeyIsSharedCohort: false });
    expect(parsed._clientThreadId).toBeUndefined();
    expect(parsed._reasoningReplayScope?.clientThreadId).toBe("session-key-123");
  });

  test("the shared Desktop prompt_cache_key cohort does not create a scope", async () => {
    const parsed = await drive({ promptCacheKey: "shared-cohort-key", promptCacheKeyIsSharedCohort: true });
    expect(parsed._reasoningReplayScope).toBeUndefined();
  });

  test("an Anthropic replay without prompt_cache_key does not create a scope", async () => {
    const parsed = await drive({});
    expect(parsed._reasoningReplayScope).toBeUndefined();
  });

  test("an overlong prompt_cache_key is hashed, not stored raw", async () => {
    const overlong = "k".repeat(200);
    const parsed = await drive({ promptCacheKey: overlong, promptCacheKeyIsSharedCohort: false });
    const scope = parsed._reasoningReplayScope?.clientThreadId;
    expect(scope).toBeDefined();
    expect(scope).not.toBe(overlong);
    expect(scope!.length).toBeLessThanOrEqual(128);
  });

  test("a whitespace-only prompt_cache_key does not create a scope", async () => {
    const parsed = await drive({ promptCacheKey: "   ", promptCacheKeyIsSharedCohort: false });
    expect(parsed._reasoningReplayScope).toBeUndefined();
  });
});
