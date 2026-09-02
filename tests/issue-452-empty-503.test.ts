import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { BOUNDED_BODY_MAX_BYTES } from "../src/lib/bounded-body";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests } from "../src/lib/debug-settings";
import { setDraining } from "../src/server/lifecycle";
import { startServer } from "../src/server";
import { readDisplaySafeErrorText } from "../src/server/responses/core";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";
import type { OcxConfig, OcxParsedRequest } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousOcxDebug = process.env.OCX_DEBUG;
const originalGlobalFetch = globalThis.fetch;
const TEST_DIR = join(import.meta.dir, ".tmp-issue-452-empty-503");
let isolatedCodexHome: IsolatedCodexHome | null = null;

function redirectCanonicalCodexTo(baseUrl: string): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, baseUrl);
      return originalGlobalFetch(target, init);
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-issue-452-");
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  setDraining(false);
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
  setDraining(false);
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousOcxDebug === undefined) delete process.env.OCX_DEBUG;
  else process.env.OCX_DEBUG = previousOcxDebug;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("formatPassthroughUpstreamError (#452)", () => {
  test("empty body becomes a JSON error with a non-empty message", async () => {
    const response = formatPassthroughUpstreamError(503, "");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = await response.json() as { error?: { message?: string; code?: string | null } };
    expect(json.error?.message?.trim().length).toBeGreaterThan(0);
    expect(json.error?.message).toContain("503");
    expect(json.error?.message?.toLowerCase()).not.toBe("unknown error");
  });

  test("empty body preserves validated Retry-After and forces application/json", async () => {
    const headers = new Headers({ "retry-after": "12", "x-other": "drop-me" });
    const response = formatPassthroughUpstreamError(429, "", { headers });
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("retry-after")).toBe("12");
    expect(response.headers.get("x-other")).toBeNull();
  });

  test("empty body drops invalid Retry-After values", async () => {
    // "0" is intentionally preserved as an instant-retry client directive
    // (see resolveClientRetryAfter / #507 review hardening).
    for (const bad of ["", "nope", "-1", "1e6", "not-a-delay"]) {
      const headers = new Headers({ "retry-after": bad });
      const response = formatPassthroughUpstreamError(503, "", { headers, now: Date.now() });
      expect(response.headers.get("retry-after")).toBeNull();
    }
  });

  test("empty body preserves Retry-After: 0", async () => {
    const headers = new Headers({ "retry-after": "0" });
    const response = formatPassthroughUpstreamError(503, "", { headers, now: Date.now() });
    expect(response.headers.get("retry-after")).toBe("0");
  });

  test("JSON with error.message is preserved for Codex", async () => {
    const body = JSON.stringify({ error: { message: "no healthy upstream", type: "server_error" } });
    const response = formatPassthroughUpstreamError(503, body);
    expect(response.status).toBe(503);
    const json = await response.json() as { error?: { message?: string } };
    expect(json.error?.message).toBe("no healthy upstream");
  });

  test("non-empty body without error.message is relayed verbatim with headers", async () => {
    const body = JSON.stringify({ detail: "overloaded" });
    const headers = new Headers({ "content-type": "application/json", "x-pool-retry-test": "original" });
    const response = formatPassthroughUpstreamError(400, body, { statusText: "Bad Request", headers });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-pool-retry-test")).toBe("original");
    expect(await response.text()).toBe(body);
  });
});

