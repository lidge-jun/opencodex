import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { handleResponses } from "../../src/server/responses";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearFallbackEventsForTests, recentFallbackEvents } from "../../src/routing/fallback-policy";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const originalFetch = globalThis.fetch;
const callerId = "profile-dispatch-caller";
const callerToken = fakeChatGptJwt({ chatgpt_account_id: callerId, exp: 4102444800 });
let home: TempHome;
let releaseSpendHome: (() => void) | undefined;
let sent: Array<{ model: unknown; callerCredential: boolean; callerAccount: boolean }>;

beforeEach(() => {
  // Every network request terminates here; unexpected URLs fail instead of reaching a provider.
  sent = [];
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.hostname !== "chatgpt.com" || !url.pathname.endsWith("/responses")) {
      throw new Error(`Unexpected fixture destination: ${url.origin}${url.pathname}`);
    }
    const headers = new Headers(init?.headers ?? request.headers);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : await request.text());
    sent.push({ model: body.model,
      callerCredential: headers.get("authorization") === `Bearer ${callerToken}`,
      callerAccount: headers.get("chatgpt-account-id") === callerId });
    return Response.json({ id: "resp_profile_fixture", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
  home = createTempHome("ocx-main-lock-profile-dispatch-");
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearFallbackEventsForTests();
  observeMainQuotaIdentity("profile-dispatch-locked-main");
  const writer = captureMainQuotaWriter("profile-dispatch-locked-main");
  if (!writer) throw new Error("Fixture main identity was not observed");
  setAccountQuotaFromParsed("__main__", { weeklyPercent: 98 }, undefined, writer);
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  closeRequestHistoryIndex();
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearFallbackEventsForTests();
  globalThis.fetch = originalFetch;
  home.remove();
});

function config(modelFallback: boolean): OcxConfig {
  return {
    providers: {
      openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool", baseUrl: "https://chatgpt.com/backend-api/codex" },
      deepseek: { adapter: "openai-responses", authMode: "key", apiKey: "fixture-unused-key" },
    },
    codexAccounts: [],
    codexMainAccountHardLockFallback: { model: "policy/rescue" },
    fallback: { provider: true, model: modelFallback },
    routingProfiles: { rescue: { candidates: [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "deepseek", model: "deepseek-chat" },
    ] } },
  } as OcxConfig;
}

async function dispatch(modelFallback: boolean) {
  const cfg = config(modelFallback);
  const budget = createRequestExecutionBudget();
  expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  expect(existsSync(home.path(".codex", "auth.json"))).toBe(false);
  // An unrelated caller's own credential can serve the ranked model. This prevents the
  // independent stored-main lock from masking a missing first-selection policy check.
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${callerToken}`, "chatgpt-account-id": callerId },
    body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
  }), cfg, { model: "", provider: "" }, { sendBudget: budget });
  return { response, used: budget.used };
}

test("model fallback off refuses the first ranked profile model before dispatch", async () => {
  const { response, used } = await dispatch(false);
  expect(used).toBe(0);
  expect(recentFallbackEvents()).toHaveLength(1);
  expect(response.status).toBe(429);
  expect(response.headers.get("x-opencodex-fallback")).toBe("refused");
  expect(sent).toEqual([]);
  expect(recentFallbackEvents().at(-1)).toMatchObject({
    site: "routing-profile", outcome: "refused", kind: "model", trigger: "hard_lock",
    from: "openai/gpt-5.3", to: "openai/gpt-5.4",
  });
});

test("model fallback on lets the first ranked profile model use the caller's credential", async () => {
  const { response, used } = await dispatch(true);
  expect(used).toBe(1);
  expect(recentFallbackEvents()).toMatchObject([{ site: "routing-profile", outcome: "taken", kind: "model" }]);
  expect(recentFallbackEvents()).toHaveLength(1);
  expect(response.status).toBe(200);
  expect(response.headers.get("x-opencodex-fallback")).toBeNull();
  expect(sent).toEqual([{ model: "gpt-5.4", callerCredential: true, callerAccount: true }]);
  expect(existsSync(home.path(".codex", "auth.json"))).toBe(false);
});
