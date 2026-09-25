import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import {
  MAIN_ACCOUNT_HARD_LOCK_PERCENT,
  getMainAccountHardLockStatus,
  isMainAccountHardLockEnabled,
  isMainAccountHardLocked,
} from "../../src/codex/main-account-hard-lock";
import {
  captureMainQuotaWriter,
  clearMainAccountInfoCache,
  observeMainQuotaIdentity,
} from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { codexAccountUnusableReason, isCodexAccountUsable } from "../../src/codex/account-usability";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACCOUNT = "hard-lock-default-fixture";
let home: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;

const config = (): OcxConfig => ({
  port: 10100,
  defaultProvider: "example",
  providers: { example: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "fixture" } },
});

function request(cfg: OcxConfig, body?: unknown) {
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleManagementAPI(req, new URL(req.url), cfg, {
    getCachedStartupHealth: async () => startupHealthFixture(),
  } satisfies Partial<ManagementApiDeps>);
}

function observe(quota: { weeklyPercent?: number; shortPercent?: number }): void {
  const writer = captureMainQuotaWriter(ACCOUNT);
  if (!writer) throw new Error("fixture identity was not observed");
  setAccountQuotaFromParsed("__main__", quota, undefined, writer);
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-hard-lock-default-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  invalidateStartupHealthCache();
  clearAccountQuota();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity(ACCOUNT);
});

afterEach(() => {
  invalidateStartupHealthCache();
  clearAccountQuota();
  clearMainAccountInfoCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
});

describe("main-account hard lock default (#5694)", () => {
  test("the threshold is 98 percent", () => {
    expect(MAIN_ACCOUNT_HARD_LOCK_PERCENT).toBe(98);
  });

  test("an absent key or true enables the policy; only false opts out", () => {
    expect(isMainAccountHardLockEnabled({})).toBe(true);
    expect(isMainAccountHardLockEnabled({ codexMainAccountHardLock: undefined })).toBe(true);
    expect(isMainAccountHardLockEnabled({ codexMainAccountHardLock: true })).toBe(true);
    expect(isMainAccountHardLockEnabled({ codexMainAccountHardLock: false })).toBe(false);
    // Absent is not "no signal" for the status reader either: it reports the default as on.
    expect(getMainAccountHardLockStatus({})).toEqual({ enabled: true, state: "unknown" });
  });

  test("a malformed hand edit parses to the default instead of disabling the policy", () => {
    const parsed = configSchema.parse({
      ...config(),
      codexMainAccountHardLock: "yes",
    }) as OcxConfig;
    expect(parsed.codexMainAccountHardLock).toBeUndefined();
    expect(isMainAccountHardLockEnabled(parsed)).toBe(true);
    // A well-formed false still survives the same parse.
    expect(isMainAccountHardLockEnabled(
      configSchema.parse({ ...config(), codexMainAccountHardLock: false }) as OcxConfig,
    )).toBe(false);
  });

  test("97.9 percent is ready and 98 percent is blocked without any key present", () => {
    observe({ weeklyPercent: 97.9 });
    expect(getMainAccountHardLockStatus({}).state).toBe("ready");
    observe({ shortPercent: 98 });
    expect(getMainAccountHardLockStatus({})).toEqual({ enabled: true, state: "blocked" });
    expect(isMainAccountHardLocked({})).toBe(true);
    // The opt-out keeps the same observation admissible.
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: false }))
      .toEqual({ enabled: false, state: "off" });
  });

  test("GET reports the lock as on when no key is stored", async () => {
    observe({ weeklyPercent: 98 });
    const response = await request(config());
    expect(await response!.json()).toMatchObject({
      codexMainAccountHardLock: true,
      mainAccountHardLock: { enabled: true, state: "blocked" },
    });
  });

  test("an absent key withholds the main account from admission", () => {
    observe({ weeklyPercent: 98 });
    expect(codexAccountUnusableReason(config(), MAIN_CODEX_ACCOUNT_ID, { nativeMainSelectionOnly: true }))
      .toBe("main_hard_locked");
    expect(isCodexAccountUsable(config(), MAIN_CODEX_ACCOUNT_ID, { nativeMainSelectionOnly: true })).toBe(false);
    const optedOut = { ...config(), codexMainAccountHardLock: false };
    expect(codexAccountUnusableReason(optedOut, MAIN_CODEX_ACCOUNT_ID, { nativeMainSelectionOnly: true }))
      .toBeUndefined();
    expect(isCodexAccountUsable(optedOut, MAIN_CODEX_ACCOUNT_ID, { nativeMainSelectionOnly: true })).toBe(true);
  });

  test("PUT false persists the opt-out and PUT true restores the default", async () => {
    const cfg = config();
    saveConfig(cfg);
    const disabled = await request(cfg, { codexMainAccountHardLock: false });
    expect(await disabled!.json()).toMatchObject({ ok: true, codexMainAccountHardLock: false });
    expect(cfg.codexMainAccountHardLock).toBe(false);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).codexMainAccountHardLock).toBe(false);
    expect(loadConfig().codexMainAccountHardLock).toBe(false);
    expect(isMainAccountHardLockEnabled(loadConfig())).toBe(false);

    const enabled = await request(cfg, { codexMainAccountHardLock: true });
    expect(await enabled!.json()).toMatchObject({ ok: true, codexMainAccountHardLock: true });
    expect(Object.hasOwn(cfg, "codexMainAccountHardLock")).toBe(false);
    // On is the default, so it is stored as absence: a written key would be a decision nobody made.
    expect(Object.hasOwn(JSON.parse(readFileSync(getConfigPath(), "utf8")), "codexMainAccountHardLock")).toBe(false);
    expect(loadConfig().codexMainAccountHardLock).toBeUndefined();
    expect(isMainAccountHardLockEnabled(loadConfig())).toBe(true);
  });
});
