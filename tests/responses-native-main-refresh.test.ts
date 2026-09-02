import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { isAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { getValidMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { withNativeMainSharedClaim } from "../src/codex/native-main-claim";
import type { NativeProfileContext } from "../src/codex/native-profile-store";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import { handleResponses, handleResponsesCompact } from "../src/server/responses";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const originalFetch = globalThis.fetch;
let home = "";
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;
const OTHER_ACCOUNT_ID = "other";

function config(options: { secondAccount?: boolean } = {}): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: options.secondAccount ? [{ id: OTHER_ACCOUNT_ID, label: "other" }] : [],
    ...(options.secondAccount ? { accountPoolStrategy: "fill-first" } : {}),
  } as OcxConfig;
}

function request(path: "/v1/responses" | "/v1/responses/compact", signal?: AbortSignal): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(path.endsWith("compact")
      ? { model: "gpt-5.5", input: [] }
      : { model: "gpt-5.5", input: "hello", stream: false }),
    signal,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-responses-main-refresh-"));
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: {
      access_token: "rejected-access",
      refresh_token: "refresh-grant",
      account_id: "account-main",
    },
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(OTHER_ACCOUNT_ID);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

function install401ThenRefreshHarness(): { sends: string[]; refreshes: string[] } {
  const sends: string[] = [];
  const refreshes: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "auth.openai.com") {
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshes.push(refresh);
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }
    if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/responses/compact")) {
      return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    sends.push(authorization);
    if (sends.length === 1) {
      return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
    }
    return Response.json({ id: "resp_refreshed", object: "response", status: "completed", output: [] });
  }) as typeof fetch;
  return { sends, refreshes };
}

