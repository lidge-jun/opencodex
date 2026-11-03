import { capturePoolQuotaWriter, saveCodexAccountCredential, saveCodexAccountCredentialIfGeneration } from "../../src/codex/account-store";
import { getAccountQuotaHistory, isValidWhamHistoryObservation, settleQuotaPersistenceForTests } from "../../src/codex/quota";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN_CODEX_ACCOUNT_ID as MAIN } from "../../src/codex/account-id";
import { isCodexAccountHeldForCredits } from "../../src/codex/account-credit-use";
import { hasSpendableCodexCredits } from "../../src/codex/quota-types";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import {
  applyConfirmedMainCodexAccountTransition,
  reconcileMainCodexAccountRuntimeState,
  resetMainCodexAccountIdentityTrackingForTests,
} from "../../src/codex/account-lifecycle";
import * as authCollision from "../../src/codex/auth-collision";
import {
  captureMainQuotaWriter,
  clearMainAccountInfoCache,
  getObservedMainQuotaIdentityKey,
  isMainQuotaWriterLive,
  matchesMainQuotaCredential,
  observeMainQuotaCredential,
  observeMainQuotaIdentity,
  type MainQuotaWriter,
} from "../../src/codex/main-account-cache";
import {
  applyAccountQuotaFromUpstreamHeaders,
  clearAccountQuota,
  getAccountQuota,
  getMainPolicyQuota,
  listAccountQuotas,
  parseMainPolicyUsageQuota,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  updateAccountQuota,
  type StoredAccountQuota,
  type WhamUsageResponse,
} from "../../src/codex/quota";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmModuleGraph } from "../helpers/cold-spawn-warmup";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

const QUOTA_PROVENANCE_IMPORT_PROLOGUE = `
        import { getAccountQuota, getMainPolicyQuota } from ${JSON.stringify(repoPath("src/codex/quota.ts"))};
        import { observeMainQuotaIdentity, matchesMainQuotaCredential } from ${JSON.stringify(repoPath("src/codex/main-account-cache.ts"))};
`;
const KEYRING_QUOTA_RESTART_IMPORTS = `${QUOTA_PROVENANCE_IMPORT_PROLOGUE}
        import { resolveCodexAuthContext } from ${JSON.stringify(repoPath("src/codex/auth-context.ts"))};
        import { initializeMainAccountPolicyBinding } from ${JSON.stringify(repoPath("src/codex/account-lifecycle.ts"))};
        import { setNativeMainRefreshResolutionForTests } from ${JSON.stringify(repoPath("src/codex/native-main-refresh-mode.ts"))};
`;

let testDir: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let pendingPersist: { run: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
let timerSpy: ReturnType<typeof installPersistenceClock>;

/**
 * Capture quota's 250ms persistence callback for explicit flushing; leave other timers native.
 * Return the timer spy so teardown restores scheduling after exercising the real serializer.
 */
function installPersistenceClock() {
  const nativeSetTimeout = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
  ) => {
    if (delay !== 250) return nativeSetTimeout(callback, delay, ...args);
    const timer = nativeSetTimeout(() => {}, 60_000);
    pendingPersist = { run: () => callback(...args), timer };
    return timer;
  }) as typeof setTimeout);
}

/** Run the captured quota persistence callback and read its actual disk snapshot without a sleep. */
async function flushPersistence(): Promise<string> {
  if (!pendingPersist) throw new Error("Expected a scheduled quota persistence");
  const pending = pendingPersist;
  pendingPersist = undefined;
  clearTimeout(pending.timer);
  pending.run();
  // The callback admits its write after any overlapping config-root ACL flight (#7815).
  await settleQuotaPersistenceForTests();
  return readFileSync(join(testDir, "codex-quota-cache.json"), "utf8");
}

/** Bind a synthetic main identity and return its current generation-scoped quota writer. */
function writerFor(accountId = "fixture-main-a"): MainQuotaWriter {
  observeMainQuotaIdentity(accountId);
  const writer = captureMainQuotaWriter(accountId);
  if (!writer) throw new Error("Expected an observed main quota writer");
  return writer;
}

function writeSnapshot(value: unknown): void {
  writeFileSync(join(testDir, "codex-quota-cache.json"), JSON.stringify(value));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-main-provenance-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  clearAccountQuota();
  resetMainCodexAccountIdentityTrackingForTests();
  clearMainAccountInfoCache();
  observeMainQuotaIdentity("fixture-unobserved-for-this-test");
  pendingPersist = undefined;
  timerSpy = installPersistenceClock();
});

