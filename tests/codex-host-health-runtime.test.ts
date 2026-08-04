import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  resolveCodexAccountForThread,
} from "../src/codex/routing";
import {
  CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD,
  canonicalCodexUpstreamHostKey,
  clearCodexUpstreamHostHealth,
  getCodexUpstreamHostHealth,
} from "../src/codex/upstream-host-health";
import { loadConfig, saveConfig } from "../src/config";
import { setDraining } from "../src/server/lifecycle";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const bunFetch = globalThis.fetch;
const canonicalPrefix = "/backend-api/codex";
const canonicalHostKey = canonicalCodexUpstreamHostKey(
  "openai",
  "https://chatgpt.com/backend-api/codex/responses",
)!;
const proxyEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "BUN_CONFIG_NO_PROXY",
] as const;

type StoppableServer = {
  port: number;
  url: URL;
  stop(force?: boolean): void | Promise<void>;
};

type CanonicalCall = {
  url: URL;
  init?: RequestInit;
  headers: Headers;
  accountId: string | null;
};

type RuntimeHarness = {
  config: OcxConfig;
  server: ReturnType<typeof startServer>;
  send(path: "/v1/responses" | "/v1/responses/compact", threadId?: string): Promise<Response>;
};

const trackedServers: StoppableServer[] = [];
const trackedNetServers: NetServer[] = [];
const trackedSockets = new Set<Socket>();
const temporaryHomes: string[] = [];
let isolatedCodexHome: IsolatedCodexHome | null = null;
let previousOpencodexHome: string | undefined;
let previousApiToken: string | undefined;
let proxyEnvSnapshot: Map<string, string | undefined> | null = null;

function trackServer<T extends StoppableServer>(server: T): T {
  trackedServers.push(server);
  return server;
}

function serve(fetchHandler: (request: Request) => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  return trackServer(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetchHandler }));
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isolateProxyEnvironment(): void {
  proxyEnvSnapshot = new Map(proxyEnvKeys.map(key => [key, process.env[key]]));
  for (const key of proxyEnvKeys) delete process.env[key];
  // Runtime fixtures must never inherit a workstation proxy for .invalid or loopback.
  process.env.NO_PROXY = "*";
  process.env.no_proxy = "*";
  process.env.BUN_CONFIG_NO_PROXY = "*";
}

function installCanonicalRouter(route: (call: CanonicalCall) => Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const value = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(value);
    if (url.hostname.toLowerCase() === "chatgpt.com" && url.pathname.startsWith(canonicalPrefix)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      return route({
        url,
        init,
        headers,
        accountId: headers.get("chatgpt-account-id"),
      });
    }
    return bunFetch(input, init);
  }) as typeof fetch;
}

function localTarget(base: string | URL, call: CanonicalCall): URL {
  return new URL(`${call.url.pathname}${call.url.search}`, base);
}

async function actualFetch(base: string | URL, call: CanonicalCall): Promise<Response> {
  return bunFetch(localTarget(base, call), call.init);
}

async function closedEphemeralPort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
    const port = probe.port;
    await probe.stop(true);
    try {
      const unexpectedlyOpen = await bunFetch(`http://127.0.0.1:${port}/closed-port-check`);
      await unexpectedlyOpen.body?.cancel().catch(() => undefined);
    } catch {
      return port;
    }
  }
  throw new Error("could not reserve and verify a refused loopback port");
}

async function startCredentialDependentReadThenCloseServer(): Promise<{
  url: string;
  requests: string[];
  successfulBRequests: string[];
}> {
  const requests: string[] = [];
  const successfulBRequests: string[] = [];
  const server = createServer(socket => {
    trackedSockets.add(socket);
    socket.on("error", () => {
      // Expected when this fixture deliberately severs a credential-bearing request.
    });
    let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      const headerEnd = bytes.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = bytes.subarray(0, headerEnd).toString("latin1");
      const lengthMatch = /\r\ncontent-length:\s*(\d+)/i.exec(`\r\n${headerText}`);
      if (!lengthMatch) return;
      const contentLength = Number(lengthMatch[1]);
      if (bytes.length - headerEnd - 4 < contentLength) return;
      const wire = bytes.subarray(0, headerEnd + 4 + contentLength).toString("utf8");
      requests.push(wire);
      socket.removeAllListeners("data");
      if (/\r\nauthorization:\s*Bearer pool-b-token\r\n/i.test(`\r\n${headerText}\r\n`)) {
        successfulBRequests.push(wire);
        const responseBody = JSON.stringify({ id: "healthy-b", status: "completed", output: [] });
        socket.end(
          "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
          + `content-length: ${Buffer.byteLength(responseBody)}\r\nconnection: close\r\n\r\n${responseBody}`,
        );
        return;
      }
      socket.destroy();
    });
    socket.on("close", () => trackedSockets.delete(socket));
  });
  trackedNetServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("raw runtime server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, requests, successfulBRequests };
}

