import { afterEach, beforeEach, expect, test } from "bun:test";
import { getDefaultConfig, loadConfig } from "../../src/config";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { pinnedCodexAccountId, setCodexAccountPin } from "../../src/codex/account-priority";
import { createTempHome } from "../helpers/temp-home";

let home: ReturnType<typeof createTempHome>;
beforeEach(() => { home = createTempHome("ocx-clear-paused-account-"); });
afterEach(() => { home.remove(); });

const url = new URL("http://127.0.0.1/api/codex-auth/active");
function request(accountId: string | null): Request {
  return new Request(url, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }) });
}

test("null clears active selection and pin even when the main account is paused", async () => {
  const config = getDefaultConfig();
  config.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
  config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
  setCodexAccountPin(config, MAIN_CODEX_ACCOUNT_ID);
  const response = await handleCodexAuthAPI(request(null), url, config);
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({ ok: true, activeCodexAccountId: null });
  expect(config.activeCodexAccountId).toBeUndefined();
  expect(pinnedCodexAccountId(config)).toBeUndefined();
  const stored = loadConfig();
  expect(stored.activeCodexAccountId).toBeUndefined();
  expect(pinnedCodexAccountId(stored)).toBeUndefined();
  expect(stored.pausedCodexAccountIds).toContain(MAIN_CODEX_ACCOUNT_ID);
});

test("clearing with paused main is idempotent and does not select it", async () => {
  const config = getDefaultConfig();
  config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
  for (let i = 0; i < 2; i++) {
    const response = await handleCodexAuthAPI(request(null), url, config);
    expect(response?.status).toBe(200);
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(pinnedCodexAccountId(config)).toBeUndefined();
  }
});

test("an explicit paused main selection still fails without clearing an existing pin", async () => {
  const config = getDefaultConfig();
  config.activeCodexAccountId = "pool-fixture";
  config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
  setCodexAccountPin(config, "pool-fixture");
  const response = await handleCodexAuthAPI(request(MAIN_CODEX_ACCOUNT_ID), url, config);
  expect(response?.status).toBe(409);
  expect(await response!.json()).toEqual({ error: "Account is paused" });
  expect(config.activeCodexAccountId).toBe("pool-fixture");
  expect(pinnedCodexAccountId(config)).toBe("pool-fixture");
});