afterEach(() => {
  if (pendingPersist) clearTimeout(pendingPersist.timer);
  pendingPersist = undefined;
  clearAccountQuota();
  clearMainAccountInfoCache();
  timerSpy.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
});

describe("main quota credential provenance", () => {
  test("credential observation cannot establish or switch physical identity", () => {
    const writer = writerFor();
    expect(observeMainQuotaCredential("fixture-bearer-b", "fixture-main-b")).toBeUndefined();
    expect(captureMainQuotaWriter("fixture-main-b")).toBeUndefined();
    expect(getObservedMainQuotaIdentityKey()).toBe(writer.identityKey);
    expect(observeMainQuotaCredential("", "fixture-main-a")).toBeUndefined();
  });

  test("credential equality requires exact bearer, effective workspace, and live generation", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-bearer-a", "fixture-main-a");
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(true);
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-b")).toBe(false);
    expect(matchesMainQuotaCredential("fixture-bearer-b", "fixture-main-a")).toBe(false);
    expect(matchesMainQuotaCredential("fixture-bearer-a", undefined)).toBe(false);
    observeMainQuotaIdentity("fixture-main-a");
    expect(isMainQuotaWriterLive(writer)).toBe(true);
    clearMainAccountInfoCache();
    expect(isMainQuotaWriterLive(writer)).toBe(false);
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(false);
    expect(getObservedMainQuotaIdentityKey()).toBe(writer.identityKey);
  });

  test("replacement owned token supersedes equality without changing account quota ownership", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-old-token", "fixture-main-a");
    observeMainQuotaCredential("fixture-new-token", "fixture-main-a");
    expect(matchesMainQuotaCredential("fixture-old-token", "fixture-main-a")).toBe(false);
    expect(matchesMainQuotaCredential("fixture-new-token", "fixture-main-a")).toBe(true);
    expect(isMainQuotaWriterLive(writer)).toBe(true);
  });

  test("policy lookup and equality matching never read physical auth", () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-bearer-a", "fixture-main-a");
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    const physicalRead = spyOn(authCollision, "readCodexTokensResult").mockImplementation(() => {
      throw new Error("Physical auth read forbidden");
    });
    try {
      expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(true);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(physicalRead).not.toHaveBeenCalled();
    } finally {
      physicalRead.mockRestore();
    }
  });
});

