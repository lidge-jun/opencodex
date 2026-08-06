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
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
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
    // 4.2MB of text ≈ 1.05M tokens at 4 bytes/token — above the 1M window.
    const bigText = "a".repeat(4_200_000);
    const res = await postResponses(deepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      input: [{ role: "user", content: [{ type: "input_text", text: bigText }] }],
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

describe("routed compaction turn reframes bounded JSON to SSE", () => {
  function seededDeepseekConfig(): OcxConfig {
    const provider = { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
    enrichProviderFromRegistry("deepseek", provider);
    return {
      port: 0,
      defaultProvider: "deepseek",
      providers: { deepseek: provider },
    } as OcxConfig;
  }

  test("compaction_trigger with stream:true returns SSE with the compaction item and a terminal", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "resp_up",
        object: "response",
        status: "completed",
        model: "deepseek-v4-flash",
        output: [{
          id: "msg_1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "handoff summary text", annotations: [] }],
        }],
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    }) as typeof fetch;
    const res = await postResponses(seededDeepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "compaction_trigger" },
      ],
    });
    expect(upstreamCalls).toBe(1);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("response.completed");
    expect(body).toContain('"type":"compaction"');
    expect(body).toContain("[DONE]");
    expect(body.indexOf('"type":"compaction"')).toBeLessThan(body.indexOf("response.completed"));
  });

  test("same compaction turn without stream:true stays JSON", async () => {
    globalThis.fetch = (async () => Response.json({
      id: "resp_up",
      object: "response",
      status: "completed",
      model: "deepseek-v4-flash",
      output: [{
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "handoff summary text", annotations: [] }],
      }],
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    })) as typeof fetch;
    const res = await postResponses(seededDeepseekConfig(), {
      model: "deepseek/deepseek-v4-flash",
      stream: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "compaction_trigger" },
      ],
    });
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.text();
    expect(body).toContain('"type":"compaction"');
  });
});
