import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackCodexAccountLogLabel } from "../../src/codex/account-label";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, getAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
} from "../../src/codex/routing";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { CodexWsMetadata } from "../../src/server/responses/codex-ws-metadata";
import { applyAccountQuotaFromUpstreamHeaders } from "../../src/codex/quota";

const originalFetch = globalThis.fetch;

function poolConfig(accountIds: string[]): OcxConfig {
  return {
    defaultProvider: "openai",
    activeCodexAccountId: accountIds[0],
    autoSwitchThreshold: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: accountIds.map(id => ({
      id,
      email: `${id}@example.test`,
      isMain: false,
      chatgptAccountId: `${id}_chatgpt`,
    })),
  } as OcxConfig;
}

function completedResponse(id: string): Response {
  return Response.json({
    id,
    status: "completed",
    output: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
}

function request(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }),
  });
}

function savePoolCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `${id}-access-token`,
    refreshToken: `${id}-refresh-token`,
    expiresAt: Date.now() + 300_000,
    chatgptAccountId: `${id}_chatgpt`,
  });
}

async function withPoolHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "ocx-responses-account-label-"));
  const previousOpencodexHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  try {
    return await run(home);
  } finally {
    globalThis.fetch = originalFetch;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountQuota();
    removeTreeWithRetry(home);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Responses account usage attribution", () => {
  test("interleaved old WS metadata cannot overwrite a newer account observation", async () => {
    await withPoolHome(async () => {
      const old = new CodexWsMetadata(headers => applyAccountQuotaFromUpstreamHeaders("observed-account", headers));
      old.commit();
      old.consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, reset_at: 1900000000 } } }, 100);
      updateAccountQuota("observed-account", 90);
      const before = { ...getAccountQuota("observed-account")! };
      old.consume({ type: "codex.response.metadata", headers: { "x-models-etag": "changed" } }, 100);
      old.consume({ type: "codex.rate_limits", metered_limit_name: "codex_bengalfox", rate_limits: { primary: { used_percent: 1 } } }, 100);
      expect(getAccountQuota("observed-account")).toEqual(before);
      old.consume({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 91 } } }, 100);
      expect(getAccountQuota("observed-account")?.weeklyPercent).toBe(91);
      expect(getAccountQuota("observed-account")?.weeklyResetAt).toBeUndefined();
      old.finish();
    });
  });

  test("immediate WS quota observation preserves disjoint windows and credits-only interleaving", async () => {
    await withPoolHome(async () => {
      const { setAccountQuotaFromParsed } = await import("../../src/codex/quota");
      const owner = new CodexWsMetadata(headers => applyAccountQuotaFromUpstreamHeaders("window-account", headers));
      owner.consume({ type: "codex.rate_limits", rate_limits: {
        primary: { used_percent: 100, window_minutes: 300, reset_at: 1900000000 },
        secondary: { used_percent: 20, window_minutes: 10080 },
      } }, 100);
      setAccountQuotaFromParsed("window-account", { resetCredits: 3 });
      owner.consume({ type: "codex.rate_limits", rate_limits: { secondary: { used_percent: 21, window_minutes: 10080 } } }, 100);
      owner.finish();
      expect(getAccountQuota("window-account")).toMatchObject({ shortPercent: 100, shortWindowSeconds: 18000, weeklyPercent: 21, resetCredits: 3 });
    });
  });

  test("WS prelude and final quota stay with the selected pool or main-pool account", async () => {
    const originalWebSocket = globalThis.WebSocket;
    try {
      await withPoolHome(async home => {
        writeFileSync(join(home, "auth.json"), JSON.stringify({
          tokens: { access_token: "main-access-token", account_id: "main-account" },
        }));
        savePoolCredential("pool-ws");
        class MetadataSocket {
          listeners = new Map<string, Array<(event: unknown) => void>>();
          constructor() { queueMicrotask(() => this.emit("open", {})); }
          addEventListener(type: string, listener: (event: unknown) => void) {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
          }
          removeEventListener(type: string, listener: (event: unknown) => void) {
            this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener));
          }
          emit(type: string, event: unknown) {
            for (const listener of this.listeners.get(type) ?? []) listener(event);
          }
          send() {
            queueMicrotask(() => {
              const payload = (value: unknown) => this.emit("message", { data: JSON.stringify(value) });
              const quota = (percent: number) => payload({ type: "codex.rate_limits", rate_limits: {
                primary: { used_percent: percent, window_minutes: 10080, reset_at: 1900000000 },
              } });
              quota(10);
              payload({ type: "response.created", response: { id: "quota-response" } });
              quota(20);
              payload({ type: "response.completed", response: { id: "quota-response", status: "completed", output: [] } });
            });
          }
          close() { this.emit("close", {}); }
        }
        globalThis.WebSocket = MetadataSocket as unknown as typeof WebSocket;
        globalThis.fetch = (async () => { throw new Error("unexpected HTTP request"); }) as typeof fetch;
        for (const accountId of ["pool-ws", MAIN_CODEX_ACCOUNT_ID]) {
          clearAccountQuota();
          updateAccountQuota(accountId, 0);
          updateAccountQuota("untouched-account", 7);
          const config = poolConfig(accountId === MAIN_CODEX_ACCOUNT_ID ? [] : [accountId]);
          config.activeCodexAccountId = accountId;
          const req = new Request("http://localhost/v1/responses", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
          });
          const response = await handleResponses(req, config, { model: "", provider: "" }, {
            codexWsRuntimeIdentity: "1.4.0",
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("x-codex-primary-used-percent")).toBe("10");
          await response.text();
          expect(getAccountQuota(accountId)?.weeklyPercent).toBe(20);
          expect(getAccountQuota("untouched-account")?.weeklyPercent).toBe(7);
        }
      });
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });

  test("main-pool and legacy added accounts carry their effective labels", async () => {
    await withPoolHome(async home => {
      writeFileSync(join(home, "auth.json"), JSON.stringify({
        tokens: { access_token: "main-access-token", account_id: "main-account" },
      }));
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 0);
      globalThis.fetch = (async () => completedResponse("main-response")) as typeof fetch;

      const mainConfig = poolConfig([]);
      mainConfig.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
      const mainLog: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponses(request(), mainConfig, mainLog, {})).status).toBe(200);
      expect(mainLog.accountLogLabel).toBe("main");
      expect(mainLog.activeAttempt?.accountLogLabel).toBe("main");

      const poolConfigValue = poolConfig(["pool-a"]);
      savePoolCredential("pool-a");
      updateAccountQuota("pool-a", 0);
      const poolLog: RequestLogContext = { model: "", provider: "" };
      expect((await handleResponses(request(), poolConfigValue, poolLog, {})).status).toBe(200);
      expect(poolLog.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-a"));
      expect(poolLog.activeAttempt?.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-a"));
    });
  });

  test("a pre-stream quota retry updates attribution to the serving alternate account", async () => {
    await withPoolHome(async () => {
      const config = poolConfig(["pool-a", "pool-b"]);
      for (const id of ["pool-a", "pool-b"]) {
        savePoolCredential(id);
        updateAccountQuota(id, id === "pool-a" ? 10 : 20);
      }
      const bearers: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        bearers.push(bearer);
        if (bearers.length === 1) {
          return Response.json({ error: { message: "rate limited" } }, {
            status: 429,
            headers: { "retry-after": "42" },
          });
        }
        return completedResponse("pool-b-response");
      }) as typeof fetch;

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(request(), config, logCtx, {});

      expect(response.status).toBe(200);
      expect(bearers).toEqual(["Bearer pool-a-access-token", "Bearer pool-b-access-token"]);
      expect(logCtx.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-b"));
      expect(logCtx.activeAttempt?.accountLogLabel).toBe(fallbackCodexAccountLogLabel("pool-b"));
    });
  });

  test("a quota message wrapped in HTTP 502 cools the account and retries an alternate", async () => {
    await withPoolHome(async () => {
      const config = poolConfig(["pool-a", "pool-b"]);
      for (const id of ["pool-a", "pool-b"]) {
        savePoolCredential(id);
        updateAccountQuota(id, id === "pool-a" ? 10 : 20);
      }
      const bearers: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const bearer = new Headers(init?.headers).get("authorization") ?? "";
        bearers.push(bearer);
        if (bearer === "Bearer pool-a-access-token") {
          return Response.json({ error: { message: "The usage limit has been reached" } }, {
            status: 502,
          });
        }
        return completedResponse("pool-b-response");
      }) as typeof fetch;

      const response = await handleResponses(request(), config, { model: "", provider: "" }, {});

      expect(response.status).toBe(200);
      expect(bearers).toEqual([
        "Bearer pool-a-access-token",
        "Bearer pool-a-access-token",
        "Bearer pool-a-access-token",
        "Bearer pool-b-access-token",
      ]);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        lastFailureStatus: 429,
        cooldownSource: "default",
      });
      expect(getCodexUpstreamHealth("pool-a")?.cooldownUntil).toBeGreaterThan(Date.now());
    });
  });

  test("a wrapped quota failure cools a sole account when no alternate exists", async () => {
    await withPoolHome(async () => {
      const config = poolConfig(["pool-a"]);
      savePoolCredential("pool-a");
      updateAccountQuota("pool-a", 10);
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return Response.json({ error: { message: "The usage limit has been reached" } }, {
          status: 502,
        });
      }) as typeof fetch;

      const response = await handleResponses(request(), config, { model: "", provider: "" }, {});

      expect(response.status).toBe(502);
      expect(sends).toBe(3);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        cooldownSource: "default",
      });
      expect(getCodexUpstreamHealth("pool-a")?.cooldownUntil).toBeGreaterThan(Date.now());
    });
  });
});