describe("main policy quota writes", () => {
  test("legacy data remains public but cannot be blessed by a tagged credits-only write", () => {
    const writer = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99, shortPercent: 100, resetCredits: 8 });
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 2 }, undefined, writer);
    expect(getMainPolicyQuota()).toEqual({ resetCredits: 2, updatedAt: expect.any(Number) });
    expect(getAccountQuota(MAIN)).toMatchObject({ weeklyPercent: 99, shortPercent: 100, resetCredits: 2 });
  });

  test("different identity cannot inherit old windows and ABA writers are rejected", () => {
    const oldA = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99, monthlyPercent: 100 }, undefined, oldA);
    const writerB = writerFor("fixture-main-b");
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 1 }, undefined, writerB);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    const newA = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 10 }, undefined, newA);
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100 }, undefined, oldA);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(10);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(10);
    expect(isMainQuotaWriterLive(oldA)).toBe(false);
  });

  test("shared merger preserves partial fields, explicit zero, and monthly-only weekly clearing", () => {
    const writer = writerFor();
    setAccountQuotaFromParsed(MAIN, {
      weeklyPercent: 99, shortPercent: 98, shortWindowSeconds: 18_000, resetCredits: 4,
    }, undefined, writer);
    setAccountQuotaFromParsed(MAIN, { resetCredits: 0 }, undefined, writer);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99, shortPercent: 98, resetCredits: 0 });
    setAccountQuotaFromParsed(MAIN, { monthlyPercent: 15, monthlyIsPrimaryWindow: true }, undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    expect(getMainPolicyQuota()).toMatchObject({ monthlyPercent: 15, monthlyIsPrimaryWindow: true, shortPercent: 98 });
    expect(getAccountQuota(MAIN)).toEqual(getMainPolicyQuota());
  });

  test("tertiary-only monthly headers preserve weekly99 policy; monthly-primary can replace it", () => {
    const writer = writerFor();
    const enabled = { codexMainAccountHardLock: true };
    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "99",
      "x-codex-primary-window-minutes": "10080",
    }), undefined, writer);
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");

    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-tertiary-used-percent": "5",
    }), undefined, writer);
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(MAIN)?.monthlyPercent).toBe(5);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99 });
    expect(getMainPolicyQuota()?.monthlyPercent).toBeUndefined();
    expect(getMainPolicyQuota()?.monthlyIsPrimaryWindow).toBeUndefined();
    expect(getMainAccountHardLockStatus(enabled).state).toBe("blocked");

    applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({
      "x-codex-primary-used-percent": "6",
      "x-codex-primary-window-minutes": "43200",
    }), undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    expect(getMainPolicyQuota()).toMatchObject({ monthlyPercent: 6, monthlyIsPrimaryWindow: true });
    expect(getMainAccountHardLockStatus(enabled).state).toBe("ready");
  });

  for (const plan of ["go", "free"]) {
    for (const [weekly, monthly, state] of [[98, 99, "blocked"], [99, 20, "ready"]] as const) {
      test(`${plan} monthly-primary ${monthly} replaces same-owner weekly ${weekly}`, () => {
        const writer = writerFor();
        setAccountQuotaFromParsed(MAIN, parseUsageQuota({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: weekly, limit_window_seconds: 604_800 } },
        }), undefined, writer);
        expect(getMainPolicyQuota()?.weeklyPercent).toBe(weekly);
        const monthlyQuota = parseUsageQuota({
          plan_type: plan,
          rate_limit: { primary_window: { used_percent: monthly, limit_window_seconds: 2_592_000 } },
        });
        expect(monthlyQuota).toEqual({ monthlyPercent: monthly, monthlyIsPrimaryWindow: true });
        setAccountQuotaFromParsed(MAIN, monthlyQuota, undefined, writer);
        expect(getMainPolicyQuota()).toEqual({
          monthlyPercent: monthly, monthlyIsPrimaryWindow: true, updatedAt: expect.any(Number),
        });
        expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe(state);
      });
    }

    test(`${plan} supplementary monthly is not a monthly-primary replacement`, () => {
      const writer = writerFor();
      setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
      const monthlyQuota = parseUsageQuota({ plan_type: plan, rate_limit: {
        primary_window: { limit_window_seconds: 2_592_000 },
        tertiary_window: { used_percent: 20 },
      } });
      expect(monthlyQuota).toEqual({ monthlyPercent: 20 });
      setAccountQuotaFromParsed(MAIN, monthlyQuota, undefined, writer);
      expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
      expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    });
  }

  test("header writer carries provenance and untagged main writes invalidate it", async () => {
    const writer = writerFor();
    const headers = new Headers({ "x-codex-primary-used-percent": "99" });
    applyAccountQuotaFromUpstreamHeaders(MAIN, headers, undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    setAccountQuotaFromParsed("fixture-pool", { weeklyPercent: 7 });
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    applyAccountQuotaFromUpstreamHeaders(MAIN, headers);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    updateAccountQuota(MAIN, 20);
    expect(getMainPolicyQuota()).toBeNull();
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(20);
    expect(JSON.parse(await flushPersistence()).mainPolicyQuota).toBeUndefined();
  });

  test("public quota mutation and serializers cannot expose or mutate policy provenance", async () => {
    const writer = writerFor();
    observeMainQuotaCredential("fixture-private-bearer", "fixture-main-a");
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    getAccountQuota(MAIN)!.weeklyPercent = 0;
    getMainPolicyQuota()!.weeklyPercent = 0;
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    const publicJson = JSON.stringify(Object.fromEntries(listAccountQuotas()));
    expect(publicJson).not.toContain("identityKey");
    const disk = await flushPersistence();
    expect(disk).not.toContain("fixture-private-bearer");
    expect(disk).not.toContain("fixture-main-a");
    expect(disk).not.toContain("bearerHmac");
    expect(disk).not.toContain("identityGeneration");
    expect(Object.keys(JSON.parse(disk).mainPolicyQuota).sort()).toEqual(["identityKey", "quota"]);
  });
});

