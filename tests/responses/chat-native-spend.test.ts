import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";

let previousHome: string | undefined;
let testDir = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-spend-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-spend-"));
  process.env.OPENCODEX_HOME = testDir;
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function mockChatUpstreamCapturing() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function mockConfig(baseUrl: string, providerOverrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "k",
        allowPrivateNetwork: true,
        ...providerOverrides,
      },
    },
  } as OcxConfig;
}

test("native Chat refuses a physical send that exceeds the configured pool spend ceiling", async () => {
  takeSpendHome();
  const upstream = mockChatUpstreamCapturing();
  const config = mockConfig(`${upstream.server.url.toString().replace(/\/$/, "")}/v1`);
  config.spend = { pool: { maxTokens: 1 } };
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
    expect(upstream.captured).toHaveLength(0);
  } finally {
    await server.stop(true);
    upstream.server.stop(true);
  }
});

test("native Chat includes tool definitions in its pre-dispatch spend reservation", async () => {
  takeSpendHome();
  const upstream = mockChatUpstreamCapturing();
  const config = mockConfig(`${upstream.server.url.toString().replace(/\/$/, "")}/v1`);
  config.spend = { pool: { maxTokens: 500 } };
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content: "hello" }],
        max_tokens: 1, tools: [{ type: "function", function: { name: "large_tool", description: "large schema ".repeat(2_000), parameters: { type: "object" } } }] }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
    expect(upstream.captured).toHaveLength(0);
  } finally {
    await server.stop(true);
    upstream.server.stop(true);
  }
});