async function startHarness(options: { twoAccounts?: boolean; connectTimeoutMs?: number } = {}): Promise<RuntimeHarness> {
  const home = mkdtempSync(join(tmpdir(), "ocx-host-runtime-"));
  temporaryHomes.push(home);
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  clearCodexUpstreamHealth();
  clearCodexUpstreamHostHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");

  const config = {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    accountPoolStrategy: "fill-first",
    upstreamFailoverThreshold: 3,
    ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
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
  } as OcxConfig;
  saveConfig(config);
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
  const server = trackServer(startServer(0));
  return {
    config,
    server,
    send: (path, threadId) => bunFetch(new URL(path, server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer inbound-runtime-token",
        ...(threadId ? { "x-codex-parent-thread-id": threadId } : {}),
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: path.endsWith("/compact") ? [] : "runtime transport probe",
        stream: false,
      }),
    }),
  };
}

function pinAWhileActiveB(harness: RuntimeHarness, threadId: string): void {
  expect(resolveCodexAccountForThread(threadId, harness.config)).toBe("pool-a");
  harness.config.activeCodexAccountId = "pool-b";
  saveConfig(harness.config);
  // Reset only account health/runtime-active state. The A affinity must remain bound.
  clearCodexUpstreamHealth();
  expect(loadConfig().activeCodexAccountId).toBe("pool-b");
}

function expectHostOnlyState(harness: RuntimeHarness, threadId: string): void {
  expect(getCodexUpstreamHealth("pool-a")).toBeNull();
  expect(getCodexUpstreamHealth("pool-b")).toBeNull();
  expect(loadConfig().activeCodexAccountId).toBe("pool-b");
  expect(resolveCodexAccountForThread(threadId, harness.config)).toBe("pool-a");
}

function runtimeErrorLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = "code" in error ? String((error as Error & { code?: unknown }).code ?? "") : "";
  return `${error.name}:${code}:${error.message}`;
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  isolateProxyEnvironment();
  isolatedCodexHome = installIsolatedCodexHome("ocx-host-runtime-codex-");
  setDraining(false);
});