test("window replacement persists without carrying its proof into later partial updates", async () => {
  const cfg = { codexMainAccountHardLock: true };
  const writer = writerFor();
  /** Publish both parsed projections with the captured writer throughout the simulated restart. */
  const publish = (data: WhamUsageResponse) => setAccountQuotaFromParsed(
    MAIN, parseUsageQuota(data), undefined, writer, parseMainPolicyUsageQuota(data),
  );
  setAccountQuotaFromParsed(MAIN, { shortPercent: 100, shortWindowSeconds: 18_000,
    shortResetAt: Date.now() / 1000 + 3_600 }, undefined, writer);
  expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  publish({ rate_limit: {
    allowed: true, primary_window: { used_percent: 35, limit_window_seconds: 604_800 }, secondary_window: null,
  } });
  // Execute quota's actual debounced serializer through the existing deterministic clock.
  const persisted = await flushPersistence();
  expect(JSON.parse(persisted).mainPolicyQuota.quota.weeklyPercent).toBe(35);
  expect(persisted).not.toContain("shortWindowAbsent");
  clearAccountQuota();
  writeFileSync(join(testDir, "codex-quota-cache.json"), persisted);
  expect(getMainAccountHardLockStatus(cfg).state).toBe("ready");
  expect(getMainPolicyQuota()?.shortPercent).toBeUndefined();
  expect(getAccountQuota(MAIN)?.shortPercent).toBeUndefined();
  publish({ rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18_000 } } });
  publish({ rate_limit: { primary_window: { used_percent: 0 } } });
  expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
});