describe("bounded passthrough error bodies", () => {
  test("preserves complete safe bodies, including an intentionally empty body", async () => {
    const signal = new AbortController().signal;
    expect(await readDisplaySafeErrorText(new Response("upstream detail"), signal, "fallback"))
      .toBe("upstream detail");
    expect(await readDisplaySafeErrorText(new Response(null), signal, "fallback")).toBe("");
  });

  test("drops an oversized prefix, cancels once, and does not drain the tail", async () => {
    let pullCount = 0;
    let cancelCount = 0;
    let tailPulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new Uint8Array(BOUNDED_BODY_MAX_BYTES).fill(0x61));
        } else if (pullCount === 2) {
          controller.enqueue(new Uint8Array([0x62]));
        } else {
          tailPulled = true;
          controller.enqueue(new Uint8Array([0x63]));
        }
      },
      cancel() { cancelCount += 1; },
    }, { highWaterMark: 0 });

    const text = await readDisplaySafeErrorText(
      new Response(body),
      new AbortController().signal,
      "status only",
    );
    await Promise.resolve();

    expect(text).toBe("status only");
    expect(cancelCount).toBe(1);
    expect(tailPulled).toBe(false);
    expect(body.locked).toBe(false);
  });

  test("uses the fallback after a read rejection or caller abort", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() { throw new Error("upstream reset"); },
    });
    expect(await readDisplaySafeErrorText(
      new Response(failing),
      new AbortController().signal,
      "fallback",
    )).toBe("fallback");
    expect(failing.locked).toBe(false);

    let cancelReason: unknown;
    const pending = new ReadableStream<Uint8Array>({
      pull() { return new Promise<never>(() => {}); },
      cancel(reason) { cancelReason = reason; },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const reason = { code: "caller-abort" };
    const reading = readDisplaySafeErrorText(new Response(pending), controller.signal, "fallback");
    controller.abort(reason);
    expect(await reading).toBe("fallback");
    await Promise.resolve();
    expect(cancelReason).toBe(reason);
    expect(pending.locked).toBe(false);
  });
});

async function withPoolPassthrough(
  reply: (request: Request) => Response | Promise<Response>,
  run: (serverUrl: string) => Promise<void>,
): Promise<void> {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");

  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      return reply(request);
    },
  });
  redirectCanonicalCodexTo(upstream.url.toString());

  saveConfig({
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
    ],
    activeCodexAccountId: "pool-a",
  } as OcxConfig);
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-a-token",
    refreshToken: "pool-a-refresh",
    expiresAt: Date.now() + 10 * 60_000,
    chatgptAccountId: "acct-pool-a",
  });
  updateAccountQuota("pool-a", 10);

  const server = startServer(0);
  try {
    await run(server.url.toString());
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}

describe("passthrough empty 503 (#452)", () => {
  test("ChatGPT passthrough empty-body 503 becomes JSON Codex can parse", async () => {
    await withPoolPassthrough(
      () => new Response(null, { status: 503 }),
      async (serverUrl) => {
        const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
          body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: false }),
        });
        expect(response.status).toBe(503);
        const text = await response.text();
        expect(text.trim().length).toBeGreaterThan(0);
        const json = JSON.parse(text) as { error?: { message?: string } };
        expect(typeof json.error?.message).toBe("string");
        expect(json.error!.message!.trim().length).toBeGreaterThan(0);
        expect(json.error!.message!.toLowerCase()).not.toBe("unknown error");
      },
    );
  });

  test("oversized passthrough errors become bounded status-only JSON", async () => {
    const hostilePrefix = "do-not-relay-this-prefix";
    const body = hostilePrefix + "x".repeat(BOUNDED_BODY_MAX_BYTES + 1);
    await withPoolPassthrough(
      () => new Response(body, {
        status: 418,
        statusText: "Upstream Teapot",
        headers: { "content-type": "text/plain", "retry-after": "4" },
      }),
      async (serverUrl) => {
        const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
          body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: false }),
        });
        expect(response.status).toBe(418);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(response.headers.get("retry-after")).toBe("4");
        const text = await response.text();
        expect(text.length).toBeLessThan(1_024);
        expect(text).not.toContain(hostilePrefix);
        const json = JSON.parse(text) as { error?: { message?: string } };
        expect(json.error?.message).toContain("418");
      },
    );
  });

  test("direct /v1/responses preserves Retry-After on empty-body 429 and 503", async () => {
    for (const status of [429, 503] as const) {
      await withPoolPassthrough(
        () => new Response(null, { status, headers: { "Retry-After": "1" } }),
        async (serverUrl) => {
          const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
            body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: false }),
          });
          expect(response.status).toBe(status);
          expect(response.headers.get("content-type")).toContain("application/json");
          expect(response.headers.get("retry-after")).toBe("1");
        },
      );
    }
    // Two full pool-passthrough cycles, each binding a real proxy and a real upstream,
    // so the wait is the assertion rather than an accident: it measured ~6s here against
    // Bun's 5s default.
  }, SERVER_BUDGET_MS);

  test("direct /v1/responses drops invalid Retry-After on empty-body 503", async () => {
    await withPoolPassthrough(
      () => new Response(null, { status: 503, headers: { "Retry-After": "not-a-delay" } }),
      async (serverUrl) => {
        const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
          body: JSON.stringify({ model: "gpt-5.5", input: "hi", stream: false }),
        });
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBeNull();
      },
    );
  });

  test("/v1/chat/completions forwards Retry-After from empty-body upstream 429", async () => {
    await withPoolPassthrough(
      () => new Response(null, { status: 429, headers: { "Retry-After": "3" } }),
      async (serverUrl) => {
        const response = await originalGlobalFetch(new URL("/v1/chat/completions", serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
          body: JSON.stringify({
            model: "gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
            stream: false,
          }),
        });
        expect(response.status).toBe(429);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(response.headers.get("retry-after")).toBe("3");
      },
    );
  });
});

