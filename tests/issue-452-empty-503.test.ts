import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../src/codex/routing";
import {
  canonicalCodexUpstreamHostKey,
  clearCodexUpstreamHostHealth,
  getCodexUpstreamHostHealth,
} from "../src/codex/upstream-host-health";
import { saveConfig } from "../src/config";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests } from "../src/lib/debug-settings";
import { setDraining } from "../src/server/lifecycle";
import { startServer } from "../src/server";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";
import type { OcxConfig, OcxParsedRequest } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

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
  clearCodexUpstreamHostHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountQuota();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
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

async function withPoolPassthrough(
  reply: (request: Request) => Response | Promise<Response>,
  run: (serverUrl: string) => Promise<void>,
  options: { twoAccounts?: boolean } = {},
): Promise<void> {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  clearCodexUpstreamHealth();
  clearCodexUpstreamHostHealth();
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
      ...(options.twoAccounts
        ? [{ id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" }]
        : []),
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
  if (options.twoAccounts) {
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool-b-token",
      refreshToken: "pool-b-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      chatgptAccountId: "acct-pool-b",
    });
    updateAccountQuota("pool-b", 20);
  }

  const server = startServer(0);
  try {
    await run(server.url.toString());
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}

function installCodexTransport(
  send: (init: RequestInit | undefined) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(value);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      return Promise.resolve(send(init));
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

async function sendRegularPoolRequest(serverUrl: string): Promise<Response> {
  return originalGlobalFetch(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: false }),
  });
}

describe("regular Codex provider-host settlement (#914)", () => {
  const hostKey = canonicalCodexUpstreamHostKey("openai", "https://chatgpt.com/backend-api/codex/responses")!;

  test("a bare rejection changes host health but not account health", async () => {
    await withPoolPassthrough(() => new Response("unused"), async serverUrl => {
      let sends = 0;
      installCodexTransport(() => {
        sends += 1;
        throw new Error("opaque transport rejection");
      });
      const response = await sendRegularPoolRequest(serverUrl);
      expect(response.status).toBe(502);
      expect(sends).toBe(1);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHostHealth(hostKey)?.consecutiveFailures).toBe(1);
    });
  });

  test("a 503 followed by rejection records one account outcome and a terminal host failure", async () => {
    await withPoolPassthrough(() => new Response("unused"), async serverUrl => {
      let sends = 0;
      installCodexTransport(() => {
        sends += 1;
        if (sends === 1) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
        throw new Error("opaque transport rejection");
      });
      const response = await sendRegularPoolRequest(serverUrl);
      expect(response.status).toBe(502);
      expect(sends).toBe(2);
      expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBe(503);
      expect(getCodexUpstreamHostHealth(hostKey)?.consecutiveFailures).toBe(1);
    });
  });

  test("a connect timeout changes host health without changing account health", async () => {
    await withPoolPassthrough(() => new Response("unused"), async serverUrl => {
      const timeout = new Error("header timeout");
      timeout.name = "TimeoutError";
      installCodexTransport(() => { throw timeout; });
      const response = await sendRegularPoolRequest(serverUrl);
      expect(response.status).toBe(502);
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
      expect(getCodexUpstreamHostHealth(hostKey)?.consecutiveFailures).toBe(1);
    });
  });

  test("an open host circuit returns a bounded Retry-After without another send", async () => {
    await withPoolPassthrough(() => new Response("unused"), async serverUrl => {
      let sends = 0;
      installCodexTransport(() => {
        sends += 1;
        throw new Error("opaque transport rejection");
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        expect((await sendRegularPoolRequest(serverUrl)).status).toBe(502);
      }
      const blocked = await sendRegularPoolRequest(serverUrl);
      expect(blocked.status).toBe(502);
      expect(sends).toBe(3);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    });
  });

  test("manual redirect is credential-visible, bounded, and does not expose Location", async () => {
    await withPoolPassthrough(() => new Response("unused"), async serverUrl => {
      let redirectMode: RequestRedirect | undefined;
      installCodexTransport(init => {
        redirectMode = init?.redirect;
        return new Response(null, {
          status: 307,
          headers: { location: "https://dead.example/private-path" },
        });
      });
      const response = await sendRegularPoolRequest(serverUrl);
      expect(response.status).toBe(502);
      expect(response.headers.get("location")).toBeNull();
      expect(redirectMode).toBe("manual");
      expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBe(502);
      expect(getCodexUpstreamHostHealth(hostKey)).toBeNull();
    });
  });

  test("alternate-account bare rejection remains one B send and host-only", async () => {
    await withPoolPassthrough(() => new Response("unused"), async serverUrl => {
      let sends = 0;
      installCodexTransport(() => {
        sends += 1;
        if (sends === 1) return new Response("quota", { status: 429 });
        throw new Error("opaque alternate rejection");
      });
      const response = await sendRegularPoolRequest(serverUrl);
      expect(response.status).toBe(502);
      expect(sends).toBe(2);
      expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBe(429);
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      expect(getCodexUpstreamHostHealth(hostKey)?.consecutiveFailures).toBe(1);
    }, { twoAccounts: true });
  });
});

describe("passthrough empty 503 (#452)", () => {
  test("ChatGPT passthrough empty-body 503 becomes JSON Codex can parse", async () => {
    await withPoolPassthrough(
      () => new Response(null, { status: 503 }),
      async (serverUrl) => {
        const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: false }),
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

  test("direct /v1/responses preserves Retry-After on empty-body 429 and 503", async () => {
    for (const status of [429, 503] as const) {
      await withPoolPassthrough(
        () => new Response(null, { status, headers: { "Retry-After": "1" } }),
        async (serverUrl) => {
          const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
            body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: false }),
          });
          expect(response.status).toBe(status);
          expect(response.headers.get("content-type")).toContain("application/json");
          expect(response.headers.get("retry-after")).toBe("1");
        },
      );
    }
  });

  test("direct /v1/responses drops invalid Retry-After on empty-body 503", async () => {
    await withPoolPassthrough(
      () => new Response(null, { status: 503, headers: { "Retry-After": "not-a-delay" } }),
      async (serverUrl) => {
        const response = await originalGlobalFetch(new URL("/v1/responses", serverUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer inbound-token" },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: false }),
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
            model: "gpt-5.6-sol",
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
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
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