describe("native main 401 refresh and replay", () => {
  test("refreshes a refresh-only native main credential before upstream I/O", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
    }));
    const sends: string[] = [];
    let refreshes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "auth.openai.com") {
        refreshes += 1;
        return Response.json({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      if (url.pathname.endsWith("/responses")) {
        sends.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      return Response.json({ id: "resp_refreshed", object: "response", status: "completed", output: [] });
    }) as typeof fetch;

    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(refreshes).toBe(1);
    expect(sends).toEqual(["Bearer refreshed-access"]);
  });

  test("converts an outer native-main claim timeout into a transient refresh failure", async () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
    }));
    let releaseHolder!: () => void;
    const holderRelease = new Promise<void>(resolve => { releaseHolder = resolve; });
    let holderEntered!: () => void;
    const holderReady = new Promise<void>(resolve => { holderEntered = resolve; });
    const holder = withNativeMainSharedClaim(
      { codexHome: home } as NativeProfileContext,
      async () => {
        holderEntered();
        await holderRelease;
      },
      { hardenPath: async () => {} },
    );
    await holderReady;

    const timeout = new AbortController();
    const addListener = spyOn(timeout.signal, "addEventListener");
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const pending = getValidMainAccountToken();
      // Yield to the macrotask queue, not only microtasks: on Windows the exclusive claim
      // hardens its lock file through an icacls/PowerShell subprocess before it ever reaches
      // the abort listener, and a microtask spin never lets that child's exit callback run.
      // Dispatch 33597649234 shard 4 sat here for 8 minutes until the job ceiling.
      while (!addListener.mock.calls.some(([type]) => type === "abort")) await Bun.sleep(1);
      timeout.abort(new DOMException("claim timed out", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({
        name: "MainAccountTokenRefreshError",
        reason: "transient",
      });
    } finally {
      timeoutSpy.mockRestore();
      releaseHolder();
      await holder;
    }
  });

  test("Responses refreshes and performs exactly one physical replay", async () => {
    const harness = install401ThenRefreshHarness();
    const response = await handleResponses(
      request("/v1/responses"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens.refresh_token)
      .toBe("rotated-refresh");
  });

  test("compact refreshes and performs exactly one physical replay", async () => {
    const harness = install401ThenRefreshHarness();
    const response = await handleResponsesCompact(
      request("/v1/responses/compact"),
      config(),
      { model: "", provider: "" } as RequestLogContext,
    );

    expect(response.status).toBe(200);
    expect(harness.sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access"]);
    expect(harness.refreshes).toEqual(["refresh-grant"]);
  });

  for (const path of ["/v1/responses", "/v1/responses/compact"] as const) {
    test(`${path} keeps main-pool recovery eligible for a later Pool account`, async () => {
      saveCodexAccountCredential(OTHER_ACCOUNT_ID, {
        accessToken: "other-access",
        refreshToken: "other-refresh",
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: "account-other",
      });
      const sends: string[] = [];
      const refreshes: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "auth.openai.com") {
          refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
          return Response.json({
            access_token: "refreshed-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          });
        }
        if (!url.pathname.endsWith("/responses") && !url.pathname.endsWith("/responses/compact")) {
          return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
        }
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        sends.push(authorization);
        if (authorization === "Bearer rejected-access") {
          return Response.json({ error: { message: "expired bearer" } }, { status: 401 });
        }
        if (authorization === "Bearer refreshed-access") {
          return Response.json({ error: { message: "main quota exhausted" } }, { status: 429 });
        }
        if (authorization === "Bearer other-access") {
          return Response.json({ id: "resp_other", object: "response", status: "completed", output: [] });
        }
        return Response.json({ error: { message: "unexpected bearer" } }, { status: 500 });
      }) as typeof fetch;

      const cfg = config({ secondAccount: true });
      const response = path.endsWith("compact")
        ? await handleResponsesCompact(request(path), cfg, { model: "", provider: "" } as RequestLogContext)
        : await handleResponses(request(path), cfg, { model: "", provider: "" } as RequestLogContext);

      expect(response.status).toBe(200);
      expect(sends).toEqual(["Bearer rejected-access", "Bearer refreshed-access", "Bearer other-access"]);
      expect(refreshes).toEqual(["refresh-grant"]);
    });
  }

  test.each(["/v1/responses", "/v1/responses/compact"] as const)(
    "%s keeps the WebSocket string-abort claim cancellation as 499 without quarantining main",
    async path => {
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        tokens: { refresh_token: "refresh-grant", account_id: "account-main" },
      }));
      let releaseHolder!: () => void;
      const holderRelease = new Promise<void>(resolve => { releaseHolder = resolve; });
      let holderEntered!: () => void;
      const holderReady = new Promise<void>(resolve => { holderEntered = resolve; });
      const holder = withNativeMainSharedClaim(
        { codexHome: home } as NativeProfileContext,
        async () => {
          holderEntered();
          await holderRelease;
        },
        { hardenPath: async () => {} },
      );
      await holderReady;

      const controller = new AbortController();
      const originalAny = AbortSignal.any;
      let claimWaitListener: ReturnType<typeof spyOn> | undefined;
      const anySpy = spyOn(AbortSignal, "any").mockImplementation(signals => {
        const combined = originalAny.call(AbortSignal, signals);
        claimWaitListener = spyOn(combined, "addEventListener");
        return combined;
      });
      try {
        const pending = path === "/v1/responses"
          ? handleResponses(
            request(path, controller.signal),
            config(),
            { model: "", provider: "" } as RequestLogContext,
            { abortSignal: controller.signal, inboundTransport: "websocket" },
          )
          : handleResponsesCompact(
            request(path, controller.signal),
            config(),
            { model: "", provider: "" } as RequestLogContext,
          );
        while (!claimWaitListener?.mock.calls.some(([type]) => type === "abort")) await Bun.sleep(1);
        controller.abort("websocket turn superseded or closed");

        const response = await pending;
        expect(response.status).toBe(499);
        expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
      } finally {
        anySpy.mockRestore();
        releaseHolder();
        await holder;
      }
    },
  );
});
