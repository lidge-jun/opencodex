import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenRefreshError } from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { clearAccountQuota } from "../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { resetMainCodexAccountIdentityTrackingForTests } from "../src/codex/account-lifecycle";
import { handleResponses } from "../src/server/responses";
import * as adapterResolveModule from "../src/server/adapter-resolve";
import type { OAuthCredentials } from "../src/oauth/types";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originalFetch = globalThis.fetch;

let isolatedCodexHome: IsolatedCodexHome;
let opencodexHome: string;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-responses-main-refresh-codex-");
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-responses-main-refresh-store-"));
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
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      store: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
}

function success(): Response {
  return Response.json({
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    output: [],
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

describe("Responses native main refresh", () => {
  test("replays one native-main 401 with the refreshed bearer", async () => {
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

    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(request(), config(), logCtx, {
      nativeMainRefreshDependencies: {
        refreshToken: async () => refreshed(freshAccess),
      },
    });

    expect(response.status).toBe(200);
    expect(bearers).toEqual([`Bearer ${initialAccess}`, `Bearer ${freshAccess}`]);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["codex-main-401"]);
  });

  test("does not replay native-main 401 more than once", async () => {
    const initialAccess = jwt("initial-always", 3_600);
    const freshAccess = jwt("fresh-always", 3_600, "fresh-account");
    writeAuth(initialAccess);
    const bearers: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/backend-api/wham/usage")) return Response.json({});
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ error: { message: "still unauthorized" } }, { status: 401 });
    }) as typeof fetch;

    const response = await handleResponses(request(), config(), { model: "", provider: "" }, {
      nativeMainRefreshDependencies: {
        refreshToken: async () => refreshed(freshAccess),
      },
    });

    expect(response.status).toBe(401);
    expect(bearers).toEqual([`Bearer ${initialAccess}`, `Bearer ${freshAccess}`]);
  });

  test("replays one generic-adapter native-main 401 with the refreshed bearer", async () => {
    const initialAccess = jwt("initial-generic", 3_600);
    const freshAccess = jwt("fresh-generic", 3_600, "fresh-account");
    writeAuth(initialAccess);
    const bearers: string[] = [];
    const adapterSpy = spyOn(adapterResolveModule, "resolveAdapter").mockReturnValue({
      name: "test-generic",
      buildRequest: (_parsed, incoming) => ({
        url: "https://fixture.test/v1/responses",
        method: "POST",
        headers: Object.fromEntries(incoming.headers.entries()),
        body: "{}",
      }),
      async parseResponse() {
        return [{ type: "text_delta", text: "ok" }, { type: "done" }];
      },
      async *parseStream() {
        yield { type: "text_delta", text: "ok" };
        yield { type: "done" };
      },
    } as ReturnType<typeof adapterResolveModule.resolveAdapter>);
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bearers.push(new Headers(init?.headers).get("authorization") ?? "");
        return bearers.length === 1
          ? Response.json({ error: { message: "expired" } }, { status: 401 })
          : success();
      }) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(), config(), logCtx, {
        nativeMainRefreshDependencies: {
          refreshToken: async () => refreshed(freshAccess),
        },
      });

      expect(response.status).toBe(200);
      expect(bearers).toEqual([`Bearer ${initialAccess}`, `Bearer ${freshAccess}`]);
      expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["codex-main-401"]);
    } finally {
      adapterSpy.mockRestore();
    }
  });

  test("does not replay generic-adapter native-main 401 more than once", async () => {
    const initialAccess = jwt("initial-generic-always", 3_600);
    const freshAccess = jwt("fresh-generic-always", 3_600, "fresh-account");
    writeAuth(initialAccess);
    const bearers: string[] = [];
    const adapterSpy = spyOn(adapterResolveModule, "resolveAdapter").mockReturnValue({
      name: "test-generic",
      buildRequest: (_parsed, incoming) => ({
        url: "https://fixture.test/v1/responses",
        method: "POST",
        headers: Object.fromEntries(incoming.headers.entries()),
        body: "{}",
      }),
      async parseResponse() {
        return [{ type: "text_delta", text: "should not parse" }, { type: "done" }];
      },
      async *parseStream() {
        yield { type: "text_delta", text: "should not parse" };
        yield { type: "done" };
      },
    } as ReturnType<typeof adapterResolveModule.resolveAdapter>);
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bearers.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ error: { message: "still unauthorized" } }, { status: 401 });
      }) as typeof fetch;

      const response = await handleResponses(request(), config(), { model: "", provider: "" }, {
        nativeMainRefreshDependencies: {
          refreshToken: async () => refreshed(freshAccess),
        },
      });

      expect(response.status).toBe(401);
      expect(bearers).toEqual([`Bearer ${initialAccess}`, `Bearer ${freshAccess}`]);
    } finally {
      adapterSpy.mockRestore();
    }
  });

  test("logs retryable native-main refresh failures without reauthentication guidance", async () => {
    writeAuth(jwt("expired-transient-log", -3_600));
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const response = await handleResponses(request(), config(), { model: "", provider: "" }, {
        nativeMainRefreshDependencies: {
          refreshToken: async () => {
            throw new TokenRefreshError("unknown", "transient");
          },
        },
      });

      expect(response.status).toBe(503);
      expect(errors.some(line => line.includes("retryable refresh failure"))).toBe(true);
      expect(errors.some(line => line.includes("reauthentication required"))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("returns auth failure before upstream I/O when pre-request refresh is revoked", async () => {
    writeAuth(jwt("expired-revoked", -3_600));
    let sends = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/backend-api/wham/usage")) return Response.json({});
      sends += 1;
      return success();
    }) as typeof fetch;

    const response = await handleResponses(request(), config(), { model: "", provider: "" }, {
      nativeMainRefreshDependencies: {
        refreshToken: async () => {
          throw new TokenRefreshError("revoked", "revoked");
        },
      },
    });

    expect(response.status).toBe(401);
    expect(sends).toBe(0);
  });
});
