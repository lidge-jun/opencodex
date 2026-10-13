import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath } from "../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import * as mutationLock from "../../src/config/mutation-lock";
import { handleCodexAuthAPI } from "../../src/codex/auth-api";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getEffectiveActiveCodexAccountId,
} from "../../src/codex/routing";
import { bindThreadAffinity, getThreadAffinity } from "../../src/codex/routing/thread-affinity";
import { clearAllManualPreferences, manualPreferenceBlocks, rememberActiveCodexAccount } from "../../src/codex/routing/active-account";
import { codexPoolKeyForScope, getAccountHealth, scopedHealthFor, isIndependentCodexQuotaScope, NATIVE_MODEL_QUOTA_SCOPES, setAccountHealth, setScopedHealth } from "../../src/codex/routing/health-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { clearPoolRotationState, peekRoundRobinAccount } from "../../src/codex/pool-rotation";
import type { OcxConfig } from "../../src/types";

let TEST_DIR = "";
let TEST_CODEX_HOME = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

function seedPoolAccount(
  config: OcxConfig,
  account: { id: string; email: string; plan?: string },
): void {
  config.codexAccounts = [
    ...(config.codexAccounts ?? []),
    { id: account.id, email: account.email, plan: account.plan, isMain: false },
  ];
  saveCodexAccountCredential(account.id, {
    accessToken: `access-${account.id}`,
    refreshToken: `refresh-${account.id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${account.id}`,
  });
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-codex-auth-release-"));
  TEST_CODEX_HOME = join(TEST_DIR, "codex");
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAllManualPreferences();
});

afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearAllManualPreferences();
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const put = (body: unknown) =>
  new Request("http://localhost/api/codex-auth/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PUT /api/codex-auth/active release", () => {
  // The release is not a selection, so it may not plant the steering a selection
  // would: no one-shot manual preference, no rotation-ring seed toward the
  // `targetAccountId` fallback, no quota-avoidance overrule, and no clearing of the
  // affinity that keeps a bound thread on the account it captured. Anything less
  // leaves the "automatic" pick still steered to the app login — or rips threads
  // off their account — which is exactly what the operator was releasing away from.
  test("releasing the active account unwinds selection steering without breaking bindings", async () => {
    const config = makeConfig({ activeCodexAccountId: "work" });
    seedPoolAccount(config, { id: "work", email: "work@example.test" });
    seedPoolAccount(config, { id: "pool-x", email: "x@example.test" });

    const pin = put({ accountId: "work" });
    await handleCodexAuthAPI(pin, new URL(pin.url), config);

    // State a pinned pool legitimately carries when the release lands: a bound
    // thread, and a soft quota-avoidance on the app login the release has no
    // business overruling.
    bindThreadAffinity("release-thread", "work", Date.now());
    const avoidUntil = Date.now() + 60_000;
    setAccountHealth(MAIN_CODEX_ACCOUNT_ID, { consecutiveFailures: 0, quotaAvoidUntil: avoidUntil });
    const scopes = [...new Set(Object.values(NATIVE_MODEL_QUOTA_SCOPES))].filter(isIndependentCodexQuotaScope);
    for (const scope of scopes) setScopedHealth(MAIN_CODEX_ACCOUNT_ID, scope, { consecutiveFailures: 0, quotaAvoidUntil: avoidUntil });
    rememberActiveCodexAccount(config, "work");

    const clear = put({ accountId: null });
    const resp = await handleCodexAuthAPI(clear, new URL(clear.url), config);

    expect(resp!.status).toBe(200);
    // Nothing applied immediately, so nothing claimed to have cleared affinity.
    expect(await resp!.json()).toMatchObject({ appliesImmediately: false });
    expect(config.activeCodexAccountId).toBeUndefined();
    expect(config.activeCodexAccountPinned).toBeUndefined();
    expect(getEffectiveActiveCodexAccountId(config)).toBeUndefined();

    // Neither the released pick's own preference nor a fallback-made one may block
    // the next automatic pick, and the ring must offer no seeded account.
    expect(manualPreferenceBlocks("codex", "pool-x")).toBe(false);
    expect(peekRoundRobinAccount("codex", ["pool-x", MAIN_CODEX_ACCOUNT_ID], 1)).toBe("pool-x");
    // No account was named, so no soft avoid is overruled.
    expect(getAccountHealth(MAIN_CODEX_ACCOUNT_ID)?.quotaAvoidUntil).toBe(avoidUntil);
    for (const scope of scopes) {
      expect(peekRoundRobinAccount(codexPoolKeyForScope(scope), ["pool-x", MAIN_CODEX_ACCOUNT_ID], 1)).toBe("pool-x");
      expect(scopedHealthFor(MAIN_CODEX_ACCOUNT_ID, scope)?.quotaAvoidUntil).toBe(avoidUntil);
    }
    // A bound thread keeps its captured account.
    expect(getThreadAffinity("release-thread")?.accountId).toBe("work");
  });
});

