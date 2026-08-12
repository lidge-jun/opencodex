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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(testDir, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function deepseekConfig(): OcxConfig {
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
        modelContextWindows: { "deepseek-v4-flash": 1_000_000 },
      },
    },
  } as OcxConfig;
}

async function postResponses(config: OcxConfig, body: Record<string, unknown>): Promise<Response> {
  return handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    config,
    { model: "", provider: "" } as RequestLogContext,
  );
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
    expect(res.status).toBe(413);
    expect(upstreamCalls).toBe(0);
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
    expect(res.status).toBe(413);
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
    expect(res.status).toBe(413);
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
  });
});
