import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { TokenRefreshError } from "../src/codex/account-store";
import { clearAccountQuota } from "../src/codex/auth-api";
import { resetMainCodexAccountIdentityTrackingForTests } from "../src/codex/account-lifecycle";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { handleResponsesCompact } from "../src/server/responses";
import type { OAuthCredentials } from "../src/oauth/types";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originalFetch = globalThis.fetch;

let isolatedCodexHome: IsolatedCodexHome;
let opencodexHome: string;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-compact-main-refresh-codex-");
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-compact-main-refresh-store-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  isolatedCodexHome.restore();
  rmSync(opencodexHome, { recursive: true, force: true });
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
});

function jwt(name: string, expiresInSeconds: number, accountId = "main-account"): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    chatgpt_account_id: accountId,
    marker: name,
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function writeAuth(accessToken: string, refreshToken = "main-refresh", accountId = "main-account"): void {
  writeFileSync(join(isolatedCodexHome.path, "auth.json"), JSON.stringify({
    tokens: { access_token: accessToken, refresh_token: refreshToken, account_id: accountId },
  }));
}

function config(): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: [],
    autoSwitchThreshold: 0,
  } as OcxConfig;
}

function request(): Request {
  return new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
        { type: "compaction_trigger" },
      ],
    }),
  });
}

function success(): Response {
  return Response.json({
    output: [{ type: "compaction", encrypted_content: "opaque" }],
  });
}

function refreshed(accessToken: string, accountId = "fresh-account"): OAuthCredentials {
  return {
    access: accessToken,
    refresh: "fresh-refresh",
    expires: Date.now() + 3_600_000,
    accountId,
  };
}

describe("Responses compact native main refresh", () => {
  test("substitutes a refreshed native credential before compact upstream I/O", async () => {
    const freshAccess = jwt("fresh-pre", 3_600, "fresh-account");
    writeAuth(jwt("expired-pre", -3_600));
    const bearers: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/backend-api/wham/usage")) return Response.json({});
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return success();
    }) as typeof fetch;

    const response = await handleResponsesCompact(
      request(),
      config(),
      { model: "", provider: "" },
      undefined,
      undefined,
      { nativeMainRefreshDependencies: { refreshToken: async () => refreshed(freshAccess) } },
    );

    expect(response.status).toBe(200);
    expect(bearers).toEqual([`Bearer ${freshAccess}`]);
  });

  test("replays one compact native-main 401 with the refreshed bearer", async () => {
    const initialAccess = jwt("initial", 3_600);
    const freshAccess = jwt("fresh", 3_600, "fresh-account");
    writeAuth(initialAccess);
    const bearers: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/backend-api/wham/usage")) return Response.json({});
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return bearers.length === 1
        ? Response.json({ error: { message: "expired" } }, { status: 401 })
        : success();
    }) as typeof fetch;

    const response = await handleResponsesCompact(
      request(),
      config(),
      { model: "", provider: "" },
      undefined,
      undefined,
      { nativeMainRefreshDependencies: { refreshToken: async () => refreshed(freshAccess) } },
    );

    expect(response.status).toBe(200);
    expect(bearers).toEqual([`Bearer ${initialAccess}`, `Bearer ${freshAccess}`]);
  });

  test("does not replay compact native-main 401 more than once", async () => {
    const initialAccess = jwt("initial-always", 3_600);
    const freshAccess = jwt("fresh-always", 3_600, "fresh-account");
    writeAuth(initialAccess);
    const bearers: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/backend-api/wham/usage")) return Response.json({});
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ error: { message: "still unauthorized" } }, { status: 401 });
    }) as typeof fetch;

    const response = await handleResponsesCompact(
      request(),
      config(),
      { model: "", provider: "" },
      undefined,
      undefined,
      { nativeMainRefreshDependencies: { refreshToken: async () => refreshed(freshAccess) } },
    );

    expect(response.status).toBe(401);
    expect(bearers).toEqual([`Bearer ${initialAccess}`, `Bearer ${freshAccess}`]);
  });

  test("retryable compact 401 replay refresh failure does not mark main for reauthentication", async () => {
    const initialAccess = jwt("initial-transient", 3_600);
    writeAuth(initialAccess);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/backend-api/wham/usage")) return Response.json({});
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${initialAccess}`);
      return Response.json({ error: { message: "expired" } }, { status: 401 });
    }) as typeof fetch;

    const response = await handleResponsesCompact(
      request(),
      config(),
      { model: "", provider: "" },
      undefined,
      undefined,
      {
        nativeMainRefreshDependencies: {
          refreshToken: async () => {
            throw new TokenRefreshError("unknown", "transient");
          },
        },
      },
    );

    expect(response.status).toBe(503);
    expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
  });
});
