import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  getEffectiveActiveCodexAccountId,
  getHostConnectHealth,
  hostConnectHealthKey,
  isCodexAccountSoftAvoided,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const ORIGINAL_FETCH = globalThis.fetch;
const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const THREAD = "thread-914";
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let outage = false;

function stubPoolUpstream(): void {
  outage = true;
  globalThis.fetch = (async (input, init) => {
    const requestUrl = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.toString()
        : String(input);
    const url = new URL(requestUrl);
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
      if (outage) {
        // Bun 1.3.14's real DNS-failure rejection shape (probe-verified 2026-08-04):
        // code "ConnectionRefused", errno 0, no cause.
        throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
          code: "ConnectionRefused",
          errno: 0,
        });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        id: "resp-issue-914",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.6-sol",
        output: [{
          type: "message",
          id: "msg-1",
          role: "assistant",
          content: [{ type: "output_text", text: auth.includes("access-a") ? "served-by-a" : "served-by-other" }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return ORIGINAL_FETCH(input, init);
  }) as typeof fetch;
}

function makePoolConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    upstreamFailoverThreshold: 3,
    accountPoolStrategy: "fill-first",
    activeCodexAccountId: "a",
    codexAccounts: [
      { id: "a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-a" },
      { id: "b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-b" },
    ],
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: CODEX_BASE,
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    ...overrides,
  } as OcxConfig;
}

function saveTestCredentials(): void {
  for (const id of ["a", "b"]) {
    saveCodexAccountCredential(id, {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 10 * 60_000,
      chatgptAccountId: `acct-${id}`,
    });
  }
}

function responsesRequest(serverUrl: string, thread = THREAD): Promise<Response> {
  return ORIGINAL_FETCH(new URL("/v1/responses", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": thread },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
  });
}

function compactRequest(serverUrl: string, thread = THREAD): Promise<Response> {
  return ORIGINAL_FETCH(new URL("/v1/responses/compact", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": thread },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "compact this conversation" }),
  });
}

function expectRoutingStateUnchanged(config: OcxConfig, hostLedgerKey: string, expectedFailures: number): void {
  expect(getCodexUpstreamHealth("a")).toBeNull();
  expect(isCodexAccountSoftAvoided("a")).toBe(false);
  expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
  expect(resolveCodexAccountForThread(THREAD, config)).toBe("a");
  expect(getHostConnectHealth(hostLedgerKey)?.consecutiveFailures).toBe(expectedFailures);
}