describe("main policy quota durability and lifecycle", () => {
  // The first loop iteration is this graph's cold child; warm quota provenance imports before its
  // spawn timeout starts measuring the restart behavior.
  beforeAll(async () => {
    await warmModuleGraph({
      graph: "codex/quota-provenance-eval",
      source: QUOTA_PROVENANCE_IMPORT_PROLOGUE,
      cwd: repoRoot(),
    });
    await warmModuleGraph({ graph: "codex/keyring-quota-restart-eval", source: KEYRING_QUOTA_RESTART_IMPORTS, cwd: repoRoot() });
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  for (const scenario of [
    { name: "verified replacement", account: "fixture-main-b", tag: "known", selected: true },
    { name: "same account", account: "fixture-main-a", tag: "known", selected: false, refusal: "CodexMainAccountHardLockError" },
    { name: "untagged quota", account: "fixture-main-b", tag: "missing", selected: false, refusal: "CodexPoolAuthenticationError" },
    { name: "invalid quota tag", account: "fixture-main-b", tag: "invalid", selected: false, refusal: "CodexPoolAuthenticationError" },
    { name: "unknown RPC identity", account: "", tag: "known", selected: false, refusal: "CodexPoolAuthenticationError" },
    { name: "manually paused", account: "fixture-main-b", tag: "known", selected: false, paused: true, refusal: "CodexPoolAuthenticationError" },
    { name: "startup file replacement", account: "fixture-main-b", tag: "known", selected: true, source: "file" },
    { name: "startup same-account file", account: "fixture-main-a", tag: "known", selected: false, source: "file", refusal: "CodexMainAccountHardLockError" },
  ]) {
    test(`cold keyring Pool preserves quota unless replacement is proven: ${scenario.name}`, async () => {
      const writer = writerFor("fixture-main-a");
      setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100, weeklyResetAt: Date.now() / 1000 + 3600 }, undefined, writer);
      setAccountQuotaFromParsed("fixture-stored", { weeklyPercent: 33 });
      const snapshot = JSON.parse(await flushPersistence());
      if (scenario.tag === "missing") delete snapshot.mainPolicyQuota;
      if (scenario.tag === "invalid") snapshot.mainPolicyQuota.identityKey = "invalid-fixture-identity";
      writeSnapshot(snapshot);
      const script = `
        ${KEYRING_QUOTA_RESTART_IMPORTS}
        globalThis.fetch = async () => { throw new Error("unexpected fixture network request"); };
        setNativeMainRefreshResolutionForTests({ mode: "codex", configured: "auto", reason: "codex-compatible", command: "/fixture/codex", version: "0.162.1" });
        const before = getAccountQuota("__main__");
        const account = ${JSON.stringify(scenario.account)};
        const token = account ? "header." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
          "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url") + ".fixture" : "opaque-fixture-token";
        const fileOwned = ${JSON.stringify(scenario.source === "file")};
        let initialized;
        if (fileOwned) {
          const authPath = process.env.CODEX_HOME + "/auth.json";
          await Bun.write(authPath, JSON.stringify({ tokens: { access_token: token, account_id: account } }));
          initialized = initializeMainAccountPolicyBinding(authPath);
        }
        let reads = 0;
        const config = { port: 10100, defaultProvider: "openai", codexAccounts: [], codexMainAccountHardLock: true,
          pausedCodexAccountIds: ${JSON.stringify(scenario.paused ? [MAIN] : [])},
          providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } } };
        let selected = false;
        let failure, failureDetail;
        try {
          const result = await resolveCodexAuthContext(new Headers(), config, "pool", {
            nativeMainRefreshDependencies: { codexAuthStatus: async () => { reads++; return { authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true }; } },
            primeCodexPoolQuotas: async () => {},
            beginCodexAccountSelection: () => ({ mainProfileDraining: false, claimMainProfile: () => true, release() {} }),
          });
          selected = result.kind === "main-pool" && result.chatgptAccountId === account;
        } catch (error) {
          failure = error.name;
          failureDetail = { message: String(error.message).slice(0, 200), cause: error.cause?.name, code: error.cause?.code ?? error.code };
        }
        console.log(JSON.stringify({ fixture: "cold-keyring-quota", before, selected, failure, failureDetail, reads, initialized,
          legacy: getAccountQuota("__main__"), policy: getMainPolicyQuota(), stored: getAccountQuota("fixture-stored"),
          paused: config.pausedCodexAccountIds }));
      `;
      const child = Bun.spawnSync({ cmd: [process.execPath, "--eval", script], cwd: repoRoot(), env: process.env,
        timeout: process.platform === "win32" ? SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS : 10_000 });
      expect(child.exitCode).toBe(0);
      const line = child.stdout.toString().split("\n").find(row => row.startsWith('{"fixture":"cold-keyring-quota"'));
      expect(line).toBeDefined();
      const result = JSON.parse(line!);
      expect(result.before.weeklyPercent).toBe(100);
      expect(result.selected).toBe(scenario.selected);
      expect(result.stored.weeklyPercent).toBe(33);
      expect(result.paused).toEqual(scenario.paused ? [MAIN] : []);
      if (scenario.source === "file") expect(result.initialized).toBe(true);
      if (scenario.selected) {
        expect(result.reads).toBe(scenario.source === "file" ? 0 : 2);
        expect(result.legacy).toBeNull();
        expect(result.policy).toBeNull();
      } else {
        // The refusal must be the policy decision itself; any earlier setup failure (with no read)
        // fails here with its message and cause instead of passing as a refusal.
        expect({ failure: result.failure, reads: result.reads, detail: result.failureDetail }).toMatchObject({
          failure: scenario.refusal, reads: scenario.paused || scenario.source === "file" ? 0 : 1,
        });
        expect(result.legacy.weeklyPercent).toBe(100);
        if (scenario.account === "fixture-main-a") expect(result.policy.weeklyPercent).toBe(100);
      }
    }, SPAWN_BUDGET_MS);
  }

  for (const unavailable of [true, false]) {
    test(`persisted ${unavailable ? "unavailable" : "legacy"} null remains identity-bound and cannot authorize spending`, async () => {
      const writer = writerFor();
      const resetAt = Date.now() + 86_400_000;
      setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100, weeklyResetAt: resetAt,
        credits: { hasCredits: true, balance: 5, observedAt: Date.now() } }, undefined, writer);
      setAccountQuotaFromParsed(MAIN, unavailable ? parseUsageQuota({ credits: {} }) : { credits: null },
        undefined, writer);
      // Partial headers carry the pair without supplying new spending evidence.
      applyAccountQuotaFromUpstreamHeaders(MAIN, new Headers({ "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(resetAt) }),
        undefined, writer);
      const quota = getMainPolicyQuota();
      expect(quota?.credits).toBeNull();
      expect(quota?.creditObservationUnavailable).toBe(unavailable ? true : undefined);
      expect(hasSpendableCodexCredits(quota)).toBe(false);
      expect(isCodexAccountHeldForCredits({ creditCodexAccountIds: [MAIN] }, MAIN, quota, "plus", Date.now())).toBe(true);
      const persisted = JSON.parse(await flushPersistence());
      expect(persisted.mainPolicyQuota).toEqual({ identityKey: writer.identityKey, quota });
      // Read the actual serializer output in a fresh process, without clearing or rewriting it.
      const script = `
        ${QUOTA_PROVENANCE_IMPORT_PROLOGUE}
        import { hasSpendableCodexCredits } from ${JSON.stringify(repoPath("src/codex/quota-types.ts"))};
        import { isCodexAccountHeldForCredits } from ${JSON.stringify(repoPath("src/codex/account-credit-use.ts"))};
        globalThis.fetch = () => { throw new Error("Unexpected network request"); };
        const before = getMainPolicyQuota();
        observeMainQuotaIdentity("fixture-main-b");
        const other = getMainPolicyQuota();
        observeMainQuotaIdentity("fixture-main-a");
        const policy = getMainPolicyQuota();
        console.log(JSON.stringify({ before, other, policy,
          spendable: hasSpendableCodexCredits(policy),
          held: isCodexAccountHeldForCredits({ creditCodexAccountIds: ["__main__"] }, "__main__", policy, "plus", Date.now()) }));
      `;
      const child = Bun.spawnSync({
        cmd: [process.execPath, "--eval", script], cwd: repoRoot(), env: process.env,
        timeout: process.platform === "win32" ? SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS : 10_000,
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({ before: null, other: null, policy: quota,
        spendable: false, held: true });
    }, SPAWN_BUDGET_MS);
  }

  test("stale main writers cannot replace unavailable evidence or attach it to a new identity", async () => {
    const oldA = writerFor();
    const unavailable = parseUsageQuota({ credits: {} });
    const positive = { hasCredits: true, balance: 5, observedAt: Date.now() };
    setAccountQuotaFromParsed(MAIN, unavailable, undefined, oldA);
    const writerB = writerFor("fixture-main-b");
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { credits: positive }, undefined, writerB);
    setAccountQuotaFromParsed(MAIN, unavailable, undefined, oldA);
    expect(getMainPolicyQuota()?.credits).toEqual(positive);
    expect(getMainPolicyQuota()?.creditObservationUnavailable).toBeUndefined();

    const newA = writerFor();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 100, weeklyResetAt: Date.now() + 86_400_000 }, undefined, newA);
    setAccountQuotaFromParsed(MAIN, unavailable, undefined, newA);
    const before = getMainPolicyQuota();
    expect(before).toMatchObject({ credits: null, creditObservationUnavailable: true });
    // Returning to A does not revive a writer captured before the A → B → A transition.
    setAccountQuotaFromParsed(MAIN, { credits: positive }, undefined, oldA);
    expect(isMainQuotaWriterLive(oldA)).toBe(false);
    expect(getMainPolicyQuota()).toEqual(before);
    expect(getAccountQuota(MAIN)?.credits).toBeNull();
    expect(hasSpendableCodexCredits(getMainPolicyQuota())).toBe(false);
    expect(isCodexAccountHeldForCredits({ creditCodexAccountIds: [MAIN] }, MAIN, getMainPolicyQuota(), "plus", Date.now())).toBe(true);
    expect(JSON.parse(await flushPersistence()).mainPolicyQuota).toEqual({ identityKey: newA.identityKey, quota: before });
  });

  for (const resetAt of [undefined, 4_000_000_000]) {
    test(`restart beyond six hours retains ${resetAt ? "future-reset" : "missing-reset"} policy evidence only for observed A`, () => {
      const writer = writerFor();
      const quota: StoredAccountQuota = {
        weeklyPercent: 99, updatedAt: Date.now() - 7 * 60 * 60_000,
        ...(resetAt ? { weeklyResetAt: resetAt } : {}),
      };
      writeSnapshot({ version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota } });
      const script = `
        ${QUOTA_PROVENANCE_IMPORT_PROLOGUE}
        const before = getMainPolicyQuota();
        observeMainQuotaIdentity("fixture-main-b");
        const other = getMainPolicyQuota();
        observeMainQuotaIdentity("fixture-main-a");
        console.log(JSON.stringify({ before, other, legacy: getAccountQuota("__main__"), policy: getMainPolicyQuota(),
          credentialMatches: matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a") }));
      `;
      // The fresh process is the restart oracle, including its module startup.
      // Probe 34053484372 retained all assertions and caught an identity-guard
      // mutation with this Windows budget; the previous 10s killed a healthy 12s delay.
      const child = Bun.spawnSync({
        cmd: [process.execPath, "--eval", script], cwd: repoRoot(), env: process.env,
        timeout: process.platform === "win32" ? SPAWN_BUDGET_MS - INTERNAL_DEADLINE_MS : 10_000,
      });
      expect(child.exitCode).toBe(0);
      const result = JSON.parse(child.stdout.toString());
      expect(result.before).toBeNull();
      expect(result.other).toBeNull();
      expect(result.legacy).toBeNull();
      expect(result.policy).toEqual(quota);
      expect(result.credentialMatches).toBe(false);
    }, SPAWN_BUDGET_MS);
  }

  test("unrelated persistence hydrates and retains policy after legacy TTL expiry", async () => {
    const writer = writerFor();
    const quota = { weeklyPercent: 99, updatedAt: Date.now() - 7 * 60 * 60_000 };
    writeSnapshot({ version: 1, quotas: { [MAIN]: quota }, mainPolicyQuota: { identityKey: writer.identityKey, quota } });
    setAccountQuotaFromParsed("fixture-pool", { weeklyPercent: 12 });
    const saved = JSON.parse(await flushPersistence());
    expect(saved.quotas[MAIN]).toBeUndefined();
    expect(saved.mainPolicyQuota.quota).toEqual(quota);
    expect(getMainPolicyQuota()).toEqual(quota);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: false }).state).toBe("off");
    expect(getAccountQuota(MAIN)).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 0 }, undefined, writer);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 99, resetCredits: 0 });
    expect(getAccountQuota(MAIN)).toEqual({ resetCredits: 0, updatedAt: expect.any(Number) });
    const afterCredits = JSON.parse(await flushPersistence());
    expect(afterCredits.quotas[MAIN].weeklyPercent).toBeUndefined();
    expect(afterCredits.mainPolicyQuota.quota.weeklyPercent).toBe(99);
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLock: true }).state).toBe("blocked");
    clearAccountQuota("fixture-pool");
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    clearAccountQuota(MAIN);
    expect(getMainPolicyQuota()).toBeNull();
    expect(JSON.parse(await flushPersistence()).mainPolicyQuota).toBeUndefined();
  });

  test("clear before first hydration cannot resurrect disk policy", () => {
    const writer = writerFor();
    writeSnapshot({ version: 1, quotas: {}, mainPolicyQuota: {
      identityKey: writer.identityKey, quota: { weeklyPercent: 99, updatedAt: Date.now() },
    } });
    clearAccountQuota(MAIN);
    expect(getMainPolicyQuota()).toBeNull();
  });

  test("legacy untagged disk quota remains untrusted after owned identity observation", () => {
    const writer = writerFor();
    writeSnapshot({ version: 1, quotas: { [MAIN]: { weeklyPercent: 99, updatedAt: Date.now() } } });
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
    expect(getMainPolicyQuota()).toBeNull();
    setAccountQuotaFromParsed(MAIN, { resetCredits: 1 }, undefined, writer);
    expect(getMainPolicyQuota()?.weeklyPercent).toBeUndefined();
    expect(getAccountQuota(MAIN)?.weeklyPercent).toBe(99);
  });

  test("disk policy accepts only bounded known fields and valid owner keys", () => {
    const writer = writerFor();
    writeSnapshot({ version: 1, quotas: {}, mainPolicyQuota: { identityKey: writer.identityKey, quota: {
      weeklyPercent: 99, monthlyPercent: "100", shortPercent: null, shortResetAt: -1,
      updatedAt: 1, shortObservedAt: 1234, bearerHmac: "must-not-load", customWindows: [{ label: "untrusted", percent: 100 }],
    } } });
    expect(getMainPolicyQuota()).toEqual({ weeklyPercent: 99, shortObservedAt: 1234, updatedAt: 1 });
    clearAccountQuota();
    writeSnapshot({ version: 1, quotas: {}, mainPolicyQuota: {
      identityKey: "not-an-identity-key", quota: { weeklyPercent: 99, updatedAt: 1 },
    } });
    expect(getMainPolicyQuota()).toBeNull();
  });

  test("owned reconciliation publishes identity and confirmed transitions purge policy and equality", () => {
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {
      access_token: "fixture-bearer-a", account_id: "fixture-main-a",
    } }));
    expect(reconcileMainCodexAccountRuntimeState()).toBe(false);
    const writer = observeMainQuotaCredential("fixture-bearer-a", "fixture-main-a");
    expect(writer).toBeDefined();
    setAccountQuotaFromParsed(MAIN, { weeklyPercent: 99 }, undefined, writer);
    writeFileSync(join(testDir, "auth.json"), "{");
    expect(reconcileMainCodexAccountRuntimeState()).toBe(false);
    expect(getMainPolicyQuota()?.weeklyPercent).toBe(99);
    expect(applyConfirmedMainCodexAccountTransition("fixture-main-a", "fixture-main-b")).toBe(true);
    expect(captureMainQuotaWriter("fixture-main-b")).toBeDefined();
    expect(getMainPolicyQuota()).toBeNull();
    expect(matchesMainQuotaCredential("fixture-bearer-a", "fixture-main-a")).toBe(false);
  });
});


