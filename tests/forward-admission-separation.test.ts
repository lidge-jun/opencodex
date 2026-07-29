import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { resolveFirstUsableOpenAiSidecar } from "../src/providers/openai-sidecar";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";
let upstreamAttempts: string[] = [];

function forwardConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-forward-admission-"));
  process.env.OPENCODEX_HOME = testHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  upstreamAttempts = [];
  globalThis.fetch = (async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") {
      upstreamAttempts.push(url.toString());
      return Response.json({ error: "unexpected upstream request" }, { status: 500 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("management credentials never leave data-plane forwarding paths", () => {
  test("the shared OpenAI sidecar refuses a management bearer", async () => {
    const config = forwardConfig();
    const provider = config.providers.openai!;
    const selected = await resolveFirstUsableOpenAiSidecar(
      [{ providerName: "openai", provider, accountMode: "direct" }],
      new Headers({ authorization: "Bearer admin-secret" }),
      config,
    );
    expect(selected).toBeUndefined();
    expect(upstreamAttempts).toHaveLength(0);
  });

  for (const request of [
    {
      name: "ordinary Responses",
      expectedStatus: 401,
      path: "/v1/responses",
      contentType: "application/json",
      body: JSON.stringify({ model: "openai/gpt-test", input: "hello" }),
    },
    {
      name: "compact Responses",
      expectedStatus: 401,
      path: "/v1/responses/compact",
      contentType: "application/json",
      body: JSON.stringify({ model: "openai/gpt-test", input: [] }),
    },
    {
      name: "Images",
      expectedStatus: 400,
      path: "/v1/images/generations",
      contentType: "application/json",
      body: JSON.stringify({ model: "gpt-image-2", prompt: "test" }),
    },
    {
      name: "Live",
      expectedStatus: 401,
      path: "/v1/live",
      contentType: "application/json",
      body: JSON.stringify({ sdp: "v=0", session: { model: "gpt-live" } }),
    },
    {
      name: "Search",
      expectedStatus: 401,
      path: "/v1/alpha/search",
      contentType: "application/json",
      body: JSON.stringify({ id: "search-session", model: "gpt-test" }),
    },
  ]) {
    test(`${request.name} rejects a management bearer before upstream I/O`, async () => {
      saveConfig(forwardConfig());
      const server = startServer(0);
      try {
        const response = await originalFetch(new URL(request.path, server.url), {
          method: "POST",
          headers: {
            "content-type": request.contentType,
            authorization: "Bearer admin-secret",
          },
          body: request.body,
        });
        expect(response.status).toBe(request.expectedStatus);
        expect(upstreamAttempts).toHaveLength(0);
      } finally {
        await server.stop(true);
      }
    });
  }
});
