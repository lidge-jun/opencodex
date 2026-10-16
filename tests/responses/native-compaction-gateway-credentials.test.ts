import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as registry from "../../src/providers/registry";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { clearAccountNeedsReauth, clearAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
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
  clearResponseStateForTests();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("native compact gateway credential boundary", () => {
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
