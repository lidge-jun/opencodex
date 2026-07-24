import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originalFetch = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-directory-route-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-directory-route-"));
  process.env.OPENCODEX_HOME = testDir;
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

test("a directory-only provider can be saved and routes a chat call through its generic adapter", async () => {
  const preset = getProviderRegistryEntry("pollinations");
  expect(preset).toMatchObject({
    directoryOnly: true,
    adapter: "openai-chat",
    baseUrl: "https://gen.pollinations.ai/v1",
    keyOptional: true,
  });

  const upstream: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://gen.pollinations.ai") {
      throw new Error(`unexpected upstream request: ${request.method} ${request.url}`);
    }
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    if (url.pathname === "/v1/chat/completions") {
      upstream.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: await request.clone().json() as Record<string, unknown>,
      });
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "directory route ok" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("unexpected directory provider path", { status: 404 });
  }) as typeof fetch;

  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "seed",
    providers: {
      seed: {
        adapter: "openai-chat",
        baseUrl: "https://seed.example/v1",
        authMode: "key",
        models: ["seed-model"],
        liveModels: false,
      },
    },
  } as OcxConfig);

  const server = startServer(0);
  try {
    const addResponse = await originalFetch(new URL("/api/providers", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "pollinations",
        setDefault: true,
        provider: {
          adapter: preset?.adapter,
          baseUrl: preset?.baseUrl,
          authMode: "key",
          apiKey: "directory-secret",
          defaultModel: "test-model",
          selectedModels: ["test-model"],
        },
      }),
    });
    expect(addResponse.status).toBe(200);

    const saved = JSON.parse(readFileSync(join(testDir, "config.json"), "utf8")) as OcxConfig;
    expect(saved.defaultProvider).toBe("pollinations");
    expect(saved.providers.pollinations).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://gen.pollinations.ai/v1",
      apiKey: "directory-secret",
      keyOptional: true,
      defaultModel: "test-model",
      selectedModels: ["test-model"],
    });

    const chatResponse = await originalFetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pollinations/test-model",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(chatResponse.status).toBe(200);
    expect(await chatResponse.json()).toMatchObject({
      object: "chat.completion",
      model: "pollinations/test-model",
      choices: [{ message: { role: "assistant", content: "directory route ok" }, finish_reason: "stop" }],
    });
    expect(upstream).toHaveLength(1);
    expect(upstream[0]).toMatchObject({
      url: "https://gen.pollinations.ai/v1/chat/completions",
      authorization: "Bearer directory-secret",
      body: { model: "test-model" },
    });
  } finally {
    await server.stop(true);
  }
}, 10_000);