describe("drain 503 JSON (#452)", () => {
  test("POST /v1/responses while draining returns JSON error body", async () => {
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({
      port: 0,
      defaultProvider: "xiaomi",
      providers: {
        xiaomi: {
          adapter: "openai-chat",
          baseUrl: "https://api.xiaomimimo.com/v1",
          apiKey: "key-xiaomi-000111222333",
          defaultModel: "mimo-v2.5-pro",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      setDraining(true);
      const response = await originalGlobalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mimo-v2.5-pro", input: "hi" }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      const json = await response.json() as { error?: { message?: string; code?: string | null } };
      expect(json.error?.message).toContain("shutting down");
      expect(json.error?.code).toBe("server_is_overloaded");
    } finally {
      setDraining(false);
      await server.stop(true);
    }
  });
});

describe("openai-chat provider debug (#452)", () => {
  test("buildRequest emits debugProviderDiagnostic when OCX_DEBUG=1", () => {
    process.env.OCX_DEBUG = "1";
    resetDebugLogBufferForTests();
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "sk-secret-xiaomi-key",
    });
    const parsed = {
      modelId: "mimo-v2.5-pro",
      stream: true,
      context: {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    adapter.buildRequest(parsed);
    const lines = getDebugLogEntries().map(e => e.line);
    expect(lines.some(line => line.includes("[ocx:openai-chat:request]"))).toBe(true);
    expect(lines.join("\n")).toContain('"host":"api.xiaomimimo.com"');
    expect(lines.join("\n")).not.toContain("sk-secret-xiaomi-key");
    expect(lines.join("\n")).not.toContain("/v1/chat/completions");
  });

  test("tenant-scoped baseUrl logs host only — account id never appears", () => {
    process.env.OCX_DEBUG = "1";
    resetDebugLogBufferForTests();
    const accountId = "cf-account-abc123secret";
    const adapter = createOpenAIChatAdapter({
      adapter: "openai-chat",
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      apiKey: "cf-key-should-not-appear",
    });
    const parsed = {
      modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      stream: false,
      context: {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      },
      options: {},
    } as unknown as OcxParsedRequest;
    adapter.buildRequest(parsed);
    const joined = getDebugLogEntries().map(e => e.line).join("\n");
    expect(joined).toContain("[ocx:openai-chat:request]");
    expect(joined).toContain('"host":"api.cloudflare.com"');
    expect(joined).not.toContain(accountId);
    expect(joined).not.toContain("/accounts/");
    expect(joined).not.toContain("cf-key-should-not-appear");
    expect(joined).not.toContain("/ai/v1");
  });
});
