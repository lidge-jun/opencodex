import { expect } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { removeTreeWithRetry } from "./remove-tree";
import { saveConfig } from "../../src/config";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearCodexWebSocketRegistry } from "../../src/codex/websocket-registry";
import { clearAccountNeedsReauth, clearAccountQuota, markAccountNeedsReauth, updateAccountQuota } from "../../src/codex/auth-api";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { startServer } from "../../src/server";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

export const POOL_RETRY_MODEL = "gpt-5.5";

/** Reuse the server-auth suite's owned home and transport redirection unchanged. */
export function createPoolRetryHarness(context: {
  testDir: string;
  originalFetch: typeof fetch;
  redirectCanonicalCodexTo: (baseUrl: string) => void;
  canonicalDirect: OcxProviderConfig;
}) {
  const { testDir: TEST_DIR, originalFetch: originalGlobalFetch,
    redirectCanonicalCodexTo, canonicalDirect } = context;

  function unsupportedModelBody(model = POOL_RETRY_MODEL): string {
    return JSON.stringify({
      detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
    });
  }

  type PoolRetryHarness = {
    config: OcxConfig;
    dispatches: string[];
    request: (init?: {
      stream?: boolean;
      signal?: AbortSignal;
      model?: string;
      path?: "/v1/responses" | "/v1/responses/compact";
      callerBearer?: boolean;
      headers?: Record<string, string>;
      extraBody?: Record<string, unknown>;
    }) => Promise<Response>;
    restoreFetch: () => void;
    server: ReturnType<typeof startServer>;
    upstream: ReturnType<typeof Bun.serve>;
  };

  async function removeTestDirBestEffort(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    // Windows can keep the prior harness's ACL/icacls handles for a beat after
    // stop; a single EBUSY must not take down the rest of the file.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        removeTreeWithRetry(dir);
        return;
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
        await Bun.sleep(25 * (attempt + 1));
      }
    }
    removeTreeWithRetry(dir);
  }

  async function startPoolRetryHarness(
    reply: (accountId: string, request: Request) => Response | Promise<Response>,
    options: {
      secondAccount?: boolean;
      streamMode?: "legacy-tee" | "eager-relay";
      accountMode?: "direct" | "pool";
      activeAccountId?: string;
      accountNamespaces?: Record<string, string>;
      noVisionModels?: string[];
      visionSidecarModel?: string;
      websockets?: boolean;
      forwardApiKey?: string;
      pausedAccountIds?: string[];
      reauthAccountIds?: string[];
      omitCredentialAccountIds?: string[];
      combos?: OcxConfig["combos"];
      modelRosterByAccount?: Record<string, string[]>;
    } = {},
  ): Promise<PoolRetryHarness> {
    await removeTestDirBestEffort(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountQuota();
    resetCodexModelEntitlementCacheForTests();
    clearRequestLogsForTests();
    clearAccountNeedsReauth("pool-a");
    clearAccountNeedsReauth("pool-b");
    // The registry is process-global and survives a harness teardown. WS-REBIND-01
    // asserts exact per-account socket counts, so a socket leaked by any earlier test
    // in this file shifts its snapshots and fails it in milliseconds — which reads as
    // a flake next to the timeouts, but is ordinary shared state. Reset it with the
    // rest rather than leaving one of six kinds of state uncleaned.
    clearCodexWebSocketRegistry();

    const dispatches: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const accountId = request.headers.get("chatgpt-account-id") ?? "missing";
        if (new URL(request.url).pathname === "/models") {
          return Response.json({
            models: (options.modelRosterByAccount?.[accountId] ?? []).map(slug => ({
              slug,
              supported_in_api: true,
              visibility: "list",
            })),
          });
        }
        dispatches.push(accountId);
        return reply(accountId, request);
      },
    });
    redirectCanonicalCodexTo(upstream.url.toString());
    const redirectedFetch = globalThis.fetch;

    const secondAccount = options.secondAccount ?? true;
    const config = {
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          ...canonicalDirect,
          codexAccountMode: options.accountMode ?? "pool",
          ...(options.noVisionModels ? { noVisionModels: options.noVisionModels } : {}),
          ...(options.forwardApiKey ? { apiKey: options.forwardApiKey } : {}),
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
        ...(secondAccount
          ? [{ id: "pool-b", email: "pool-b@example.test", isMain: false, chatgptAccountId: "acct-pool-b" }]
          : []),
      ],
      activeCodexAccountId: options.activeAccountId ?? "pool-a",
      ...(options.accountNamespaces ? { codexAccountNamespaces: options.accountNamespaces } : {}),
      ...(options.pausedAccountIds ? { pausedCodexAccountIds: options.pausedAccountIds } : {}),
      ...(options.visionSidecarModel ? { visionSidecar: { model: options.visionSidecarModel } } : {}),
      ...(options.websockets ? { websockets: true } : {}),
      ...(options.streamMode ? { streamMode: options.streamMode } : {}),
      ...(options.combos ? { combos: options.combos } : {}),
    } as OcxConfig;
    saveConfig(config);
    if (!options.omitCredentialAccountIds?.includes("pool-a")) {
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-a-token",
        refreshToken: "pool-a-refresh",
        expiresAt: Date.now() + 10 * 60_000,
        chatgptAccountId: "acct-pool-a",
      });
    }
    updateAccountQuota("pool-a", 10);
    if (secondAccount) {
      if (!options.omitCredentialAccountIds?.includes("pool-b")) {
        saveCodexAccountCredential("pool-b", {
          accessToken: "pool-b-token",
          refreshToken: "pool-b-refresh",
          expiresAt: Date.now() + 10 * 60_000,
          chatgptAccountId: "acct-pool-b",
        });
      }
      updateAccountQuota("pool-b", 20);
    }
    for (const accountId of options.reauthAccountIds ?? []) markAccountNeedsReauth(accountId);

    const server = startServer(0);
    return {
      config,
      dispatches,
      restoreFetch: () => {
        if (globalThis.fetch === redirectedFetch) globalThis.fetch = originalGlobalFetch;
      },
      server,
      upstream,
      request: ({
        stream = false,
        signal,
        model = POOL_RETRY_MODEL,
        path = "/v1/responses",
        callerBearer = true,
        headers = {},
        extraBody = {},
      } = {}) => originalGlobalFetch(new URL(path, server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(callerBearer ? { authorization: "Bearer inbound-token" } : {}),
          ...headers,
        },
        body: JSON.stringify({ model, input: path.endsWith("/compact") ? [] : "hello", stream, ...extraBody }),
        signal,
      }),
    };
  }

  async function stopPoolRetryHarness(harness: PoolRetryHarness): Promise<void> {
    harness.restoreFetch();
    await harness.server.stop(true);
    await harness.upstream.stop(true);
  }

  function rejectionResponse(body: BodyInit, headers: Record<string, string> = {}): Response {
    return new Response(body, {
      status: 400,
      statusText: "Account Model Rejected",
      headers: { "content-type": "application/json", "x-pool-retry-test": "original", ...headers },
    });
  }

  async function expectOriginal400(response: Response, body: string): Promise<void> {
    expect(response.status).toBe(400);
    expect(response.headers.get("x-pool-retry-test")).toBe("original");
    expect(await response.text()).toBe(body);
  }
  return { startPoolRetryHarness, stopPoolRetryHarness, rejectionResponse, expectOriginal400, unsupportedModelBody };
}
