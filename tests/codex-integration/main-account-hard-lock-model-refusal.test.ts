import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const MODEL = "gpt-5.5";
const MAIN_ACCOUNT = "lock-refusal-main";
const POOL_ID = "lock-refusal-pool";
const POOL_TOKEN = "fixture-lock-refusal-pool-access";
const mainToken = fakeChatGptJwt({
  exp: Math.floor(Date.now() / 1000) + 86_400,
  "https://api.openai.com/auth": { chatgpt_account_id: MAIN_ACCOUNT },
});
const shortResetAt = Math.floor(Date.now() / 1000) + 3_600;
const originalFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-lock-model-refusal-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth(POOL_ID);
  resetMainCodexAccountIdentityTrackingForTests();
  resetCodexModelEntitlementCacheForTests();
  observeMainQuotaIdentity(MAIN_ACCOUNT);
  observeMainQuotaCredential(mainToken, MAIN_ACCOUNT);
  saveCodexAccountCredential(POOL_ID, {
    accessToken: POOL_TOKEN, refreshToken: "fixture-lock-refusal-pool-refresh",
    expiresAt: Date.now() + 3_600_000, chatgptAccountId: "lock-refusal-pool-account",
  });
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  resetMainCodexAccountIdentityTrackingForTests();
  resetCodexModelEntitlementCacheForTests();
  await drainAndRemoveFixtureRoots({
    roots: [{ path: home }],
    restoreEnvironment: () => {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    },
  });
});

function observeMainShortUsage(shortPercent: number): void {
  const writer = captureMainQuotaWriter(MAIN_ACCOUNT);
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed("__main__", {
    shortPercent, shortResetAt, shortWindowSeconds: 18_000, weeklyPercent: 18,
  }, undefined, writer);
}

/** One turn through a pool of the main login and a stored account that cannot serve MODEL. */
async function dispatch(options: { hardLock?: false; poolRefusal?: Response; storedMain?: true } = {}): Promise<{ response: Response; sends: string[] }> {
  const sends: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).endsWith("/responses")) return new Response(null, { status: 404 });
    const bearer = new Headers(init?.headers).get("authorization");
    sends.push(bearer === `Bearer ${POOL_TOKEN}` ? "pool" : bearer === `Bearer ${mainToken}` ? "main" : "other");
    if (bearer === `Bearer ${POOL_TOKEN}`) {
      return options.poolRefusal ?? Response.json({
        detail: `The '${MODEL}' model is not supported when using Codex with a ChatGPT account.`,
      }, { status: 400 });
    }
    return Response.json({ id: "resp_lock_refusal_fixture", status: "completed", model: MODEL,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
  const config = {
    defaultProvider: "openai", autoSwitchThreshold: 0,
    ...(options.hardLock === false ? { codexMainAccountHardLock: false } : {}),
    providers: { openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool",
      baseUrl: "https://chatgpt.com/backend-api/codex", upstreamWebsocket: false } },
    codexAccounts: [{ id: POOL_ID, email: "pool@example.test", isMain: false, plan: "free" }],
  } as OcxConfig;
  if (options.storedMain) {
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      tokens: { access_token: mainToken, refresh_token: "fixture-lock-refusal-main-refresh", account_id: MAIN_ACCOUNT },
    }));
    reconcileMainCodexAccountRuntimeState();
  }
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json",
      ...(options.storedMain ? {} : { authorization: `Bearer ${mainToken}`, "chatgpt-account-id": MAIN_ACCOUNT }) },
    body: JSON.stringify({ model: MODEL, stream: false, input: "hello" }),
  }), config, { model: "", provider: "" }, {});
  return { response, sends };
}

test.each([
  ["the caller's own", {}],
  ["the stored", { storedMain: true }],
] as const)("a pool account's model refusal does not replace the hard-lock refusal for %s main login", async (_owner, options) => {
  observeMainShortUsage(91);
  const { response, sends } = await dispatch(options);
  expect(sends).toEqual(["pool"]);
  expect(response.status).toBe(429);
  const { error } = await response.json() as { error: Record<string, unknown> };
  expect(error).toMatchObject({ type: "usage_limit_reached", resets_at: shortResetAt });
  expect(String(error.message)).toContain("main-account quota policy");
});

test("a main login held at its usage limit with credits off answers the same way", async () => {
  observeMainShortUsage(100);
  const { response, sends } = await dispatch({ hardLock: false });
  expect(sends).toEqual(["pool"]);
  expect(response.status).toBe(429);
  const { error } = await response.json() as { error: Record<string, unknown> };
  expect(String(error.message)).toContain("spending ChatGPT credits is off");
});

test("a pool account's quota refusal is still returned while main is locked", async () => {
  observeMainShortUsage(91);
  const { response, sends } = await dispatch({ poolRefusal: Response.json(
    { error: { code: "usage_limit_reached", message: "fixture pool quota exhausted" } },
    { status: 429, headers: { "retry-after": "60" } },
  ) });
  expect(sends).toEqual(["pool"]);
  expect(response.status).toBe(429);
  const { error } = await response.json() as { error: Record<string, unknown> };
  expect(error.message).toBe("fixture pool quota exhausted");
});

test("below the lock threshold the caller's main serves the request itself", async () => {
  observeMainShortUsage(89);
  const { response, sends } = await dispatch();
  expect(sends).toEqual(["main"]);
  expect(response.status).toBe(200);
});
