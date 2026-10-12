import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota } from "../../src/codex/auth-api";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../../src/codex/routing";
import { resetDebugLogBufferForTests } from "../../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests } from "../../src/lib/debug-settings";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { createPoolRetryHarness } from "../helpers/codex-pool-retry";
import {
  POOL_RETRY_TEST_DIR,
  canonicalDirect,
  redirectCanonicalCodexTo,
} from "../helpers/pool-retry-harness";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
const originalGlobalWebSocket = globalThis.WebSocket;
const { startPoolRetryHarness, stopPoolRetryHarness } = createPoolRetryHarness({
  testDir: POOL_RETRY_TEST_DIR, originalFetch: originalGlobalFetch,
  redirectCanonicalCodexTo, canonicalDirect,
});
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
  globalThis.WebSocket = originalGlobalWebSocket;
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  clearAccountQuota();
  resetCodexModelEntitlementCacheForTests();
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (existsSync(POOL_RETRY_TEST_DIR)) removeTreeWithRetry(POOL_RETRY_TEST_DIR);
});

describe("server local API auth", () => {
  test.each([429, 402] as const)(
    "a same-workspace caller main is bound by its workspace id and never sees a %i scoped refusal",
    async rejection => {
      // The alternate resolved here is the request's own main credential: it has no
      // stored account id, so the scope gate can only bind it by the workspace id the
      // caller credential would materialize upstream.
      const model = "gpt-daybreak-blue-latest";
      const harness = await startPoolRetryHarness(() => new Response(
        JSON.stringify({
          error: {
            code: "organization_spend_limit_exceeded",
            message: "The usage limit has been reached",
          },
        }),
        { status: rejection, headers: { "content-type": "application/json", "retry-after": "60" } },
      ), {
        secondAccount: false,
        modelRosterByAccount: { "acct-pool-a": [model] },
      });
      try {
        const response = await harness.request({
          model,
          headers: { "chatgpt-account-id": "acct-pool-a" },
        });
        expect(response.status).toBe(rejection);
        expect(harness.dispatches).toEqual(["acct-pool-a"]);
      } finally {
        await stopPoolRetryHarness(harness);
      }
    },
    { timeout: SERVER_BUDGET_MS },
  );

  test("a same-workspace caller main is also bound by the bearer token's account claim", async () => {
    const model = "gpt-daybreak-blue-latest";
    const harness = await startPoolRetryHarness(() => new Response(
      JSON.stringify({
        error: {
          code: "organization_spend_limit_exceeded",
          message: "The usage limit has been reached",
        },
      }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
    ), {
      secondAccount: false,
      modelRosterByAccount: { "acct-pool-a": [model] },
    });
    try {
      const response = await harness.request({
        model,
        headers: {
          authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-pool-a" })}`,
        },
      });
      expect(response.status).toBe(429);
      expect(harness.dispatches).toEqual(["acct-pool-a"]);
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });

  test("a suppressed 5xx-wrapped scoped refusal still records its normalized quota outcome", async () => {
    // ChatGPT sometimes wraps quota exhaustion in a generic 5xx. Suppressing the
    // same-workspace alternate must still record the normalized 429 on the refused
    // account — otherwise it earns only a transient failure and stays selectable.
    // Both credentials carry the same workspace header, so the credential each physical send
    // presents is the only evidence of which account it used.
    const credentials: string[] = [];
    const harness = await startPoolRetryHarness((_accountId, request) => {
      credentials.push(request.headers.get("authorization") ?? "missing");
      return new Response(
        JSON.stringify({
          error: {
            code: "organization_spend_limit_exceeded",
            message: "The usage limit has been reached",
          },
        }),
        // No Retry-After: the send layer honours it as a real wait, so the cooldown must
        // come from the normalized quota record's default, not the wire header.
        { status: 502, headers: { "content-type": "application/json" } },
      );
    });
    try {
      // pool-b shares pool-a's workspace, so the resolved alternate is suppressed.
      saveCodexAccountCredential("pool-b", {
        accessToken: "pool-b-token",
        refreshToken: "pool-b-refresh",
        expiresAt: Date.now() + 10 * 60_000,
        chatgptAccountId: "acct-pool-a",
      });
      const response = await harness.request();
      expect(response.status).toBe(502);
      // Same-account transient retries may repeat the refused credential; the suppressed
      // alternate's credential must never be presented.
      expect(credentials.length).toBeGreaterThan(0);
      expect(credentials.length).toBe(harness.dispatches.length);
      expect(credentials.some(value => value.includes("pool-b-token"))).toBe(false);
      expect(new Set(credentials).size).toBe(1);
      const health = getCodexUpstreamHealth("pool-a");
      expect(health).toMatchObject({ cooldownSource: "default" });
      expect(health?.cooldownUntil).toBeGreaterThan(Date.now());
    } finally {
      await stopPoolRetryHarness(harness);
    }
  }, { timeout: SERVER_BUDGET_MS });
});
