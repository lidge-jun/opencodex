import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { clearKeyCooldowns } from "../src/providers/key-failover";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-ratelimit-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-ratelimit-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  // A failed removal must not skip the cooldown reset below, and must not fail a
  // test that already asserted: on Windows a shutting-down server can hold a file
  // in this tree past the retry budget.
  if (testDir) {
    try {
      removeTreeWithRetry(testDir);
    } catch {
      // Left to the OS; the state that matters is reset below.
    }
  }
  clearKeyCooldowns();
});

const okChatCompletion = JSON.stringify({
  id: "chatcmpl-ratelimit",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "ok after retry" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

/** POST a non-streaming `/v1/responses` request to the proxy under test. */
async function postResponses(serverUrl: string, model: string): Promise<Response> {
  return fetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream: false }),
  });
}

describe("server same-target 429 retry (end-to-end)", () => {
  test("single-key provider replays the identical request until upstream succeeds", async () => {
    const originalFetch = globalThis.fetch;
    const seenBodies: string[] = [];
    const seenHeaders: string[][] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        seenBodies.push(String(init?.body));
        seenHeaders.push(
          [...new Headers(init?.headers).entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .flat(),
        );
        if (seenBodies.length <= 2) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "1", "content-type": "application/json" },
          });
        }
        return new Response(okChatCompletion, { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "blsc",
        providers: {
          blsc: {
            adapter: "openai-chat",
            baseUrl: "https://llmapi.blsc.cn",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            retryOn429: { attempts: 2, intervalMs: 120, respectRetryAfter: false },
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startServer(0);
      const res = await postResponses(server.url, "blsc/DeepSeek-V4-Flash");
      expect(res.status).toBe(200);
      const json = await res.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("ok after retry");
      expect(seenBodies).toHaveLength(3);
      expect(seenBodies[0]).toBe(seenBodies[1]);
      expect(seenBodies[1]).toBe(seenBodies[2]);
      // Same-target replays reuse the ONE built request: full header set identical too.
      expect(seenHeaders).toHaveLength(3);
      expect(seenHeaders[0]).toEqual(seenHeaders[1]);
      expect(seenHeaders[1]).toEqual(seenHeaders[2]);
    } finally {
      try {
        await server?.stop(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("without retryOn429 the 429 surfaces immediately with Retry-After", async () => {
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        sends += 1;
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "17", "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "blsc",
        providers: {
          blsc: {
            adapter: "openai-chat",
            baseUrl: "https://llmapi.blsc.cn",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startServer(0);
      const res = await postResponses(server.url, "blsc/DeepSeek-V4-Flash");
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("17");
      const json = await res.json() as { error?: { type?: string } };
      expect(json.error?.type).toBe("rate_limit_error");
      expect(sends).toBe(1);
    } finally {
      try {
        await server?.stop(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("exhausted attempts surface the 429", async () => {
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        sends += 1;
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "1", "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "blsc",
        providers: {
          blsc: {
            adapter: "openai-chat",
            baseUrl: "https://llmapi.blsc.cn",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startServer(0);
      const res = await postResponses(server.url, "blsc/DeepSeek-V4-Flash");
      expect(res.status).toBe(429);
      expect(sends).toBe(2);
    } finally {
      try {
        await server?.stop(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("same-key retries run before multi-key failover, which still works after they exhaust", async () => {
    const originalFetch = globalThis.fetch;
    const seenAuth: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        seenAuth.push(auth);
        if (auth.includes("key-beta")) {
          return new Response(okChatCompletion, { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "1", "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "blsc",
        providers: {
          blsc: {
            adapter: "openai-chat",
            baseUrl: "https://llmapi.blsc.cn",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            apiKeyPool: [
              { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
              { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
            ],
            retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startServer(0);
      const res = await postResponses(server.url, "blsc/DeepSeek-V4-Flash");
      expect(res.status).toBe(200);
      expect(seenAuth).toEqual([
        "Bearer key-alpha-000111222333",
        "Bearer key-alpha-000111222333",
        "Bearer key-beta-444555666777",
      ]);
    } finally {
      try {
        await server?.stop(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("key-auth openai-responses passthrough replays 429 on the same key", async () => {
    const originalFetch = globalThis.fetch;
    let sends = 0;
    const seenAuth: string[] = [];
    const seenBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://passthrough.test/v1/responses") {
        sends += 1;
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        seenAuth.push(auth);
        seenBodies.push(String(init?.body));
        if (sends === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: "resp-ok",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok after retry" }] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "passthrough",
        providers: {
          passthrough: {
            adapter: "openai-responses",
            baseUrl: "https://passthrough.test/v1",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            retryOn429: { attempts: 2, intervalMs: 120, respectRetryAfter: false },
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startServer(0);
      const res = await postResponses(server.url, "passthrough/model");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("ok after retry");
      expect(sends).toBe(2);
      expect(seenAuth).toEqual([
        "Bearer key-alpha-000111222333",
        "Bearer key-alpha-000111222333",
      ]);
      expect(seenBodies).toHaveLength(2);
      expect(seenBodies[0]).toBe(seenBodies[1]);
    } finally {
      try {
        await server?.stop(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("retry budget stays per request across multi-key failover (never re-arms)", async () => {
    const originalFetch = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://llmapi.blsc.cn/chat/completions") {
        sends += 1;
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    let server: ReturnType<typeof startServer> | null = null;
    try {
      const config = {
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "blsc",
        providers: {
          blsc: {
            adapter: "openai-chat",
            baseUrl: "https://llmapi.blsc.cn",
            authMode: "key",
            apiKey: "key-alpha-000111222333",
            apiKeyPool: [
              { id: "k1", key: "key-alpha-000111222333", addedAt: 1 },
              { id: "k2", key: "key-beta-444555666777", addedAt: 2 },
            ],
            retryOn429: { attempts: 1, intervalMs: 120, respectRetryAfter: false },
          },
        },
      } as OcxConfig;
      saveConfig(config);
      server = startServer(0);
      const res = await postResponses(server.url, "blsc/DeepSeek-V4-Flash");
      expect(res.status).toBe(429);
      // attempts(1) on the first key + one failover key = 3 sends; a re-armed budget would
      // have replayed on the second key too (4+ sends).
      expect(sends).toBe(3);
    } finally {
      try {
        await server?.stop(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });
});
