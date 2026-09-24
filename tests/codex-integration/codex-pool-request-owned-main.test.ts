import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getEffectiveActiveCodexAccountId,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import type { OcxConfig } from "../../src/types";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-pool-request-owned-main-test");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [],
    activeCodexAccountId: undefined,
    autoSwitchThreshold: 80,
    ...overrides,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

function makeThreeAccountConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  const ids = ["a", "b", "c"];
  for (const id of ids) saveTestCredential(id);
  return makeConfig({
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    ...overrides,
  });
}

const THREE_ACCOUNT_IDS = ["a", "b", "c"] as const;

describe("selection order across rotation strategies", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearPoolRotationState();
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearPoolRotationState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  function primeAllQuota(usage = 10): void {
    for (const id of THREE_ACCOUNT_IDS) updateAccountQuota(id, usage);
  }

  describe("a request-owned main serves the request without becoming the shared active account", () => {
    // A request that carries its own main bearer makes main an ordinary pool candidate for
    // THAT request only (CodexAccountUsabilityOptions.requestOwnedMainCredential). Every write
    // of shared active state reachable with the request's selection options must skip it:
    // recording main would route later requests, which do not carry the credential, through a
    // main they cannot use. The storedMainLive variant of each scenario is the control that
    // proves the pick really moves the shared cursor when the credential is not request-owned.
    const requestOwnedMain = {
      requestOwnedMainCredential: true,
      isMainAccountTokenLive: () => true,
    };
    const storedMainLive = { isMainAccountTokenLive: () => true };

    test("quota auto-switch to a request-owned main serves it but keeps the operator selection", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        activeCodexAccountId: "a",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 95);
      updateAccountQuota("b", 50);
      updateAccountQuota("c", 50);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);

      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    });

    test("quota auto-switch to a live stored main persists the selection (control)", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        activeCodexAccountId: "a",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 95);
      updateAccountQuota("b", 50);
      updateAccountQuota("c", 50);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);

      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
      expect(getEffectiveActiveCodexAccountId(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    });

    test("a round-robin new session picks a request-owned main without moving the shared cursor", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
        activeCodexAccountId: "a",
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 10);

      // Main heads the eligible list, so the first ring pick is the request-owned main.
      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    });

    test("a round-robin new session moves the cursor to a live stored main (control)", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "round-robin",
        accountPoolStickyLimit: 1,
        activeCodexAccountId: "a",
      });
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 10);
      updateAccountQuota("c", 10);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 10);

      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    });

    test("a fill-first new session picks a request-owned main without moving the shared cursor", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "fill-first",
        activeCodexAccountId: "c",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 95);
      updateAccountQuota("b", 95);
      updateAccountQuota("c", 95);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);

      // "c" is drained, so fill-first advances in stable order; "__main__" wraps to the
      // successor of the last stored id and is the only candidate with headroom.
      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("c");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("c");
    });

    test("a fill-first new session moves the cursor to a live stored main (control)", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "fill-first",
        activeCodexAccountId: "c",
        autoSwitchThreshold: 80,
      });
      updateAccountQuota("a", 95);
      updateAccountQuota("b", 95);
      updateAccountQuota("c", 95);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);

      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("c");
      expect(getEffectiveActiveCodexAccountId(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    });

    test("priority preemption to a request-owned main serves it without moving the shared cursor", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        activeCodexAccountId: "a",
        codexAccountPriorities: { __main__: 2, a: 1, b: 1, c: 1 },
      } as Partial<OcxConfig>);
      primeAllQuota();
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 10);

      // Main is alone in the highest eligible tier, so the unbound request preempts "a" up
      // to it — the rememberActiveCodexAccount(preempted) site.
      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    });

    test("priority preemption moves the cursor to a live stored main (control)", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        activeCodexAccountId: "a",
        codexAccountPriorities: { __main__: 2, a: 1, b: 1, c: 1 },
      } as Partial<OcxConfig>);
      primeAllQuota();
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 10);

      expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID });
      expect(config.activeCodexAccountId).toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    });

    test("a bound thread re-evaluating onto a request-owned main does not promote it", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        autoSwitchThreshold: 80,
        activeCodexAccountId: "a",
        pool: { cacheAffinity: false },
      } as Partial<OcxConfig>);
      const threadId = "request-owned-quota-rebind";
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 50);
      updateAccountQuota("c", 50);
      const start = Date.now();
      expect(resolveCodexAccountForThreadDetailed(threadId, config, start, "shared"))
        .toMatchObject({ status: "selected", accountId: "a", affinity: { move: "new_bind", reason: "healthy" } });

      updateAccountQuota("a", 95);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);
      const reboundAt = Date.now();

      // The bound account crossed its threshold and the request-owned main is the strictly
      // cooler candidate — the promoteActiveCodexAccount(cooler) site.
      expect(resolveCodexAccountForThreadDetailed(threadId, config, reboundAt, "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID,
          affinity: { move: "rebound", reason: "quota_headroom" } });
      expect(config.activeCodexAccountId).toBe("a");
      expect(getEffectiveActiveCodexAccountId(config)).toBe("a");
    });

    test("a bound thread re-evaluating onto a live stored main promotes it (control)", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        autoSwitchThreshold: 80,
        activeCodexAccountId: "a",
        pool: { cacheAffinity: false },
      } as Partial<OcxConfig>);
      const threadId = "stored-main-quota-rebind";
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 50);
      updateAccountQuota("c", 50);
      const start = Date.now();
      expect(resolveCodexAccountForThreadDetailed(threadId, config, start, "shared"))
        .toMatchObject({ status: "selected", accountId: "a", affinity: { move: "new_bind", reason: "healthy" } });

      updateAccountQuota("a", 95);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);
      const reboundAt = Date.now();

      expect(resolveCodexAccountForThreadDetailed(threadId, config, reboundAt, "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID,
          affinity: { move: "rebound", reason: "quota_headroom" } });
      expect(config.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
      expect(getEffectiveActiveCodexAccountId(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    });

    test("an expired transient detour on a request-owned main does not promote it", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        autoSwitchThreshold: 80,
        activeCodexAccountId: "a",
        upstreamFailoverThreshold: 3,
      });
      const threadId = "request-owned-expired-detour";
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 20);
      updateAccountQuota("c", 30);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);
      const start = Date.now();
      expect(resolveCodexAccountForThreadDetailed(threadId, config, start, "shared"))
        .toMatchObject({ status: "selected", accountId: "a", affinity: { move: "new_bind", reason: "healthy" } });

      recordCodexUpstreamOutcome(config, "a", 503, { now: start });
      recordCodexUpstreamOutcome(config, "a", 503, { now: start });
      recordCodexUpstreamOutcome(config, "a", 503, { now: start });

      // The streak detours this request onto the request-owned main — the coolest eligible
      // account — while the binding itself stays on "a".
      expect(resolveCodexAccountForThreadDetailed(threadId, config, start, "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID,
          affinity: { move: "detour", reason: "transient" } });
      const operatorAccount = config.activeCodexAccountId;
      expect(operatorAccount).not.toBe(MAIN_CODEX_ACCOUNT_ID);

      // The hold outlives its window with "a" still failing, so the thread adopts its
      // detour — the promoteActiveCodexAccount(expiredDetour) site.
      const late = start + 11 * 60_000;
      recordCodexUpstreamOutcome(config, "a", 503, { now: late });
      recordCodexUpstreamOutcome(config, "a", 503, { now: late });
      recordCodexUpstreamOutcome(config, "a", 503, { now: late });
      expect(resolveCodexAccountForThreadDetailed(threadId, config, late, "shared", requestOwnedMain))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID,
          affinity: { move: "rebound", reason: "transient_hold_expired" } });
      expect(config.activeCodexAccountId).toBe(operatorAccount);
      expect(getEffectiveActiveCodexAccountId(config)).toBe(operatorAccount);
    });

    test("an expired transient detour on a live stored main promotes it (control)", () => {
      const config = makeThreeAccountConfig({
        accountPoolStrategy: "quota",
        autoSwitchThreshold: 80,
        activeCodexAccountId: "a",
        upstreamFailoverThreshold: 3,
      });
      const threadId = "stored-main-expired-detour";
      updateAccountQuota("a", 10);
      updateAccountQuota("b", 20);
      updateAccountQuota("c", 30);
      updateAccountQuota(MAIN_CODEX_ACCOUNT_ID, 5);
      const start = Date.now();
      expect(resolveCodexAccountForThreadDetailed(threadId, config, start, "shared"))
        .toMatchObject({ status: "selected", accountId: "a", affinity: { move: "new_bind", reason: "healthy" } });

      recordCodexUpstreamOutcome(config, "a", 503, { now: start });
      recordCodexUpstreamOutcome(config, "a", 503, { now: start });
      recordCodexUpstreamOutcome(config, "a", 503, { now: start });

      expect(resolveCodexAccountForThreadDetailed(threadId, config, start, "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID,
          affinity: { move: "detour", reason: "transient" } });

      const late = start + 11 * 60_000;
      recordCodexUpstreamOutcome(config, "a", 503, { now: late });
      recordCodexUpstreamOutcome(config, "a", 503, { now: late });
      recordCodexUpstreamOutcome(config, "a", 503, { now: late });
      expect(resolveCodexAccountForThreadDetailed(threadId, config, late, "shared", storedMainLive))
        .toMatchObject({ status: "selected", accountId: MAIN_CODEX_ACCOUNT_ID,
          affinity: { move: "rebound", reason: "transient_hold_expired" } });
      expect(config.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
      expect(getEffectiveActiveCodexAccountId(config)).toBe(MAIN_CODEX_ACCOUNT_ID);
    });
  });
});