test("pool history records fresh windows only and preserves identity across token refresh", async () => {
  const credential = { accessToken: "history-token", refreshToken: "history-refresh", chatgptAccountId: "history-account", expiresAt: Date.now() + 3600_000 };
  const generation = saveCodexAccountCredential("history-pool", credential);
  const writer = capturePoolQuotaWriter("history-pool", { ...credential, generation })!;
  const raw = { weeklyPercent: 10, weeklyResetAt: Date.now() / 1000 + 1000 };
  setAccountQuotaFromParsed("history-pool", raw, undefined, undefined, raw, { writer, observedAt: Date.now(), source: "wham", raw });
  applyAccountQuotaFromUpstreamHeaders("history-pool", new Headers({
    "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(Date.now() / 1000 + 300),
  }), undefined, undefined, { poolWriter: writer });
  let rows = getAccountQuotaHistory("history-pool").observations;
  expect(rows).toHaveLength(2);
  expect(rows[1].windows.map(window => window.window)).toEqual(["short"]);
  expect(getAccountQuota("history-pool")?.weeklyPercent).toBe(10);
  setAccountQuotaFromParsed("history-pool", { resetCredits: 2 });
  expect(getAccountQuotaHistory("history-pool").observations).toHaveLength(2);
  const refreshed = { ...credential, accessToken: "history-new-token" };
  expect(saveCodexAccountCredentialIfGeneration("history-pool", generation, refreshed)).toBe(true);
  applyAccountQuotaFromUpstreamHeaders("history-pool", new Headers({ "x-codex-primary-used-percent": "30" }), undefined, undefined, { poolWriter: writer });
  expect(getAccountQuotaHistory("history-pool").observations).toHaveLength(2);
  const refreshedWriter = capturePoolQuotaWriter("history-pool", { ...refreshed, generation: generation + 1 })!;
  applyAccountQuotaFromUpstreamHeaders("history-pool", new Headers({ "x-codex-primary-used-percent": "-20" }), undefined, undefined, { poolWriter: refreshedWriter });
  rows = getAccountQuotaHistory("history-pool").observations;
  expect(rows).toHaveLength(2);
  expect(isValidWhamHistoryObservation({ rate_limit: { primary_window: { used_percent: 101 } } })).toBe(false);
  expect(isValidWhamHistoryObservation({ additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: -1 } } }] })).toBe(false);
  const body = await flushPersistence();
  expect(JSON.parse(body).history.accounts["history-pool"].samples).toHaveLength(2);
  expect(body).not.toContain("history-token");
  expect(body).not.toContain("history-refresh");
  clearAccountQuota();
  writeSnapshot(JSON.parse(body));
  expect(getAccountQuotaHistory("history-pool").observations).toHaveLength(2);
  saveCodexAccountCredential("history-pool", refreshed);
  expect(getAccountQuotaHistory("history-pool").observations).toEqual([]);
});

