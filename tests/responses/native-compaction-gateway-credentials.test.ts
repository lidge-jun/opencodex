import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as registry from "../../src/providers/registry";
import * as authContext from "../../src/codex/auth-context";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { clearAccountNeedsReauth, clearAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import { setAccountQuotaFromParsed } from "../../src/codex/quota";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { peekConversationStateIssuer, rememberConversationStateIssuer } from "../../src/codex/routing/thread-affinity";
import { handleResponsesCompact } from "../../src/server/responses";
import { clearCompactHandoffRoutesForTests } from "../../src/server/responses/compact";
import { clearResponseStateForTests, clearResponseStateMemoryForTests } from "../../src/responses/state";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A native v1 gateway declaration is a protocol claim. Even when the provider row still carries a
// Codex account mode, pool recovery (401 refresh replay, 429 alternate account) must never put a
// stored ChatGPT credential on the wire to the configured gateway.
const CODEX_TOKENS = ["work-access", "refreshed-access", "other-access"];
const originalFetch = globalThis.fetch;
let home = "";
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

function record(accessToken: string, refreshToken: string, chatgptAccountId: string) {
  return {
    credential: { accessToken, refreshToken, expiresAt: Date.now() + 3_600_000, chatgptAccountId },
    generation: 3,
    refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${refreshToken}`).digest("hex"),
  };
}

function gatewayConfig(): OcxConfig {
  return {
    defaultProvider: "gw",
    activeCodexAccountId: "work",
    autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin",
    providers: {
      gw: {
        adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "forward",
        supportsNativeCompactEndpoint: true, headers: { authorization: "Bearer gateway-static" },
      },
    },
    codexAccounts: [{ id: "work", label: "work" }, { id: "other", label: "other" }],
  } as unknown as OcxConfig;
}

function compactRequest(): Request {
  return new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-parent-thread-id": "gateway-credential-thread" },
    body: JSON.stringify({ model: "gw/gateway-model", input: [{ type: "message", role: "user", content: "history" }] }),
  });
}

function installGateway(status: number): string[] {
  const gatewayAuth: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "auth.openai.com") {
      return Response.json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    }
    if (url.hostname !== "gateway.example") return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    const headers = new Headers(init?.headers);
    gatewayAuth.push(`${headers.get("authorization") ?? ""}|${headers.get("chatgpt-account-id") ?? ""}`);
    return Response.json({ error: { message: "gateway refusal" } }, { status });
  }) as typeof fetch;
  return gatewayAuth;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-native-compact-gateway-cred-"));
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  for (const id of ["work", "other"]) clearAccountNeedsReauth(id);
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearPoolRecoveryState();
  setAccountQuotaFromParsed("work", { weeklyPercent: 10 });
  clearResponseStateMemoryForTests();
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify({
    work: record("work-access", "work-refresh", "acc-work"),
    other: record("other-access", "other-refresh", "acc-other"),
  }));
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearCompactHandoffRoutesForTests();
  for (const id of ["work", "other"]) clearAccountNeedsReauth(id);
  clearAccountQuota();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearPoolRecoveryState();
  clearResponseStateForTests();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("native compact gateway credential boundary", () => {
  test("gateway turn state is removed after an account-change scrub", async () => {
    const realMode = registry.providerCodexAccountMode;
    const modeSpy = spyOn(registry, "providerCodexAccountMode").mockImplementation((id, provider) =>
      id === "gw" ? "pool" : realMode(id, provider));
    const request = compactRequest();
    const key = codexPoolAffinityKey(request.headers)!;
    rememberConversationStateIssuer(key, "other");
    const config = gatewayConfig();
    config.providers.gw!.headers!["x-codex-turn-state"] = "configured";
    const states: Array<string | null> = [];
    globalThis.fetch = (async (_input, init) => {
      states.push(new Headers(init?.headers).get("x-codex-turn-state"));
      return Response.json({ object: "response.compaction", output: [] });
    }) as typeof fetch;
    try {
      const response = await handleResponsesCompact(request, config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(states).toEqual([null]);
    } finally { modeSpy.mockRestore(); }
  });
  test.each([401, 429])("gateway %i never receives a stored Codex credential", async status => {
    // The router pins the only pool-mode row to the canonical URL today. Model a relaxation of that
    // pin: the native gateway send must hold the boundary on its own.
    const realMode = registry.providerCodexAccountMode;
    const modeSpy = spyOn(registry, "providerCodexAccountMode").mockImplementation((id, provider) =>
      id === "gw" ? "pool" : realMode(id, provider));
    const gatewayAuth = installGateway(status);
    const response = await handleResponsesCompact(compactRequest(), gatewayConfig(), { model: "", provider: "" } as RequestLogContext);
    await response.text();
    modeSpy.mockRestore();
    expect(gatewayAuth.length).toBeGreaterThan(0);
    for (const sent of gatewayAuth) {
      expect(sent).toBe("Bearer gateway-static|");
      for (const token of CODEX_TOKENS) expect(sent).not.toContain(token);
    }
  });
});

describe("native compact account-change replay", () => {
  function request(key: string, file = false): Request {
    return new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token", "chatgpt-account-id": "caller-account", "x-codex-parent-thread-id": key, "x-codex-turn-state": "old-turn" },
      body: JSON.stringify({ model: "gpt-5.5", previous_response_id: "old-response", conversation: "old-conversation", client_metadata: { "x-codex-turn-state": "old-turn" }, input: file ? [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file-fixture" }] }] : [{ role: "user", content: "history" }] }),
    });
  }
  function config(): OcxConfig {
    return { ...gatewayConfig(), defaultProvider: "openai", providers: { openai: {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool",
    } }, codexAccounts: [{ id: "work", label: "work" }] } as OcxConfig;
  }
  test.each(["other", "work"])("401 refresh preserves only same-account turn state, issuer=%s", async issuer => {
    const req = request(`refresh-${issuer}`);
    rememberConversationStateIssuer(codexPoolAffinityKey(req.headers)!, issuer);
    const resolve = authContext.resolveCodexAuthContext;
    const spy = spyOn(authContext, "resolveCodexAuthContext").mockImplementation((headers, cfg, mode, options) => {
      const poolHeaders = new Headers(headers); poolHeaders.delete("authorization"); poolHeaders.delete("chatgpt-account-id");
      return resolve(poolHeaders, cfg, mode, { ...options, requestScopedMainCredential: false });
    });
    const states: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("auth.openai.com")) return Response.json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600 });
      states.push(new Headers(init?.headers).get("x-codex-turn-state"));
      return states.length === 1 ? Response.json({ error: "unauthorized" }, { status: 401 }) : Response.json({ object: "response.compaction", output: [] });
    }) as typeof fetch;
    try {
      const response = await handleResponsesCompact(req, config(), { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(states).toEqual(issuer === "other" ? [null, null] : ["old-turn", "old-turn"]);
    } finally { spy.mockRestore(); }
  });

  test.each([429, 503])("pool to caller main scrubs request on %i alternate", async status => {
    const req = request(`alternate-${status}`);
    const key = codexPoolAffinityKey(req.headers)!;
    rememberConversationStateIssuer(key, "work");
    const resolve = authContext.resolveCodexAuthContext;
    const spy = spyOn(authContext, "resolveCodexAuthContext").mockImplementation((headers, cfg, mode, options) => {
      if (options?.excludeAccountId) return Promise.resolve({ kind: "main", accountId: null });
      const poolHeaders = new Headers(headers); poolHeaders.delete("authorization"); poolHeaders.delete("chatgpt-account-id");
      return resolve(poolHeaders, cfg, mode, { ...options, requestScopedMainCredential: false });
    });
    const calls: Array<{ headers: Headers; body: Record<string, any> }> = [];
    globalThis.fetch = (async (_input, init) => {
      calls.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return calls.length === 1 ? Response.json({ error: { message: "unavailable" } }, { status, headers: { "retry-after": "600" } }) : Response.json({ object: "response.compaction", output: [] });
    }) as typeof fetch;
    try {
      const response = await handleResponsesCompact(req, config(), { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.headers.get("authorization")).toBe("Bearer work-access");
      expect(calls[1]!.headers.get("authorization")).toBe("Bearer caller-token");
      expect(calls[0]!.headers.get("x-codex-turn-state")).toBe("old-turn");
      expect(calls[0]!.body.previous_response_id).toBe("old-response");
      expect(calls[1]!.headers.get("x-codex-turn-state")).toBeNull();
      expect(calls[1]!.body.previous_response_id).toBeUndefined();
      expect(calls[1]!.body.conversation).toBeUndefined();
      expect(calls[1]!.body.client_metadata?.["x-codex-turn-state"]).toBeUndefined();
      expect(peekConversationStateIssuer(key)).toBe("work");
    } finally { spy.mockRestore(); }
  });

  test.each([429, 503])("file references prevent a caller-main alternate on %i", async status => {
    const req = request(`file-${status}`, true);
    const key = codexPoolAffinityKey(req.headers)!;
    rememberConversationStateIssuer(key, "work");
    const resolve = authContext.resolveCodexAuthContext;
    let alternateResolutions = 0;
    const spy = spyOn(authContext, "resolveCodexAuthContext").mockImplementation((headers, cfg, mode, options) => {
      if (options?.excludeAccountId) { alternateResolutions++; return Promise.resolve({ kind: "main", accountId: null }); }
      const poolHeaders = new Headers(headers); poolHeaders.delete("authorization"); poolHeaders.delete("chatgpt-account-id");
      return resolve(poolHeaders, cfg, mode, { ...options, requestScopedMainCredential: false });
    });
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      return Response.json({ error: { message: "unavailable" } }, { status, headers: { "retry-after": "600" } });
    }) as typeof fetch;
    try {
      const response = await handleResponsesCompact(req, config(), { model: "", provider: "" });
      expect(response.status).toBe(status);
      expect(sends).toBe(1);
      expect(alternateResolutions).toBe(0);
      expect(peekConversationStateIssuer(key)).toBe("work");
    } finally { spy.mockRestore(); }
  });
});