async function pin(config: OcxConfig, id: string): Promise<void> {
  const request = put({ accountId: id });
  expect((await handleCodexAuthAPI(request, new URL(request.url), config))!.status).toBe(200);
}

function guardedPool(): OcxConfig {
  const config = makeConfig();
  seedPoolAccount(config, { id: "work", email: "work@example.test" });
  seedPoolAccount(config, { id: "pool-x", email: "x@example.test" });
  return config;
}

test("release refuses a pin replaced after the confirmation was opened", async () => {
  const config = guardedPool();
  await pin(config, "work");
  await pin(config, "pool-x");
  const before = readFileSync(getConfigPath(), "utf8");
  const request = put({ accountId: null, expectedPinnedAccountId: "work" });
  const response = (await handleCodexAuthAPI(request, new URL(request.url), config))!;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "account_pin_changed" });
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  expect(config.activeCodexAccountPinned).toBe("pool-x");
});

test("release rechecks the expected pin after a competing disk publication", async () => {
  const config = guardedPool();
  await pin(config, "work");
  let competing = "";
  setPersistedConfigMutationBeforeCommitForTests(() => {
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    competing = JSON.stringify({ ...raw, activeCodexAccountId: "pool-x", activeCodexAccountPinned: "pool-x" });
    writeFileSync(getConfigPath(), competing);
  });
  const request = put({ accountId: null, expectedPinnedAccountId: "work" });
  const response = (await handleCodexAuthAPI(request, new URL(request.url), config))!;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "account_pin_changed" });
  expect(readFileSync(getConfigPath(), "utf8")).toBe(competing);
  expect(config.activeCodexAccountPinned).toBe("work");
});

test("an unconfirmed release may already be present in published bytes", async () => {
  const config = guardedPool();
  await pin(config, "work");
  const path = getConfigPath();
  const published = path + ".publication-fixture";
  const fault = spyOn(mutationLock, "bumpGenerationForCooperatingConfigWrite").mockImplementation(() => {
    renameSync(path, published);
    mkdirSync(path);
    throw new Error("Injected post-publication confirmation failure");
  });
  try {
    const request = put({ accountId: null });
    const response = (await handleCodexAuthAPI(request, new URL(request.url), config))!;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "account_selection_unavailable" });
    expect(JSON.parse(readFileSync(published, "utf8")).activeCodexAccountPinned).toBeUndefined();
    expect(config.activeCodexAccountPinned).toBe("work");
  } finally { fault.mockRestore(); }
});

test.each(["work", MAIN_CODEX_ACCOUNT_ID])("guarded release accepts the matching %s pin", async id => {
  const config = guardedPool();
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-native-access", account_id: "fixture-native" } }));
  await pin(config, id);
  const request = put({ accountId: null, expectedPinnedAccountId: id });
  const response = (await handleCodexAuthAPI(request, new URL(request.url), config))!;
  expect(response.status).toBe(200);
  expect(config.activeCodexAccountPinned).toBeUndefined();
  expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).activeCodexAccountPinned).toBeUndefined();
});

test("transient guarded release checks its pin before initializing the baseline", async () => {
  const config = guardedPool();
  config.activeCodexAccountId = config.activeCodexAccountPinned = "work";
  const request = put({ accountId: null, expectedPinnedAccountId: "work" });
  expect((await handleCodexAuthAPI(request, new URL(request.url), config))!.status).toBe(200);
  expect(config.activeCodexAccountPinned).toBeUndefined();
});

test.each([
  { accountId: null, expectedPinnedAccountId: 42 },
  { accountId: null, expectedPinnedAccountId: "../invalid" },
  { accountId: "pool-x", expectedPinnedAccountId: "work" },
])("release validates its optional precondition: %j", async body => {
  const config = guardedPool();
  await pin(config, "work");
  const before = readFileSync(getConfigPath(), "utf8");
  const request = put(body);
  expect((await handleCodexAuthAPI(request, new URL(request.url), config))!.status).toBe(400);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
});
