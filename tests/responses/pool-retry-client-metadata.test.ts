import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { handleResponses } from "../../src/server/responses";
import { codexWsPool } from "../../src/server/responses/codex-ws-pool";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { codexInstallationIdForAccount } from "../../src/codex/installation-id";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { BOUNDED_WS_RUNTIME } from "../helpers/ws-upstream-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A Pool credential is materialized by a credential-only allowlist, so the caller's permitted
 * Responses metadata is copied back after auth. The pre-stream quota retry selects a DIFFERENT
 * account and rebuilds its headers from `callerAuthHeaders`, which was the same allowlist-only
 * materialization. Both physical sends must therefore still carry the caller's User-Agent and the
 * provider-selected app version, or the second send silently loses the client fingerprint that
 * routing was supposed to preserve.
 */

const WORK = "work";
const OTHER = "other";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

const CALLER_USER_AGENT = "T3 Code/0.166.0 (Mac OS; arm64) unknown (T3 Code; pool-retry fixture)";
const APP_VERSION = "pool-retry-version-fixture";

type Listener = (event: unknown) => void;
type Step = "quota" | "ok";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static plan: Step[] = [];
  url: string;
  headers: Headers;
  listeners = new Map<string, Listener[]>();

  constructor(url: string, options?: { headers?: HeadersInit }) {
    this.url = url;
    this.headers = new Headers(options?.headers);
    const step = FakeWebSocket.plan[FakeWebSocket.instances.length] ?? "ok";
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.run(step));
  }

  run(step: Step) {
    this.emit("open", {});
    const id = `resp_${FakeWebSocket.instances.indexOf(this)}`;
    // The wrapper is projected only before anything commits: an error frame first is what makes
    // the refusal a pre-stream 429 instead of an in-body terminal on an already-started stream.
    if (step === "quota") {
      this.frame({ type: "error", status: 429,
        error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "You have hit your usage limit." } });
      return;
    }
    this.frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    this.frame({ type: "response.completed", response: { id, status: "completed", output: [] } });
  }

  addEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  frame(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(_data: string) {}

  close() {}
}

const RealWebSocket = globalThis.WebSocket;
const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let savedProxyEnv: Record<string, string | undefined> = {};
let releaseSpendHome: (() => void) | undefined;

function clearPoolState(): void {
  for (const id of [WORK, OTHER]) clearAccountNeedsReauth(id);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAccountQuota();
  clearPoolRecoveryState();
}

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-pool-retry-metadata-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearPoolState();
  for (const id of [WORK, OTHER]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(
    [WORK, OTHER].map(id => [id, {
      credential: {
        accessToken: `${id}-access`,
        refreshToken: `${id}-grant`,
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: `acc-${id}`,
      },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
    }]),
  )));
  FakeWebSocket.instances = [];
  FakeWebSocket.plan = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  // Every send must ride the WebSocket; an HTTP send here would fail the test's premise.
  globalThis.fetch = (async () => { throw new Error("unexpected HTTP send"); }) as unknown as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.WebSocket = RealWebSocket;
  globalThis.fetch = RealFetch;
  codexWsPool.dispose();
  clearPoolState();
  for (const [index, key] of HOME_KEYS.entries()) {
    if (previousHomes[index] === undefined) delete process.env[key];
    else process.env[key] = previousHomes[index];
  }
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  removeTreeWithRetry(home);
});

function poolConfig(
  forwardClientHeaders?: string[],
  overrides: {
    upstreamWebsocket?: boolean;
    callerInstallationId?: string;
    providerHeaders?: Record<string, string>;
  } = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
        ...(forwardClientHeaders ? { forwardClientHeaders } : {}),
        ...(overrides.providerHeaders ? { headers: overrides.providerHeaders } : {}),
        ...(overrides.upstreamWebsocket === undefined ? {} : { upstreamWebsocket: overrides.upstreamWebsocket }),
      },
    },
    activeCodexAccountId: WORK,
    autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin",
    codexAccounts: [{ id: WORK, label: WORK }, { id: OTHER, label: OTHER }],
  } as OcxConfig;
}

async function send(config: OcxConfig, callerInstallationId?: string) {
  const headers = new Headers({ "content-type": "application/json", "user-agent": CALLER_USER_AGENT, "x-codex-app-version": APP_VERSION });
  if (callerInstallationId) headers.set("x-codex-installation-id", callerInstallationId);
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true, store: false }),
  });
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(request, config, logCtx, {
    codexWsRuntimeIdentity: BOUNDED_WS_RUNTIME,
    sendBudget: createRequestExecutionBudget(),
  });
  const body = await response.text().catch(error => `<body error: ${String(error)}>`);
  return { response, body };
}

