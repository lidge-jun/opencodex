import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armClaudeCodeBaseline, deleteConfigTopLevelKey, getConfigPath, getDefaultConfig,
  loadConfig, saveConfig, saveConfigPreservingClaudeCode,
} from "../../src/config";
import { setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import * as atomicWrite from "../../src/config/atomic-write";
import * as derivedRegistries from "../../src/config/derived-registries";
import * as mutationLock from "../../src/config/mutation-lock";
import { handleCodexAuthAPI } from "../../src/codex/auth-api/routes";
import { materializeCodexUpstreamAuth, resolveCodexAuthContext } from "../../src/codex/auth-context";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { getCodexAccountCredential, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, getAccountQuota, updateAccountQuota } from "../../src/codex/quota";
import {
  clearCodexUpstreamHealth, clearThreadAccountMap, getEffectiveActiveCodexAccountId,
  resolveCodexAccountForThread,
} from "../../src/codex/routing";
import { rememberActiveCodexAccount } from "../../src/codex/routing/active-account";
import { bindThreadAffinity, getThreadAffinity } from "../../src/codex/routing/thread-affinity";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// These are deliberately old, flat credential records. Account order and display aliases must
// never become credential identity while an upgraded installation changes its active selection.
const ACCOUNT_A = "selection-old-a";
const ACCOUNT_B = "selection-old-b";
const MAIN = MAIN_CODEX_ACCOUNT_ID;
const IDS = [MAIN, ACCOUNT_A, ACCOUNT_B];
const url = new URL("http://127.0.0.1/api/codex-auth/active");
let home: string;
let previousOcxHome: string | undefined;
let previousCodexHome: string | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

function credential(id: string) {
  return {
    accessToken: `fixture-access-${id}`,
    refreshToken: `fixture-refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: `fixture-workspace-${id}`,
  };
}

function clearState(): void {
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearPoolRotationState();
  clearAccountQuota();
  for (const id of IDS) clearAccountNeedsReauth(id);
}

beforeEach(() => {
  previousOcxHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-selection-atomicity-"));
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.OPENCODEX_HOME);
  mkdirSync(process.env.CODEX_HOME);
  clearState();
  writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
    tokens: { access_token: credential(MAIN).accessToken, account_id: credential(MAIN).chatgptAccountId },
  }));
  writeFileSync(join(process.env.OPENCODEX_HOME, "codex-accounts.json"), JSON.stringify({
    [ACCOUNT_A]: credential(ACCOUNT_A), [ACCOUNT_B]: credential(ACCOUNT_B),
  }));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Account selection fixture must not contact a provider");
  });
});

afterEach(async () => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  const requests = fetchSpy.mock.calls.length;
  fetchSpy.mockRestore();
  clearState();
  await flushConfigDirHardeningForTests();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(home);
  expect(requests).toBe(0);
});

function seedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  saveConfig({
    port: 10100,
    defaultProvider: "test",
    providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key", allowPrivateNetwork: true } },
    codexAccounts: [
      { id: ACCOUNT_A, email: "selection-a@example.test", alias: "Old main", isMain: false },
      { id: ACCOUNT_B, email: "selection-b@example.test", alias: "Old backup", isMain: false },
    ],
    activeCodexAccountId: MAIN,
    activeCodexAccountPinned: MAIN,
    accountPoolStrategy: "quota",
    autoSwitchThreshold: 0,
    codexMainAccountHardLock: false,
    ...overrides,
  } as OcxConfig);
  const live = loadConfig();
  armClaudeCodeBaseline(live);
  return live;
}

function diskConfig(): OcxConfig {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
}

function changeDisk(patch: Partial<OcxConfig>): void {
  writeFileSync(getConfigPath(), JSON.stringify({ ...diskConfig(), ...patch }));
}

async function select(live: OcxConfig, accountId: string | null): Promise<Response> {
  const req = new Request(url, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }) });
  const response = await handleCodexAuthAPI(req, url, live);
  expect(response).not.toBeNull();
  return response!;
}

async function expectSelection(live: OcxConfig, accountId: string | null): Promise<void> {
  const response = await handleCodexAuthAPI(new Request(url), url, live);
  expect(await response!.json()).toMatchObject({
    activeCodexAccountId: accountId, pinnedAccountId: accountId,
  });
  expect(live.activeCodexAccountId).toBe(accountId ?? undefined);
  expect(live.activeCodexAccountPinned).toBe(accountId ?? undefined);
  expect(diskConfig().activeCodexAccountId).toBe(accountId ?? undefined);
  expect(diskConfig().activeCodexAccountPinned).toBe(accountId ?? undefined);
}

async function expectUpstreamIdentity(live: OcxConfig, accountId: string): Promise<void> {
  expect(resolveCodexAccountForThread(null, live)).toBe(accountId);
  const context = await resolveCodexAuthContext(new Headers(), live, "pool", {
    primeCodexPoolQuotas: async () => {},
  });
  const upstream = materializeCodexUpstreamAuth(new Headers(), context, { config: live });
  expect(upstream.get("authorization")).toBe(`Bearer ${credential(accountId).accessToken}`);
  expect(upstream.get("chatgpt-account-id")).toBe(credential(accountId).chatgptAccountId);
}

function captureRouting(live: OcxConfig) {
  rememberActiveCodexAccount(live, ACCOUNT_A);
  bindThreadAffinity("existing-selection-thread", ACCOUNT_A, Date.now());
  updateAccountQuota(ACCOUNT_A, 37);
  const configBefore = structuredClone(live);
  const affinityBefore = structuredClone(getThreadAffinity("existing-selection-thread"));
  const quotaBefore = structuredClone(getAccountQuota(ACCOUNT_A));
  return () => {
    expect(live).toEqual(configBefore);
    expect(getEffectiveActiveCodexAccountId(live)).toBe(ACCOUNT_A);
    expect(getThreadAffinity("existing-selection-thread")).toEqual(affinityBefore);
    expect(getAccountQuota(ACCOUNT_A)).toEqual(quotaBefore);
  };
}

describe("Codex active selection transaction", () => {
  test.each([MAIN, ACCOUNT_A])("same-value selection of %s overrides newer disk selection", async accountId => {
    const live = seedConfig({ activeCodexAccountId: accountId, activeCodexAccountPinned: accountId });
    const credentialsBefore = readFileSync(join(process.env.OPENCODEX_HOME!, "codex-accounts.json"), "utf8");
    changeDisk({ activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B });
    const response = await select(live, accountId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activeCodexAccountId: accountId, appliesImmediately: true });
    await expectSelection(live, accountId);
    expect(readFileSync(join(process.env.OPENCODEX_HOME!, "codex-accounts.json"), "utf8")).toBe(credentialsBefore);
    await expectUpstreamIdentity(live, accountId);
    // First materialization may attach quota-history metadata to a legacy record. It must
    // retain its credential and generation, rather than forbidding that intended upgrade.
    const legacy = JSON.parse(credentialsBefore);
    expect(getCodexAccountCredential(ACCOUNT_A)).toEqual(legacy[ACCOUNT_A]);
    expect(getCodexAccountCredential(ACCOUNT_B)).toEqual(legacy[ACCOUNT_B]);
    expect(readCodexAccountRecord(ACCOUNT_A)?.generation).toBe(0);
  });

  test("reselecting an initially unpinned main cannot leave a main pin on another active account", async () => {
    const live = seedConfig({ activeCodexAccountPinned: undefined });
    changeDisk({ activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B });
    expect((await select(live, MAIN)).status).toBe(200);
    await expectSelection(live, MAIN);
    await expectUpstreamIdentity(live, MAIN);
  });

  test("null clears newer disk selection when the baseline had no selection or pin", async () => {
    const live = seedConfig({ activeCodexAccountId: undefined, activeCodexAccountPinned: undefined });
    changeDisk({ activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B });
    expect((await select(live, null)).status).toBe(200);
    await expectSelection(live, null);
    // Clear means automatic selection; a subsequent route is free to choose an account.
    live.upstreamFailoverThreshold = 4;
    saveConfigPreservingClaudeCode(live);
    await expectSelection(live, null);
  });

  test("a scoped selection preserves newer row order, aliases, and unrelated durable settings", async () => {
    const live = seedConfig({ activeCodexAccountId: ACCOUNT_A, activeCodexAccountPinned: ACCOUNT_A });
    const rows = [...live.codexAccounts!].reverse().map(row => ({ ...row, alias: `Reordered ${row.id}` }));
    const credentialsBefore = readFileSync(join(process.env.OPENCODEX_HOME!, "codex-accounts.json"), "utf8");
    changeDisk({ codexAccounts: rows, activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B,
      port: 10102, showCodexCredits: true, claudeCode: { authMode: "proxy" } });
    expect((await select(live, ACCOUNT_A)).status).toBe(200);
    expect(diskConfig()).toMatchObject({ codexAccounts: rows, port: 10102, showCodexCredits: true,
      claudeCode: { authMode: "proxy" } });
    expect(live.port).toBe(10100);
    expect(readFileSync(join(process.env.OPENCODEX_HOME!, "codex-accounts.json"), "utf8")).toBe(credentialsBefore);
    await expectUpstreamIdentity(live, ACCOUNT_A);
    expect(getCodexAccountCredential(ACCOUNT_A)).toEqual(JSON.parse(credentialsBefore)[ACCOUNT_A]);
  });

  test("selection adoption advances only its baseline and preserves pending live edits", async () => {
    const live = seedConfig({ activeCodexAccountId: ACCOUNT_A, activeCodexAccountPinned: ACCOUNT_A });
    live.injectionPrompt = "Pending local fixture edit";
    expect((await select(live, MAIN)).status).toBe(200);
    expect(live.injectionPrompt).toBe("Pending local fixture edit");
    changeDisk({ activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B });
    live.upstreamFailoverThreshold = 4;
    saveConfigPreservingClaudeCode(live);
    expect(live.activeCodexAccountId).toBe(ACCOUNT_B);
    expect(live.activeCodexAccountPinned).toBe(ACCOUNT_B);
    expect(diskConfig().injectionPrompt).toBe("Pending local fixture edit");
  });

  test("a completed clear cannot erase a later selection or consume an unrelated pending deletion", async () => {
    const live = seedConfig({ injectionPrompt: "Old fixture prompt" });
    deleteConfigTopLevelKey(live, "injectionPrompt");
    expect((await select(live, null)).status).toBe(200);
    await expectSelection(live, null);
    // The scoped write does not publish a pending unrelated edit.
    expect(diskConfig().injectionPrompt).toBe("Old fixture prompt");
    expect(live.injectionPrompt).toBeUndefined();
    changeDisk({ activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B,
      injectionPrompt: "Newer disk fixture prompt" });
    live.upstreamFailoverThreshold = 4;
    saveConfigPreservingClaudeCode(live);
    await expectSelection(live, ACCOUNT_B);
    expect(diskConfig().injectionPrompt).toBeUndefined();
    expect(live.injectionPrompt).toBeUndefined();
  });

  for (const timing of ["before-request", "before-commit"] as const) {
    test.each(["deleted", "paused", "validation-pending"] as const)(
      `a target that becomes %s ${timing} is rejected without changing runtime routing`, async reason => {
        const live = seedConfig();
        const assertRoutingUnchanged = captureRouting(live);
        const invalidate = () => {
          if (reason === "deleted") changeDisk({ codexAccounts: live.codexAccounts!.filter(row => row.id !== ACCOUNT_B) });
          else if (reason === "paused") changeDisk({ pausedCodexAccountIds: [ACCOUNT_B] });
          else saveCodexAccountCredential(ACCOUNT_B, getCodexAccountCredential(ACCOUNT_B)!, { validationPending: true });
        };
        if (timing === "before-request") invalidate();
        else setPersistedConfigMutationBeforeCommitForTests(invalidate);
        const response = await select(live, ACCOUNT_B);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        assertRoutingUnchanged();
        expect(diskConfig().activeCodexAccountId).toBe(MAIN);
        expect(diskConfig().activeCodexAccountPinned).toBe(MAIN);
      },
    );
  }

  test.each(["missing", "invalid", "unreadable"] as const)(
    "a %s durable config fails closed without rebuilding it or changing runtime", async state => {
      const live = seedConfig();
      const assertRoutingUnchanged = captureRouting(live);
      if (state === "invalid") writeFileSync(getConfigPath(), "{invalid-fixture");
      else {
        unlinkSync(getConfigPath());
        if (state === "unreadable") mkdirSync(getConfigPath());
      }
      let rejected = false;
      try { rejected = !(await select(live, ACCOUNT_B)).ok; } catch { rejected = true; }
      expect(rejected).toBe(true);
      assertRoutingUnchanged();
      if (state === "missing") expect(existsSync(getConfigPath())).toBe(false);
      if (state === "invalid") expect(readFileSync(getConfigPath(), "utf8")).toBe("{invalid-fixture");
    },
  );

  test.each(["atomic-write", "derived-registry", "generation-bump"] as const)(
    "a %s failure respects the durable publication boundary", async phase => {
      const live = seedConfig();
      changeDisk({ activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B });
      const before = readFileSync(getConfigPath(), "utf8");
      const assertRoutingUnchanged = captureRouting(live);
      const fail = () => { throw new Error("Injected account-selection persistence failure"); };
      const fault = phase === "atomic-write"
        ? spyOn(atomicWrite, "atomicWriteFile").mockImplementation(fail)
        : phase === "derived-registry"
          ? spyOn(derivedRegistries, "refreshConfigDerivedRegistries").mockImplementation(fail)
          : spyOn(mutationLock, "bumpGenerationForCooperatingConfigWrite").mockImplementation(fail);
      let response: Response;
      try {
        response = await select(live, MAIN);
        expect(fault.mock.calls.length).toBeGreaterThan(0);
      } finally {
        fault.mockRestore();
      }
      if (phase === "atomic-write") {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "account_selection_unavailable" });
        expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
        assertRoutingUnchanged();
      } else {
        // Publication already succeeded. Reverting only live state would send the next turn
        // to a different account than the committed selection until the process restarted.
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ activeCodexAccountId: MAIN,
          warning: "config_bookkeeping_failed", appliesImmediately: true });
        await expectSelection(live, MAIN);
        expect(getThreadAffinity("existing-selection-thread")).toBeUndefined();
        expect(getEffectiveActiveCodexAccountId(live)).toBe(MAIN);
        await expectUpstreamIdentity(live, MAIN);
      }
    },
  );

  test.each([MAIN, ACCOUNT_A])("unchanged selection of %s remains a successful no-op on disk", async accountId => {
    const live = seedConfig({ activeCodexAccountId: accountId, activeCodexAccountPinned: accountId });
    bindThreadAffinity("existing-selection-thread", ACCOUNT_B, Date.now());
    const before = readFileSync(getConfigPath(), "utf8");
    expect((await select(live, accountId)).status).toBe(200);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(getThreadAffinity("existing-selection-thread")).toBeUndefined();
    await expectSelection(live, accountId);
    await expectUpstreamIdentity(live, accountId);
  });

  test("a newly selected value with no competing writer still reaches its credential", async () => {
    const live = seedConfig({ activeCodexAccountId: ACCOUNT_A, activeCodexAccountPinned: ACCOUNT_A });
    expect((await select(live, ACCOUNT_B)).status).toBe(200);
    await expectSelection(live, ACCOUNT_B);
    await expectUpstreamIdentity(live, ACCOUNT_B);
  });

  test("an unpersisted initial config can still create and select an account", async () => {
    const live = getDefaultConfig();
    live.codexAccounts = [{ id: ACCOUNT_A, email: "selection-a@example.test", isMain: false }];
    live.autoSwitchThreshold = 0;
    live.codexMainAccountHardLock = false;
    expect(existsSync(getConfigPath())).toBe(false);
    expect((await select(live, ACCOUNT_A)).status).toBe(200);
    await expectSelection(live, ACCOUNT_A);
    await expectUpstreamIdentity(live, ACCOUNT_A);
  });

  test("an unpersisted initial config adopts its published selection when bookkeeping fails", async () => {
    const live = getDefaultConfig();
    live.codexAccounts = [{ id: ACCOUNT_A, email: "selection-a@example.test", isMain: false }];
    live.autoSwitchThreshold = 0;
    live.codexMainAccountHardLock = false;
    expect(existsSync(getConfigPath())).toBe(false);
    const fault = spyOn(mutationLock, "bumpGenerationForCooperatingConfigWrite").mockImplementation(() => {
      throw new Error("Injected initializer bookkeeping failure");
    });
    let response: Response;
    try {
      response = await select(live, ACCOUNT_A);
      expect(fault.mock.calls.length).toBeGreaterThan(0);
    } finally {
      fault.mockRestore();
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activeCodexAccountId: ACCOUNT_A,
      warning: "config_bookkeeping_failed", appliesImmediately: true });
    await expectSelection(live, ACCOUNT_A);
    await expectUpstreamIdentity(live, ACCOUNT_A);
  });

  test("an initially transient config cannot recreate its durable file after a successful selection", async () => {
    const live = getDefaultConfig();
    live.codexAccounts = [ACCOUNT_A, ACCOUNT_B].map(id => ({ id, email: `${id}@example.test`, isMain: false }));
    live.autoSwitchThreshold = 0;
    live.codexMainAccountHardLock = false;
    expect((await select(live, ACCOUNT_A)).status).toBe(200);
    const assertRoutingUnchanged = captureRouting(live);
    unlinkSync(getConfigPath());
    expect((await select(live, ACCOUNT_B)).ok).toBe(false);
    expect(existsSync(getConfigPath())).toBe(false);
    assertRoutingUnchanged();
  });

  test("a live config from another home cannot mutate the current home's selection", async () => {
    const live = seedConfig();
    const assertRoutingUnchanged = captureRouting(live);
    const originalHome = process.env.OPENCODEX_HOME!;
    const originalPath = getConfigPath();
    const originalBytes = readFileSync(originalPath, "utf8");
    const otherHome = join(home, "other-ocx");
    mkdirSync(otherHome);
    try {
      process.env.OPENCODEX_HOME = otherHome;
      const otherBytes = JSON.stringify({ ...JSON.parse(originalBytes),
        activeCodexAccountId: ACCOUNT_B, activeCodexAccountPinned: ACCOUNT_B });
      writeFileSync(getConfigPath(), otherBytes);
      expect((await select(live, MAIN)).ok).toBe(false);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(otherBytes);
      expect(readFileSync(originalPath, "utf8")).toBe(originalBytes);
    } finally {
      process.env.OPENCODEX_HOME = originalHome;
    }
    assertRoutingUnchanged();
  });

  test.each([
    { label: "null", body: null }, { label: "array", body: [] }, { label: "missing accountId", body: {} },
    { label: "boolean accountId", body: { accountId: false } }, { label: "numeric accountId", body: { accountId: 0 } },
  ])(
    "malformed selection body $label cannot clear routing", async ({ body }) => {
      const live = seedConfig();
      const assertRoutingUnchanged = captureRouting(live);
      const before = readFileSync(getConfigPath(), "utf8");
      const req = new Request(url, { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(body) });
      const response = await handleCodexAuthAPI(req, url, live);
      expect(response?.status).toBe(400);
      assertRoutingUnchanged();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    },
  );
});
