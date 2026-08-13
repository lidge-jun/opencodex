import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackCodexAccountLogLabel } from "../src/codex/account-label";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../src/codex/routing";
import type { RequestLogContext } from "../src/server/request-log";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

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
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: false }),
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
    rmSync(home, { recursive: true, force: true });
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
});