test("native main observations and oversized cache never become pool history", async () => {
  const raw = { weeklyPercent: 20 };
  setAccountQuotaFromParsed(MAIN, raw, undefined, writerFor());
  expect(getAccountQuotaHistory(MAIN).observations).toEqual([]);
  const persisted = JSON.parse(await flushPersistence());
  expect(persisted.history.accounts).not.toHaveProperty(MAIN);
  clearAccountQuota();
  const credential = { accessToken: "large-cache-access", refreshToken: "large-cache-refresh", chatgptAccountId: "large-cache-account", expiresAt: Date.now() + 3600_000 };
  const generation = saveCodexAccountCredential("history-pool", credential);
  const writer = capturePoolQuotaWriter("history-pool", { ...credential, generation })!;
  writeFileSync(join(testDir, "codex-quota-cache.json"), JSON.stringify({ version: 1, quotas: {}, history: { version: 1, accounts: {
    "history-pool": { identity: writer.historyIdentity, samples: [{ observedAt: Date.now(), source: "wham", credentialGeneration: generation,
      windows: [{ family: "account", window: "weekly", usedPercent: 20 }] }] },
  } }, padding: "x".repeat(4 * 1024 * 1024) }));
  expect(getAccountQuotaHistory("history-pool").observations).toEqual([]);
});


test("main short window is retained without a main writer even with WHAM absence evidence", () => {
  const short = { shortPercent: 100, shortResetAt: Date.now() / 1000 + 3600 };
  setAccountQuotaFromParsed(MAIN, short);
  const data: WhamUsageResponse = { rate_limit: { allowed: true,
    primary_window: { used_percent: 0, limit_window_seconds: 604_800 }, secondary_window: null } };
  setAccountQuotaFromParsed(MAIN, parseUsageQuota(data), undefined, undefined, parseMainPolicyUsageQuota(data));
  expect(getAccountQuota(MAIN)?.shortPercent).toBe(100);
});
