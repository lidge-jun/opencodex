/**
 * Voice sideband joins for calls the client created itself (V3 `existingCall`).
 *
 * ChatGPT voice can hand a live call to a Codex thread, and Codex Desktop creates the call itself
 * when its renderer owns it. Either way the WebRTC call is created with the caller's own ChatGPT
 * login and only its sideband join reaches this proxy. Re-authenticating that join with a
 * Pool-selected account sends it upstream as a different ChatGPT account, and Codex reports
 * `502 Bad Gateway: realtime websocket handshake failed`. A call this proxy created keeps its
 * Pool account (openai/codex #35830, covered in server-live.test.ts).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { handleLive, resolveLiveSidebandUpgrade, type LiveSidebandTarget } from "../../src/server/live";
import { nativeLiveCalls } from "../../src/server/live-native-calls";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  expectSidebandUpgrade,
  openSidebandClient,
  redirectSidebandWebSocket,
  sidebandRelayUpstream,
} from "../helpers/sideband-relay-probe";

const TEST_DIR = join(import.meta.dir, ".tmp-server-live-existing-call-test");
const CALLER_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });
const POOL_ACCOUNTS = ["acct-pool-a", "acct-pool-b"];
const SCOPED_KEY = "ocx_data_" + "s".repeat(40);
const SCOPED: DataPlaneAdmission = { kind: "configured", keyId: "scoped", source: "dedicated" };
const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-live-existing-call-codex-");
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  nativeLiveCalls.clear();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  nativeLiveCalls.clear();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

function poolConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  const config = {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    accountPoolStrategy: "round-robin",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" },
    ],
    ...extra,
  } as OcxConfig;
  saveConfig(config);
  for (const [id, acct] of [["pool-a", "acct-pool-a"], ["pool-b", "acct-pool-b"]] as const) {
    saveCodexAccountCredential(id, {
      accessToken: fakeChatGptJwt({ chatgpt_account_id: acct, email: `${id}@example.test` }),
      refreshToken: `${id}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: acct,
    });
  }
  return config;
}

function callerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${CALLER_TOKEN}`,
    "chatgpt-account-id": "acct-123",
    "session-id": "sess_existing",
    "thread-id": "thread_existing",
    ...extra,
  };
}

function logContext(): RequestLogContext {
  return { model: "gpt-live", provider: "unknown" } as RequestLogContext;
}

type Resolved = { headers: Record<string, string>; upstreamWsUrl: string; recordOutcome?: unknown };

async function joinCall(
  config: OcxConfig,
  target: LiveSidebandTarget,
  headers: Record<string, string>,
  admission?: DataPlaneAdmission,
): Promise<Resolved | Response> {
  const path = target.style === "realtime-query"
    ? `/v1/realtime?call_id=${"callId" in target ? target.callId : ""}`
    : target.style === "realtime-calls-path"
      ? `/v1/realtime/calls/${"callId" in target ? target.callId : ""}`
      : `/v1/live/${"callId" in target ? target.callId : ""}`;
  return resolveLiveSidebandUpgrade(
    new Request(`http://localhost${path}`, { headers }),
    config,
    logContext(),
    target,
    undefined,
    admission,
  ) as Promise<Resolved | Response>;
}

function expectResolved(value: Resolved | Response): Resolved {
  expect(value).not.toBeInstanceOf(Response);
  return value as Resolved;
}

test("an existingCall join reaches the upstream as the caller in Pool mode", async () => {
  poolConfig();
  const upstream = sidebandRelayUpstream(1024 * 1024);
  const redirect = redirectSidebandWebSocket(upstream.server.port);
  const server = startServer(0);
  try {
    const client = openSidebandClient(redirect.OriginalWebSocket, server.url, "/v1/live/rtc_existing_ios", CALLER_TOKEN);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sideband timeout: ${upstream.probe.summary()}`)), 15_000);
      client.addEventListener("open", () => client.send("hello"));
      client.addEventListener("message", () => { clearTimeout(timer); resolve(); });
      client.addEventListener("error", () => { clearTimeout(timer); reject(new Error("client websocket error")); });
    });
    client.close();
    expectSidebandUpgrade(upstream, "/v1/live/rtc_existing_ios", CALLER_TOKEN);
    expect(upstream.seenUpgradeHeaders[0]?.get("chatgpt-account-id")).toBe("acct-123");
  } finally {
    redirect.restore();
    await server.stop(true);
    await upstream.server.stop(true);
  }
}, { timeout: 20_000 });

test("every join form for a call this proxy did not create carries the caller's credential", async () => {
  const config = poolConfig();
  const targets: LiveSidebandTarget[] = [
    { style: "frameless-path", callId: "rtc_foreign_live" },
    { style: "realtime-calls-path", callId: "rtc_foreign_calls" },
    { style: "realtime-query", callId: "rtc_foreign_query" },
  ];
  for (const target of targets) {
    const resolved = expectResolved(await joinCall(config, target, callerHeaders()));
    expect(resolved.headers.authorization).toBe(`Bearer ${CALLER_TOKEN}`);
    expect(resolved.headers["chatgpt-account-id"]).toBe("acct-123");
    expect(resolved.headers["session-id"]).toBe("sess_existing");
    expect(resolved.headers["thread-id"]).toBe("thread_existing");
    expect(resolved.upstreamWsUrl).toContain("callId" in target ? target.callId : "");
    // Nothing about a Pool account was consulted, so nothing may be recorded against one.
    expect(resolved.recordOutcome).toBeUndefined();
  }
});

test("a call this proxy created keeps the Pool account that created it", async () => {
  const config = poolConfig();
  globalThis.fetch = (async () => new Response("v=0", {
    status: 201,
    headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/calls/rtc_created_here" },
  })) as unknown as typeof fetch;
  const created = await handleLive(
    new Request("http://localhost/v1/live", {
      method: "POST",
      headers: { ...callerHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0", session: { model: "gpt-live" } }),
    }),
    config,
    logContext(),
  );
  expect(created.status).toBe(201);
  expect(nativeLiveCalls.has("rtc_created_here")).toBe(true);

  const resolved = expectResolved(await joinCall(config, { style: "frameless-path", callId: "rtc_created_here" }, callerHeaders()));
  expect(POOL_ACCOUNTS).toContain(resolved.headers["chatgpt-account-id"]);
  expect(resolved.headers.authorization).not.toBe(`Bearer ${CALLER_TOKEN}`);
});

test("without a caller credential a join keeps the Pool selection", async () => {
  const config = poolConfig();
  const resolved = expectResolved(await joinCall(config, { style: "frameless-path", callId: "rtc_no_bearer" }, {
    "session-id": "sess_existing",
    "thread-id": "thread_existing",
  }));
  expect(POOL_ACCOUNTS).toContain(resolved.headers["chatgpt-account-id"]);
});

test("a caller whose account header disagrees with its token is never forwarded", async () => {
  const config = poolConfig();
  const resolved = expectResolved(await joinCall(
    config,
    { style: "frameless-path", callId: "rtc_mismatch" },
    callerHeaders({ "chatgpt-account-id": "acct-someone-else" }),
  ));
  // The mismatched bearer is not an explicit caller credential, so Pool selection answers.
  expect(resolved.headers.authorization).not.toBe(`Bearer ${CALLER_TOKEN}`);
  expect(POOL_ACCOUNTS).toContain(resolved.headers["chatgpt-account-id"]);
});

test("the proxy admission secret is refused before any upstream is chosen", async () => {
  const config = poolConfig();
  const resolved = await joinCall(
    config,
    { style: "frameless-path", callId: "rtc_secret" },
    { authorization: `Bearer ${SCOPED_KEY}`, "chatgpt-account-id": "acct-123" },
  );
  expect(resolved).toBeInstanceOf(Response);
  expect((resolved as Response).status).toBe(401);
});

test("a key whose provider scope excludes OpenAI cannot join as the caller either", async () => {
  const config = poolConfig({
    apiKeys: [{
      id: "scoped",
      name: "voice",
      key: SCOPED_KEY,
      createdAt: "2026-01-01T00:00:00.000Z",
      allowedProviders: ["some-other-provider"],
    }],
  } as Partial<OcxConfig>);
  const resolved = await joinCall(config, { style: "frameless-path", callId: "rtc_scoped" }, callerHeaders(), SCOPED);
  expect(resolved).toBeInstanceOf(Response);
  expect((resolved as Response).status).toBe(403);
});