function observedHeaders(): Array<Record<string, string | null>> {
  return FakeWebSocket.instances.map(ws => ({
    authorization: ws.headers.get("authorization"),
    "user-agent": ws.headers.get("user-agent"),
    "x-codex-app-version": ws.headers.get("x-codex-app-version"),
    "x-codex-installation-id": ws.headers.get("x-codex-installation-id"),
  }));
}

describe("a Codex Pool quota retry preserves permitted client metadata on every physical send", () => {
  test("both sends carry the caller User-Agent and the provider-selected app version", async () => {
    FakeWebSocket.plan = ["quota", "ok"];
    const { response, body } = await send(poolConfig(["x-codex-app-version"]));

    expect(response.status).toBe(200);
    expect(body).toContain("response.completed");
    // The retry really did move accounts; otherwise this asserts nothing about a rebuilt send.
    expect(observedHeaders()).toEqual([
      { authorization: "Bearer work-access", "user-agent": CALLER_USER_AGENT, "x-codex-app-version": APP_VERSION, "x-codex-installation-id": null },
      { authorization: "Bearer other-access", "user-agent": CALLER_USER_AGENT, "x-codex-app-version": APP_VERSION, "x-codex-installation-id": null },
    ]);
  });

  test("the retry keeps each selected account's installation identity", async () => {
    FakeWebSocket.plan = ["quota", "ok"];
    const { response } = await send(poolConfig(), "caller-installation-fixture");

    expect(response.status).toBe(200);
    const installations = observedHeaders().map(headers => headers["x-codex-installation-id"]);
    // A Pool send never carries the caller's installation id; it carries the selected
    // account's derived identity, which the alternate send must derive again for ITS account.
    expect(installations).toEqual([
      codexInstallationIdForAccount("acc-work"),
      codexInstallationIdForAccount("acc-other"),
    ]);
    expect(installations[0]).not.toBe(installations[1]);
  });

  test("configured provider headers keep precedence over the caller on both sends", async () => {
    FakeWebSocket.plan = ["quota", "ok"];
    const config = poolConfig(["x-codex-app-version"], { providerHeaders: { "X-Codex-App-Version": "provider-app-version" } });
    const { response } = await send(config);

    expect(response.status).toBe(200);
    // The caller opted the header in, but the operator's configured value is authoritative.
    expect(observedHeaders().map(headers => headers["x-codex-app-version"]))
      .toEqual(["provider-app-version", "provider-app-version"]);
  });

  test("a 401 refresh replay keeps the same permitted metadata on both physical sends", async () => {
    const sends: Array<{ authorization: string | null; userAgent: string | null; appVersion: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth.openai.com")) {
        return Response.json({ access_token: "work-refreshed", refresh_token: "work-rotated", expires_in: 3600 });
      }
      if (!url.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
      const headers = new Headers(init?.headers);
      sends.push({ authorization: headers.get("authorization"), userAgent: headers.get("user-agent"), appVersion: headers.get("x-codex-app-version") });
      return headers.get("authorization") === "Bearer work-access"
        ? Response.json({ error: { message: "rejected bearer" } }, { status: 401 })
        : Response.json({ id: "resp_refreshed", object: "response", status: "completed", output: [] });
    }) as unknown as typeof fetch;

    const { response } = await send(poolConfig(["x-codex-app-version"], { upstreamWebsocket: false }));

    expect(response.status).toBe(200);
    // The replay really did refresh the credential; otherwise this asserts nothing about a rebuilt send.
    expect(sends.map(item => item.authorization)).toEqual(["Bearer work-access", "Bearer work-refreshed"]);
    expect(sends).toEqual([
      { authorization: "Bearer work-access", userAgent: CALLER_USER_AGENT, appVersion: APP_VERSION },
      { authorization: "Bearer work-refreshed", userAgent: CALLER_USER_AGENT, appVersion: APP_VERSION },
    ]);
  });

  test("the retry does not invent metadata the provider never selected", async () => {
    FakeWebSocket.plan = ["quota", "ok"];
    const { response } = await send(poolConfig());

    expect(response.status).toBe(200);
    // User-Agent keeps the existing Responses fallback; the app version needs its own opt-in.
    expect(observedHeaders()).toEqual([
      { authorization: "Bearer work-access", "user-agent": CALLER_USER_AGENT, "x-codex-app-version": null, "x-codex-installation-id": null },
      { authorization: "Bearer other-access", "user-agent": CALLER_USER_AGENT, "x-codex-app-version": null, "x-codex-installation-id": null },
    ]);
  });
});