afterEach(async () => {
  globalThis.fetch = bunFetch;
  for (const socket of trackedSockets) socket.destroy();
  trackedSockets.clear();
  for (const server of trackedServers.splice(0).reverse()) {
    try { await server.stop(true); } catch { /* best-effort fixture cleanup */ }
  }
  for (const server of trackedNetServers.splice(0).reverse()) {
    if (!server.listening) continue;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  setDraining(false);
  clearCodexUpstreamHealth();
  clearCodexUpstreamHostHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  restoreEnvValue("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnvValue("OPENCODEX_API_AUTH_TOKEN", previousApiToken);
  if (proxyEnvSnapshot) {
    for (const [key, value] of proxyEnvSnapshot) restoreEnvValue(key, value);
  }
  proxyEnvSnapshot = null;
});

describe("Codex host-health actual Bun runtime (#914/#922)", () => {
  test("repeated same .invalid failures open one canonical host circuit without account rotation", async () => {
    const harness = await startHarness({ twoAccounts: true });
    const threadId = "runtime-invalid-thread";
    pinAWhileActiveB(harness, threadId);
    const runtimeErrors: unknown[] = [];
    const accounts: Array<string | null> = [];
    let physicalSends = 0;
    const invalidOrigin = "http://same-host-health-target.invalid";
    installCanonicalRouter(async call => {
      physicalSends += 1;
      accounts.push(call.accountId);
      try {
        return await actualFetch(invalidOrigin, call);
      } catch (error) {
        runtimeErrors.push(error);
        throw error;
      }
    });

    for (let attempt = 0; attempt < CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD; attempt++) {
      expect((await harness.send("/v1/responses", threadId)).status).toBe(502);
    }
    const sendsAtOpen = physicalSends;
    const blocked = await harness.send("/v1/responses", threadId);

    expect(blocked.status).toBe(502);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(physicalSends).toBe(sendsAtOpen);
    expect(physicalSends).toBe(CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD);
    expect(accounts).toEqual(Array(CODEX_UPSTREAM_HOST_FAILURE_THRESHOLD).fill("acct-pool-a"));
    // Bun 1.3.14 on Windows has emitted more than one label for this same target.
    // Activation correctness intentionally depends only on real rejection count.
    expect(runtimeErrors.map(runtimeErrorLabel).every(label => label.length > 0)).toBe(true);
    expect(getCodexUpstreamHostHealth(canonicalHostKey)?.cooldownUntil).toEqual(expect.any(Number));
    const invalidKey = canonicalCodexUpstreamHostKey("openai", invalidOrigin)!;
    expect(invalidKey).not.toBe(canonicalHostKey);
    expect(getCodexUpstreamHostHealth(invalidKey)).toBeNull();
    expectHostOnlyState(harness, threadId);
  }, { timeout: 30_000 });

  test("native compact records a real refused closed port as host-only", async () => {
    const harness = await startHarness({ twoAccounts: true });
    const threadId = "runtime-compact-refused";
    pinAWhileActiveB(harness, threadId);
    const port = await closedEphemeralPort();
    const target = `http://127.0.0.1:${port}`;
    let physicalSends = 0;
    installCanonicalRouter(async call => {
      physicalSends += 1;
      return actualFetch(target, call);
    });

    const response = await harness.send("/v1/responses/compact", threadId);
    expect(response.status).toBe(502);
    expect(physicalSends).toBe(1);
    expect(getCodexUpstreamHostHealth(canonicalHostKey)?.consecutiveFailures).toBe(1);
    expect(getCodexUpstreamHostHealth(canonicalCodexUpstreamHostKey("openai", target)!)).toBeNull();
    expectHostOnlyState(harness, threadId);
  }, { timeout: 10_000 });

  test("an actual delayed-header timeout is host-only", async () => {
    const harness = await startHarness({ twoAccounts: true, connectTimeoutMs: 500 });
    const threadId = "runtime-header-timeout";
    pinAWhileActiveB(harness, threadId);
    const seen: Array<{ authorization: string | null; accountId: string | null; body: string }> = [];
    const delayed = serve(async request => {
      seen.push({
        authorization: request.headers.get("authorization"),
        accountId: request.headers.get("chatgpt-account-id"),
        body: await request.text(),
      });
      await Bun.sleep(2_000);
      return Response.json({ id: "too-late", status: "completed", output: [] });
    });
    installCanonicalRouter(call => actualFetch(delayed.url, call));

    const response = await harness.send("/v1/responses", threadId);
    expect(response.status).toBe(502);
    expect((await response.text()).toLowerCase()).toContain("timeout");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ authorization: "Bearer pool-a-token", accountId: "acct-pool-a" });
    expect(seen[0]!.body).toContain("gpt-5.6-sol");
    expect(getCodexUpstreamHostHealth(canonicalHostKey)?.consecutiveFailures).toBe(1);
    expectHostOnlyState(harness, threadId);
  }, { timeout: 10_000 });

  test("credential-visible 307 is manual, bounded, and never exposes Location", async () => {
    const harness = await startHarness({ twoAccounts: true });
    const deadPort = await closedEphemeralPort();
    const seen: Array<{ authorization: string | null; accountId: string | null; body: string }> = [];
    const redirect = serve(async request => {
      seen.push({
        authorization: request.headers.get("authorization"),
        accountId: request.headers.get("chatgpt-account-id"),
        body: await request.text(),
      });
      return new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${deadPort}/credential-leak-target` },
      });
    });
    const redirectModes: Array<RequestRedirect | undefined> = [];
    installCanonicalRouter(call => {
      redirectModes.push(call.init?.redirect);
      return actualFetch(redirect.url, call);
    });

    const response = await harness.send("/v1/responses");
    const downstream = await response.text();
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(downstream).not.toContain("credential-leak-target");
    expect(redirectModes).toEqual(["manual"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ authorization: "Bearer pool-a-token", accountId: "acct-pool-a" });
    expect(seen[0]!.body).toContain("gpt-5.6-sol");
    expect(getCodexUpstreamHostHealth(canonicalHostKey)).toBeNull();
    expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBe(502);
    expect(getCodexUpstreamHealth("pool-b")).toBeNull();
  }, { timeout: 10_000 });

  test("a credential-consuming A failure is not replayed onto a healthy B", async () => {
    const harness = await startHarness({ twoAccounts: true });
    const threadId = "runtime-read-close";
    pinAWhileActiveB(harness, threadId);
    const raw = await startCredentialDependentReadThenCloseServer();
    let physicalSends = 0;
    const attemptedAccounts: Array<string | null> = [];
    installCanonicalRouter(async call => {
      physicalSends += 1;
      attemptedAccounts.push(call.accountId);
      return actualFetch(raw.url, call);
    });

    const response = await harness.send("/v1/responses", threadId);
    expect(response.status).toBe(502);
    expect(physicalSends).toBeGreaterThanOrEqual(1);
    expect(raw.requests.length).toBeGreaterThanOrEqual(1);
    for (const wire of raw.requests) {
      expect(wire.toLowerCase()).toContain("authorization: bearer pool-a-token");
      expect(wire.toLowerCase()).toContain("chatgpt-account-id: acct-pool-a");
      expect(wire).toContain("gpt-5.6-sol");
    }
    // The raw peer would return 200 for B, but A may already have consumed a
    // side-effecting request. Replaying it under another credential would risk
    // duplication, so this conservative residual intentionally remains host-only.
    expect(attemptedAccounts.every(accountId => accountId === "acct-pool-a")).toBe(true);
    expect(raw.successfulBRequests).toHaveLength(0);
    expect(getCodexUpstreamHostHealth(canonicalHostKey)?.consecutiveFailures).toBe(1);
    expectHostOnlyState(harness, threadId);
  }, { timeout: 15_000 });

  test("a real 503 followed by a real refused retry preserves both attribution layers", async () => {
    const harness = await startHarness({ twoAccounts: true });
    const refusedPort = await closedEphemeralPort();
    let upstream503Hits = 0;
    const upstream503 = serve(async request => {
      upstream503Hits += 1;
      await request.text();
      return Response.json({ error: { message: "busy" } }, {
        status: 503,
        headers: { "retry-after": "0" },
      });
    });
    let physicalSends = 0;
    installCanonicalRouter(call => {
      physicalSends += 1;
      return physicalSends === 1
        ? actualFetch(upstream503.url, call)
        : actualFetch(`http://127.0.0.1:${refusedPort}`, call);
    });

    const response = await harness.send("/v1/responses");
    expect(response.status).toBe(502);
    expect(physicalSends).toBe(2);
    expect(upstream503Hits).toBe(1);
    expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBe(503);
    expect(getCodexUpstreamHealth("pool-b")).toBeNull();
    expect(getCodexUpstreamHostHealth(canonicalHostKey)?.consecutiveFailures).toBe(1);
  }, { timeout: 10_000 });

  for (const path of ["/v1/responses", "/v1/responses/compact"] as const) {
    test(`${path} keeps A=429 and one real B rejection separately attributed`, async () => {
      const harness = await startHarness({ twoAccounts: true });
      const refusedPort = await closedEphemeralPort();
      const aSeen: Array<{ authorization: string | null; accountId: string | null; body: string }> = [];
      const aQuota = serve(async request => {
        aSeen.push({
          authorization: request.headers.get("authorization"),
          accountId: request.headers.get("chatgpt-account-id"),
          body: await request.text(),
        });
        return Response.json({ error: { message: "A quota" } }, {
          status: 429,
          headers: { "retry-after": "60" },
        });
      });
      const counts = new Map<string, number>();
      const bHeaders: Headers[] = [];
      installCanonicalRouter(call => {
        const accountId = call.accountId ?? "missing";
        counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
        if (accountId === "acct-pool-a") return actualFetch(aQuota.url, call);
        bHeaders.push(call.headers);
        return actualFetch(`http://127.0.0.1:${refusedPort}`, call);
      });

      const response = await harness.send(path);
      expect(response.status).toBe(502);
      expect(counts.get("acct-pool-a")).toBe(1);
      expect(counts.get("acct-pool-b")).toBe(1);
      expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(2);
      expect(aSeen).toHaveLength(1);
      expect(aSeen[0]).toMatchObject({ authorization: "Bearer pool-a-token", accountId: "acct-pool-a" });
      expect(aSeen[0]!.body).toContain("gpt-5.6-sol");
      expect(bHeaders).toHaveLength(1);
      expect(bHeaders[0]!.get("authorization")).toBe("Bearer pool-b-token");
      expect(getCodexUpstreamHealth("pool-a")?.lastFailureStatus).toBe(429);
      expect(getCodexUpstreamHealth("pool-b")).toBeNull();
      expect(getCodexUpstreamHostHealth(canonicalHostKey)?.consecutiveFailures).toBe(1);
    }, { timeout: 10_000 });
  }
});
