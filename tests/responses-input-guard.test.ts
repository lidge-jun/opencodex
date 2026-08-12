/**
 * Regression coverage for the responses input-size guard: a request whose input
 * exceeds the model's advertised context window must be rejected with a clean 413
 * instead of being forwarded (forwarding a ~1.6M-token duplication on Windows
 * ballooned bun RSS and native-crashed the whole proxy, issue #314).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetSubagentModelFallbackStateForTests,
  setSubagentQuotaPrimeForTests,
} from "../src/codex/subagent-model-fallback";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-input-guard-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  resetSubagentModelFallbackStateForTests();
});

afterEach(() => {
  resetSubagentModelFallbackStateForTests();
  globalThis.fetch = originalFetch;
  rmSync(testDir, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function deepseekConfig(options: { contextWindow?: number; maxInput?: number } = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        adapter: "openai-responses",
        baseUrl: "https://api.deepseek.com",
        responsesPath: "/responses",
        authMode: "key",
        apiKey: "sk-test",
        models: ["deepseek-v4-flash"],
        ...(options.maxInput !== undefined
          ? { modelMaxInputTokens: { "deepseek-v4-flash": options.maxInput } }
          : {}),
        ...(options.contextWindow !== undefined
          ? { modelContextWindows: { "deepseek-v4-flash": options.contextWindow } }
          : { modelContextWindows: { "deepseek-v4-flash": 1_000_000 } }),
      },
    },
  } as OcxConfig;
}

async function postResponses(
  config: OcxConfig,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" } as RequestLogContext,
  );
}

async function expectOversizedRejection(res: Response): Promise<void> {
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({
    error: {
      type: "request_too_large",
      code: "input_context_window_exceeded",
    },
  });
}

describe("responses input-size guard", () => {
  test("rejects an input above the advertised context window without calling upstream", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    // The shared DeepSeek estimator uses 3.5 chars/token, so this is above the 1M window.
    const bigText = "a".repeat(4_200_000);
    const res = await postResponses(deepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: bigText }] }],
    });
    await expectOversizedRejection(res);
    expect(upstreamCalls).toBe(0);
  });

  test("rejects input above the per-model maximum-input limit even when below the context window", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    // OpenAI-style routes advertise 1,050,000 context but cap input at 922,000; an estimate
    // between the two must be rejected. 3.4M chars ≈ 971k tokens at 3.5 chars/token.
    const res = await postResponses(deepseekConfig({ maxInput: 922_000, contextWindow: 1_050_000 }), {
      model: "deepseek/deepseek-v4-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "a".repeat(3_400_000) }] }],
    });
    await expectOversizedRejection(res);
    expect(upstreamCalls).toBe(0);
  });

  test("rejects an oversized thread-spawn request before any quota polling", async () => {
    let upstreamCalls = 0;
    let quotaPrimeCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    setSubagentQuotaPrimeForTests(async () => {
      quotaPrimeCalls += 1;
    });
    const bigText = "a".repeat(4_200_000);
    const res = await postResponses(
      deepseekConfig(),
      {
        model: "deepseek/deepseek-v4-flash",
        input: [{ role: "user", content: [{ type: "input_text", text: bigText }] }],
      },
      { "x-openai-subagent": "collab_spawn" },
    );
    await expectOversizedRejection(res);
    expect(upstreamCalls).toBe(0);
    expect(quotaPrimeCalls).toBe(0);
  });

  test("rejects an oversized thread-spawn request before quota priming when a stricter fallback is selectable", async () => {
    let upstreamCalls = 0;
    let quotaPrimeCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    setSubagentQuotaPrimeForTests(async () => {
      quotaPrimeCalls += 1;
    });
    // The primary model fits the estimate (~600k tokens < 1M window), but the selectable
    // fallback is stricter (500k max input). Every candidate must be validated before the
    // quota probe runs, because priming can change which candidate is selected.
    const config = {
      port: 0,
      defaultProvider: "deepseek",
      subagentModelFallback: ["deepseek/deepseek-v4-lite"],
      providers: {
        deepseek: {
          adapter: "openai-responses",
          baseUrl: "https://api.deepseek.com",
          responsesPath: "/responses",
          authMode: "key",
          apiKey: "sk-test",
          models: ["deepseek-v4-flash", "deepseek-v4-lite"],
          modelContextWindows: {
            "deepseek-v4-flash": 1_000_000,
            "deepseek-v4-lite": 1_000_000,
          },
          modelMaxInputTokens: { "deepseek-v4-lite": 500_000 },
        },
      },
    } as OcxConfig;
    const res = await postResponses(
      config,
      {
        model: "deepseek/deepseek-v4-flash",
        input: [{ role: "user", content: [{ type: "input_text", text: "a".repeat(2_100_000) }] }],
      },
      { "x-openai-subagent": "collab_spawn" },
    );
    await expectOversizedRejection(res);
    expect(upstreamCalls).toBe(0);
    expect(quotaPrimeCalls).toBe(0);
  });

  test("rejects an oversized instructions value without calling upstream", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    // The parser moves `instructions` into context.systemPrompt, which adapters forward
    // upstream; a short message must not hide an oversized prompt from the guard.
    const bigInstructions = "a".repeat(4_200_000);
    const res = await postResponses(deepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      instructions: bigInstructions,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    await expectOversizedRejection(res);
    expect(upstreamCalls).toBe(0);
  });

  test("rejects an oversized tool schema without calling upstream", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    const res = await postResponses(deepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      tools: [
        {
          type: "function",
          name: "big_tool",
          description: "tool with an oversized schema",
          parameters: {
            type: "object",
            properties: {
              payload: { type: "string", description: "a".repeat(4_200_000) },
            },
          },
        },
      ],
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    await expectOversizedRejection(res);
    expect(upstreamCalls).toBe(0);
  });

  test("forwards an input within the window", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_x",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    const res = await postResponses(deepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
    expect(upstreamCalls).toBe(1);
    expect(res.status).toBe(200);
  });
});