describe("issue #914: pre-connection reachability failures are account-neutral", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-issue-914-"));
    process.env.OPENCODEX_HOME = testDir;
    isolatedCodexHome = installIsolatedCodexHome("ocx-issue-914-codex-");
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    saveTestCredentials();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("regular passthrough: three concurrent DNS failures return 502 but leave routing state unchanged", async () => {
    const config = makePoolConfig();
    saveConfig(config);
    stubPoolUpstream();
    const server = startServer(0);
    try {
      const concurrent = await Promise.all([
        responsesRequest(server.url.toString()),
        responsesRequest(server.url.toString()),
        responsesRequest(server.url.toString()),
      ]);
      for (const res of concurrent) expect(res.status).toBe(502);
      expect((await responsesRequest(server.url.toString())).status).toBe(502);

      const key = hostConnectHealthKey("openai", "chatgpt.com");
      expectRoutingStateUnchanged(config, key, 4);
      // The client-visible failure keeps the existing wording.
      const body = await concurrent[0]!.text();
      expect(body).toContain("Provider unreachable");

      // Recovery: the same thread stays on account A and succeeds.
      outage = false;
      const recovered = await responsesRequest(server.url.toString());
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toContain("served-by-a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
      expect(getCodexUpstreamHealth("a")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("compact path: DNS failures do not rotate the account", async () => {
    const config = makePoolConfig();
    saveConfig(config);
    stubPoolUpstream();
    const server = startServer(0);
    try {
      const concurrent = await Promise.all([
        compactRequest(server.url.toString()),
        compactRequest(server.url.toString()),
        compactRequest(server.url.toString()),
      ]);
      for (const res of concurrent) expect(res.status).toBe(502);

      const key = hostConnectHealthKey("openai", "chatgpt.com");
      expectRoutingStateUnchanged(config, key, 3);

      outage = false;
      const recovered = await compactRequest(server.url.toString());
      expect(recovered.status).toBe(200);
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    } finally {
      await server.stop(true);
    }
  });

  test("real Bun pre-connection rejection (TCP refusal) is account-neutral", async () => {
    const config = makePoolConfig();
    saveConfig(config);
    // Keep the canonical provider config (pool mode is canonical-only) and remap
    // only the socket destination: the proxy's fetch goes to a dead local port,
    // so Bun itself performs the real pre-connect rejection (FailedToOpenSocket).
    globalThis.fetch = (async (input, init) => {
      const requestUrl = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      if (requestUrl.startsWith(CODEX_BASE)) {
        return ORIGINAL_FETCH(requestUrl.replace("https://chatgpt.com", "http://127.0.0.1:1"), init);
      }
      return ORIGINAL_FETCH(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const responses = await Promise.all([
        responsesRequest(server.url.toString()),
        responsesRequest(server.url.toString()),
        responsesRequest(server.url.toString()),
      ]);
      for (const res of responses) expect(res.status).toBe(502);

      const key = hostConnectHealthKey("openai", "chatgpt.com");
      expectRoutingStateUnchanged(config, key, 3);
      expect(getHostConnectHealth(key)?.lastFailureCode).toMatch(/FailedToOpenSocket|ConnectionRefused/);
    } finally {
      await server.stop(true);
    }
  });

  test("read-then-close resets stay account-attributed (#914 regression guard)", async () => {
    const config = makePoolConfig();
    saveConfig(config);
    // A server that reads the Authorization header and closes the socket rejects
    // with ECONNRESET — the credential was seen, so this MUST keep failing over
    // (the 2026-07-22 decision recorded in devlog/_fin/260722_issue_bug_sweep).
    globalThis.fetch = (async (input, init) => {
      const requestUrl = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      if (requestUrl.startsWith(CODEX_BASE)) {
        throw Object.assign(new Error("The socket connection was closed unexpectedly"), {
          code: "ECONNRESET",
          errno: 0,
        });
      }
      return ORIGINAL_FETCH(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const responses = await Promise.all([
        responsesRequest(server.url.toString(), "thread-reset"),
        responsesRequest(server.url.toString(), "thread-reset"),
        responsesRequest(server.url.toString(), "thread-reset"),
      ]);
      for (const res of responses) expect(res.status).toBe(502);

      expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 3, lastFailureStatus: 0 });
      expect(isCodexAccountSoftAvoided("a")).toBe(true);
      expect(resolveCodexAccountForThread("thread-reset", config)).toBe("b");
      // Pre-connect ledger is untouched: ECONNRESET is not a reachability code.
      expect(getHostConnectHealth(hostConnectHealthKey("openai", "chatgpt.com"))).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("mixed transient 5xx then rejection stays account-attributed (#914 review)", async () => {
    const config = makePoolConfig();
    saveConfig(config);
    let upstreamCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const requestUrl = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      const url = new URL(requestUrl);
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
        upstreamCalls += 1;
        if (upstreamCalls === 1) {
          return new Response("Service Unavailable", { status: 503, headers: { "content-type": "text/plain" } });
        }
        throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
          code: "ConnectionRefused",
          errno: 0,
        });
      }
      return ORIGINAL_FETCH(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const res = await responsesRequest(server.url.toString(), "thread-mixed-503");
      expect(res.status).toBe(502);

      // The upstream already answered 503 before the final rejection, so the
      // failure is account evidence — the pre-connection ledger must NOT swallow it.
      expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 0 });
      expect(isCodexAccountSoftAvoided("a")).toBe(false);
      expect(getHostConnectHealth(hostConnectHealthKey("openai", "chatgpt.com"))).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("pool sends relay 3xx instead of following a redirect into a dead host (#914 review)", async () => {
    const config = makePoolConfig();
    saveConfig(config);
    globalThis.fetch = (async (input, init) => {
      const requestUrl = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
      const url = new URL(requestUrl);
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
        if (init?.redirect !== "manual") {
          // What default-follow fetch would do: chase the 307 into a dead host and
          // reject with a pre-connection shape AFTER the credential was seen.
          throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
            code: "ConnectionRefused",
            errno: 0,
          });
        }
        return new Response(JSON.stringify({ location: "https://dead.invalid/x" }), {
          status: 307,
          headers: { "content-type": "application/json", location: "https://dead.invalid/x" },
        });
      }
      return ORIGINAL_FETCH(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      // The relayed 307 carries a Location header, so the test client must not
      // follow it (default-follow would chase it into the dead host).
      const res = await ORIGINAL_FETCH(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-parent-thread-id": "thread-redirect" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
        redirect: "manual",
      });
      expect(res.status).toBe(307);

      // 3xx is the neutral class: no account evidence, no host evidence.
      expect(getCodexUpstreamHealth("a")).toBeNull();
      expect(isCodexAccountSoftAvoided("a")).toBe(false);
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
      expect(getHostConnectHealth(hostConnectHealthKey("openai", "chatgpt.com"))).toBeNull();
    } finally {
      await server.stop(true);
    }
  });
});
