import { expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET } from "../../src/codex/account-namespace-match";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import * as mainAccount from "../../src/codex/main-account";
import * as authCollision from "../../src/codex/auth-collision";
import * as liveStores from "../../src/lib/state-store-registrations";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearMainAccountInfoCache, observeMainQuotaCredential } from "../../src/codex/main-account-cache";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { isNativeMainTrafficBlocked, waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { findAvailablePort } from "../../src/server/ports";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { isTestHomeGuardArmed } from "../../src/lib/test-home-guard";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "./fake-chatgpt-jwt";
import { ownedServiceHomeInspection } from "./owned-service-home-inspection";
import { removeTreeWithRetry } from "./remove-tree";
import { INTERNAL_DEADLINE_MS } from "./test-budget";

export const PROXY_KEY = "ocx_data_reserve_ingress_fixture";
export const ACCOUNT = "reserve-ingress-owned-account";
export const ACCESS = fakeChatGptJwt({ exp: 4_000_000_000,
  "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_user_id: "owned-fixture-user" } });
export const EXTERNAL = fakeChatGptJwt({ exp: 4_000_000_000,
  "https://api.openai.com/auth": { chatgpt_account_id: "external-fixture-account" } });
export type Transport = "responses" | "compact" | "search" | "ws" | "chat" | "messages";
export type SeenInference = { path: string; authorization: string | null; model: unknown };
export type Counters = { wham: number; credential: number; tokenRead: number; inference: SeenInference[] };

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function clearState(): void {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearAccountQuota(); // Cancels pending quota persistence before fixture-home teardown.
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth(mainAccount.MAIN_CODEX_ACCOUNT_ID);
  resetMainCodexAccountIdentityTrackingForTests();
  resetLifecycleDrainStateForTests();
  mainAccount.setMainAccountPlan(null);
}

/** Actual sibling listeners, native platform locks, owned homes; no external socket fallback. */
export async function reserveIngressFixture(options: {
  primaryLoopback?: boolean;
  configure?: (config: OcxConfig) => void;
} = {}) {
  expect(isTestHomeGuardArmed()).toBe(true);
  const names = ["OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
  const oldEnv = names.map(name => [name, process.env[name]] as const);
  const root = mkdtempSync(join(tmpdir(), "ocx-reserve-ingress-"));
  const codexHome = join(root, "codex");
  const configHome = join(root, "ocx");
  mkdirSync(codexHome); mkdirSync(configHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = configHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = PROXY_KEY;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "reserve-ingress-admin-fixture";
  const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  clearState();
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {
    access_token: ACCESS, account_id: ACCOUNT, refresh_token: "reserve-ingress-refresh-fixture",
  } }));
  const nativeFetch = globalThis.fetch;
  const restores: Array<() => void> = [];
  const counters: Counters = { wham: 0, credential: 0, tokenRead: 0, inference: [] };
  let liveConfig: OcxConfig | undefined;
  let server: ReturnType<typeof startServer> | undefined;
  let allowReserve = false;
  let holdUsage: ReturnType<typeof deferred<void>> | undefined;
  let usageStarted = deferred<void>();
  let holdCredential: ReturnType<typeof deferred<void>> | undefined;
  let credentialStarted = deferred<void>();
  const sockets = new Set<WebSocket>();
  const unexpected: string[] = [];

  const close = async () => {
    holdUsage?.resolve();
    holdCredential?.resolve();
    for (const socket of sockets) socket.close();
    try { await server?.stop(true); }
    finally {
      globalThis.fetch = nativeFetch;
      for (const restore of restores.reverse()) restore();
      clearState();
      try { await flushConfigDirHardeningForTests(); }
      finally {
        setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
        for (const [name, value] of oldEnv) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        removeTreeWithRetry(root);
      }
    }
    expect(unexpected).toEqual([]);
  };

  try {
    const realSetLive = liveStores.setLiveStateStoreConfig;
    const liveSpy = spyOn(liveStores, "setLiveStateStoreConfig").mockImplementation(config => {
      liveConfig = config;
      realSetLive(config);
    });
    restores.push(() => liveSpy.mockRestore());
    const realToken = mainAccount.getValidMainAccountToken;
    const tokenSpy = spyOn(mainAccount, "getValidMainAccountToken").mockImplementation(async options => {
      counters.credential++;
      expect(process.env.CODEX_HOME).toBe(codexHome);
      credentialStarted.resolve();
      if (holdCredential) await holdCredential.promise;
      return realToken(options);
    });
    restores.push(() => tokenSpy.mockRestore());
    const realRead = authCollision.readCodexTokensResult;
    const readSpy = spyOn(authCollision, "readCodexTokensResult").mockImplementation(() => {
      counters.tokenRead++;
      expect(process.env.CODEX_HOME).toBe(codexHome);
      return realRead();
    });
    restores.push(() => readSpy.mockRestore());
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === "https://chatgpt.com/backend-api/wham/usage") {
        counters.wham++;
        expect(request.headers.get("x-openai-codex-luna-reserve")).toBe("1");
        expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
        usageStarted.resolve();
        if (holdUsage) await holdUsage.promise;
        return Response.json({ account_id: ACCOUNT,
          rate_limit: { allowed: !allowReserve, primary_window: { used_percent: 20, limit_window_seconds: 18_000 } },
          ...(allowReserve ? { rate_limit_upsell: { banner_type: "luna_reserve" },
            additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: true } }] } : {}),
        });
      }
      const native = url.origin === "https://chatgpt.com" && url.pathname.startsWith("/backend-api/codex/");
      const keyed = url.origin === "https://reserve-keyed.example.test";
      if ((native || keyed) && url.pathname.endsWith("/models")) return Response.json({ models: [] });
      if ((native || keyed) && ["/responses", "/responses/compact", "/alpha/search"].some(path => url.pathname.endsWith(path))) {
        const body = await request.json() as { model?: unknown; stream?: boolean };
        counters.inference.push({ path: url.pathname, authorization: request.headers.get("authorization"), model: body.model });
        if (url.pathname.endsWith("/alpha/search")) return Response.json({ results: [{ title: "fixture", url: "https://example.test/" }] });
        const response = { id: "resp_reserve_ingress", object: "response", status: "completed", model: body.model,
          output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "fixture response", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        if (url.pathname.endsWith("/compact")) return Response.json({ ...response, object: "response.compaction" });
        if (!body.stream) return Response.json(response);
        const events = [{ type: "response.created", response: { ...response, status: "in_progress" } },
          { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "fixture response" },
          { type: "response.completed", response }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } });
      }
      // Actual ingress uses nativeFetch below. Never send an unrecognized runtime request live.
      unexpected.push(`${url.origin}${url.pathname}`);
      throw new Error("Unexpected outbound request in Reserve ingress fixture");
    }, { preconnect() { /* Never open an upstream socket from a fixture hint. */ } });

    const localPort = await findAvailablePort(0, "127.0.0.1");
    const publicPort = await findAvailablePort(0, "0.0.0.0", { reservedPort: localPort });
    expect(publicPort).not.toBe(localPort);
    const hostname = options.primaryLoopback ? "127.0.0.1" : "0.0.0.0";
    const config: OcxConfig = { port: publicPort, hostname, defaultProvider: "openai",
      openaiProviderTierVersion: 2, codexDesktopAuthless: true, codexMainAccountHardLock: false,
      websockets: true, subagentModels: [], codexAccounts: [], codexAccountNamespaces: { main: MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET },
      unauthenticatedLoopbackListener: { enabled: true, port: localPort },
      providers: {
        openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", upstreamWebsocket: false,
          baseUrl: "https://chatgpt.com/backend-api/codex" },
        keyed: { adapter: "openai-responses", authMode: "key", apiKey: "sk-ingress-fixture", baseUrl: "https://reserve-keyed.example.test/v1" },
      } };
    options.configure?.(config);
    saveConfig(config);
    expect(loadConfig()).toMatchObject({ hostname, codexDesktopAuthless: config.codexDesktopAuthless,
      codexAccountNamespaces: { main: MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET } });
    server = startServer(publicPort, { inspectNativeCodexOwnership: ownedServiceHomeInspection("Reserve dual-listener fixture") });
    await waitForNativeMainStartupGate();
    expect(isNativeMainTrafficBlocked()).toBe(false);
    reconcileMainCodexAccountRuntimeState();
    observeMainQuotaCredential(ACCESS, ACCOUNT);
    expect(liveConfig).toBeDefined();
    expect(liveConfig?.hostname).toBe(hostname);
    const baselineDisk = readFileSync(join(configHome, "config.json"), "utf8");
    const baselineConfig = JSON.stringify(liveConfig);
    counters.wham = 0; counters.credential = 0; counters.tokenRead = 0;
    const publicBase = `http://127.0.0.1:${server.port}`;
    const localBase = `http://127.0.0.1:${localPort}`;

    const request = async (listener: "public" | "local", transport: Transport, model: string,
      headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => {
      const base = listener === "public" ? publicBase : localBase;
      const body = { model, input: "fixture request", stream: false, ...extra };
      if (transport !== "ws") {
        const paths = { responses: "/v1/responses", compact: "/v1/responses/compact", search: "/v1/alpha/search",
          chat: "/v1/chat/completions", messages: "/v1/messages" };
        const path = paths[transport];
        const payload = transport === "search" ? { model, query: "fixture query", ...extra }
          : transport === "chat" || transport === "messages"
            ? { model, messages: [{ role: "user", content: "fixture request" }], max_tokens: 32, stream: false, ...extra }
            : body;
        const response = await nativeFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(INTERNAL_DEADLINE_MS) });
        return { status: response.status, text: await response.text(), opened: false };
      }
      return new Promise<{ status: number; text: string; opened: boolean }>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace("http:", "ws:")}/v1/responses`, { headers } as unknown as string[]);
        sockets.add(socket);
        let opened = false;
        let settled = false;
        const settle = (value?: { status: number; text: string; opened: boolean }, error?: Error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); socket.close(); sockets.delete(socket);
          if (error) reject(error); else resolve(value!);
        };
        const timer = setTimeout(() => settle(undefined, new Error("Reserve ingress WS terminal timeout")), INTERNAL_DEADLINE_MS);
        socket.addEventListener("open", () => { opened = true; socket.send(JSON.stringify({ ...body, type: "response.create", stream: true })); });
        socket.addEventListener("error", () => settle(undefined, new Error("Reserve ingress WS handshake/transport failed")));
        socket.addEventListener("message", event => {
          const text = String(event.data);
          try {
            const data = JSON.parse(text) as { type?: string; status?: number | string };
            if (data.type === "error" || data.type === "response.failed") {
              settle({ status: typeof data.status === "number" ? data.status : 500, text, opened });
            } else if (data.type === "response.completed" || (!data.type && data.status === "completed")) {
              settle({ status: 200, text, opened });
            }
          } catch { settle(undefined, new Error("Malformed Reserve ingress WS frame")); }
        });
        socket.addEventListener("close", () => { if (!settled) settle(undefined, new Error("Reserve ingress WS closed before terminal")); });
      });
    };
    return { counters, request, close, publicBase, localBase,
      allow: () => { allowReserve = true; },
      hold: () => { holdUsage = deferred<void>(); usageStarted = deferred<void>(); return { started: usageStarted.promise, release: () => holdUsage?.resolve() }; },
      holdCredential: () => {
        holdCredential = deferred<void>(); credentialStarted = deferred<void>();
        return { started: credentialStarted.promise, release: () => holdCredential?.resolve() };
      },
      setAuthless: (enabled: boolean) => {
        if (!liveConfig) throw new Error("Fixture server did not publish its live config");
        liveConfig.codexDesktopAuthless = enabled;
      },
      assertConfigUnchanged: () => {
        expect(JSON.stringify(liveConfig)).toBe(baselineConfig);
        expect(readFileSync(join(configHome, "config.json"), "utf8")).toBe(baselineDisk);
      },
    };
  } catch (error) { await close(); throw error; }
}
