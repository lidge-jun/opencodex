import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";

const inspectNativeCodexOwnership = ownedServiceHomeInspection("chat completions pool-mode test");

describe("chat-completions pool vs direct credential injection", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-chat-pool-test-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-chat-pool-test-"));
    process.env.OPENCODEX_HOME = testDir;
    globalThis.fetch = originalFetch;
  });

  afterEach(async () => {
    process.env.OPENCODEX_HOME = previousHome;
    globalThis.fetch = originalFetch;
    if (isolatedCodexHome) {
      isolatedCodexHome.restore();
      isolatedCodexHome = null;
    }
    if (testDir) {
      await removeTreeWithRetry(testDir);
    }
  });

  test("POST /v1/chat/completions in pool mode does not claim or inject native main bearer", async () => {
    writeFileSync(
      join(isolatedCodexHome!.path, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "native-main-token-pool", account_id: "main-account-uuid" },
      }),
    );

    const seen: Array<{ authorization: string | null; chatgptAccountId: string | null }> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({
          authorization: req.headers.get("authorization"),
          chatgptAccountId: req.headers.get("chatgpt-account-id"),
        });
        return Response.json({
          id: "resp_pool_test",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pool-ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
        return originalFetch(new URL(`${url.pathname.slice("/backend-api/codex".length)}${url.search}`, upstream.url), init);
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    saveConfig({
      port: 0,
      defaultProvider: "openai",
      codexDesktopAuthless: true,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    } as OcxConfig);

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer proxy-client-token",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.choices[0].message.content).toBe("pool-ok");
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
      upstream.stop(true);
      globalThis.fetch = originalFetch;
    }
  });
});
