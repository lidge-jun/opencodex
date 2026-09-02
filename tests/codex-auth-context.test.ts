import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCodexAuthContextToProvider,
  assertCodexAuthContextNotCooled,
  CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexMainProfileDrainingError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  codexMainProfileDrainingResponse,
  __resetNativeMainFenceReasonLog,
  cooldownErrorMessage,
  cooldownErrorResponse,
  headersForCodexAuthContext,
  materializeCodexUpstreamAuth,
  CodexMainSubstitutionUnavailableError,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  shouldMarkAccountNeedsReauthForCodexAuthFailure,
  stripCodexRuntimeProviderFields,
} from "../src/codex/auth-context";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshStaleError,
  getCodexAccountCredential,
  getValidCodexToken,
  readCodexAccountRecord,
  removeCodexAccountCredential,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import { ConfigMutationLockError, getConfigPath } from "../src/config";
import {
  getMainAccountPlan,
  MAIN_CODEX_ACCOUNT_ID,
  setMainAccountPlan,
} from "../src/codex/main-account";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  isAccountNeedsReauth,
  markAccountNeedsReauth,
  setAccountQuotaFromParsed,
} from "../src/codex/auth-api";
import { __resetGuardianState, guardianSweep } from "../src/oauth/token-guardian";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
} from "../src/codex/routing";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";
import {
  blockNativeMainStartupForUnownedServiceHome,
  completeNativeMainRecovery,
  initializeNativeMainStartupGate,
} from "../src/codex/native-profile-startup";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import {
  acquireNativeMainProfileDrain,
  codexAccountSelectionForTurn,
  tryAdmitTurn,
} from "../src/server/lifecycle";
import type { CodexModelEntitlementSnapshot } from "../src/codex/model-entitlements";
import { hasForwardableCodexBearer } from "../src/server/auth-cors";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testDir: string;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  // This suite validates refresh admission and auth-context outcomes. Real icacls
  // processes are covered elsewhere and can retain temp-dir handles long enough
  // to obscure those assertions under Windows isolated-test load.
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  testDir = mkdtempSync(join(tmpdir(), "ocx-auth-ctx-"));
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  // Isolate the main-account credential source: testDir has no auth.json, so the main
  // account is deterministically absent (these cases test pool-only fail-closed behavior).
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = testDir;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  setMainAccountPlan(null);
  __resetGuardianState();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
});

afterEach(() => {
  setIcaclsRunnerForTests(null);
  removeTreeWithRetry(testDir);
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  setMainAccountPlan(null);
  __resetGuardianState();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-b");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    activeCodexAccountId: "pool-a",
    providers: {
      routed: { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" },
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.test/backend-api/codex", authMode: "forward" },
    },
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool_acc" },
    ],
  };
}

function chatgptPlanJwt(plan: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ chatgpt_plan_type: plan })).toString("base64url");
  return `${header}.${body}.sig`;
}

function guardianConfig(): OcxConfig {
  const cfg = config();
  cfg.defaultProvider = "openai";
  cfg.providers = {
    openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      codexAccountMode: "pool",
      refreshPolicy: "proactive",
    },
  };
  cfg.tokenGuardian = {
    enabled: true,
    tickSeconds: 60,
    leadSeconds: 0,
    failureBackoffBaseSeconds: 1,
    failureBackoffMaxSeconds: 60,
  };
  writeFileSync(getConfigPath(), JSON.stringify(cfg));
  return cfg;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    // SQLite-backed native-main claims may need an actual event-loop turn;
    // a microtask-only spin can starve the operation this helper is observing.
    await Bun.sleep(1);
  }
  throw new Error("condition did not become true");
}

async function occupyCodexRefreshCapacity(): Promise<{
  pending: Promise<unknown>[];
  release: () => void;
  fetches: () => number;
}> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    await gate;
    return Response.json({ access_token: "capacity-fresh", expires_in: 3600 });
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < 32; index += 1) {
    const id = `capacity-${index}`;
    saveCodexAccountCredential(id, {
      accessToken: `old-${index}`,
      refreshToken: `refresh-${index}`,
      expiresAt: 0,
      chatgptAccountId: `account-${index}`,
    });
    pending.push(getValidCodexToken(id));
  }
  await waitFor(() => fetches === 32);
  for (let index = 0; index < 32; index += 1) removeCodexAccountCredential(`capacity-${index}`);
  return { pending, release, fetches: () => fetches };
}

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/backend-api/codex",
  authMode: "forward",
};


/** A JWT whose `exp` is far in the future, so isMainAccountTokenLive() accepts it. */
function liveJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
  return `header.${payload}.signature`;
}

function expiredJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url");
  return `header.${payload}.signature`;
}
describe("Codex auth context", () => {
  test("main-profile drain routes a non-main pool account without native reads or quota priming", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "pool_acc",
    });
    let nativeReads = 0;
    let primes = 0;
    const drain = acquireNativeMainProfileDrain("auth-context-test");
    const turn = tryAdmitTurn();
    expect(drain).not.toBeNull();
    expect(turn).not.toBeNull();
    try {
      await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
        beginCodexAccountSelection: codexAccountSelectionForTurn(turn!),
        isMainAccountTokenLive: () => { nativeReads += 1; return true; },
        getMainAccountToken: () => {
          nativeReads += 1;
          return { accessToken: "main", chatgptAccountId: "main-account" };
        },
        primeCodexPoolQuotas: async () => { primes += 1; },
      })).resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      expect(nativeReads).toBe(0);
      expect(primes).toBe(0);
    } finally {
      turn?.release();
      drain?.release();
    }
  });

  test("recovery excludes main from affinity, rotation, and retry while healthy pool continues", async () => {
    writeFileSync(
      join(testDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "main_token", account_id: "main-account" } }),
    );
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 3_600_000,
      chatgptAccountId: "pool_acc",
    });
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    const affinityHeaders = ["round-robin", "fill-first"].map(strategy => new Headers({
      "x-codex-parent-thread-id": `main-affinity-${strategy}`,
    }));
    for (const headers of affinityHeaders) {
      await expect(resolveCodexAuthContext(headers, cfg, "pool", {
        primeCodexPoolQuotas: async () => {},
      })).resolves.toMatchObject({ kind: "main-pool", accountId: MAIN_CODEX_ACCOUNT_ID });
    }
    cfg.activeCodexAccountId = "pool-a";

    const homeId = "auth-context-recovery-gate";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId }, recover: async () => ({}) } as unknown as NativeProfileManager,
      probeRecoveryState: () => "manual",
    });
    let nativeReads = 0;
    let primes = 0;
    const readOptions = {
      isMainAccountTokenLive: () => { nativeReads += 1; return true; },
      getMainAccountToken: () => {
        nativeReads += 1;
        return { accessToken: "main", chatgptAccountId: "main-account" };
      },
      primeCodexPoolQuotas: async () => { primes += 1; },
    };
    try {
      for (const [index, strategy] of ["round-robin", "fill-first"].entries()) {
        cfg.accountPoolStrategy = strategy as "round-robin" | "fill-first";
        cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
        await expect(resolveCodexAuthContext(affinityHeaders[index]!, cfg, "pool", readOptions))
          .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
        cfg.activeCodexAccountId = "pool-a";
        await expect(resolveCodexAuthContext(
          new Headers({ "x-codex-parent-thread-id": `new-${strategy}` }),
          cfg,
          "pool",
          readOptions,
        )).resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
        await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
          ...readOptions,
          excludeAccountId: MAIN_CODEX_ACCOUNT_ID,
        })).resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
        await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
          ...readOptions,
          excludeAccountId: "pool-a",
        })).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
        expect(cfg.activeCodexAccountId).toBe("pool-a");
      }
      cfg.pausedCodexAccountIds = ["pool-a"];
      cfg.activeCodexAccountId = "pool-a";
      await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", readOptions))
        .rejects.toBeInstanceOf(CodexMainProfileDrainingError);
      await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
        ...readOptions,
        excludeAccountId: "pool-a",
      })).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
      expect(nativeReads).toBe(0);
      expect(primes).toBe(0);
    } finally {
      completeNativeMainRecovery(homeId);
    }
  });

  test("post-fence main selection rejects before injected token materialization", async () => {
    writeFileSync(
      join(testDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "main_token", account_id: "main-account" } }),
    );
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    let nativeReads = 0;
    const drain = acquireNativeMainProfileDrain("auth-context-main-test");
    const turn = tryAdmitTurn();
    try {
      await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
        beginCodexAccountSelection: codexAccountSelectionForTurn(turn!),
        isMainAccountTokenLive: () => { nativeReads += 1; return true; },
        getMainAccountToken: () => {
          nativeReads += 1;
          return { accessToken: "main", chatgptAccountId: "main-account" };
        },
        primeCodexPoolQuotas: async () => { throw new Error("must not prime"); },
      })).rejects.toBeInstanceOf(CodexMainProfileDrainingError);
      expect(nativeReads).toBe(0);
      // Selection-only quota scoring must not lazily read/cache the fenced main
      // plan before the atomic claim rejects the request.
      writeFileSync(join(testDir, "auth.json"), JSON.stringify({
        tokens: { access_token: chatgptPlanJwt("pro"), account_id: "main-account" },
      }));
      expect(getMainAccountPlan()).toBe("pro");
    } finally {
      turn?.release();
      drain?.release();
    }
  });

  test("gated main selection preserves the temporary drain classification without entitlement reads", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    let nativeReads = 0;
    let entitlementCalls = 0;
    const drain = acquireNativeMainProfileDrain("auth-context-gated-main-test");
    const turn = tryAdmitTurn();
    try {
      await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
        modelId: "gpt-daybreak-blue-latest",
        beginCodexAccountSelection: codexAccountSelectionForTurn(turn!),
        isMainAccountTokenLive: () => { nativeReads += 1; return true; },
        getMainAccountToken: () => {
          nativeReads += 1;
          return { accessToken: "main", chatgptAccountId: "main-account" };
        },
        resolveCodexModelEntitlements: async (_config, options) => {
          entitlementCalls += 1;
          expect(options?.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
          return {
            modelsByAccount: new Map(),
            confirmedAccountIds: new Set(),
            credentialIdentities: new Map(),
          };
        },
      })).rejects.toBeInstanceOf(CodexMainProfileDrainingError);
      expect(entitlementCalls).toBe(1);
      expect(nativeReads).toBe(0);
      expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
      // Pin retirement must not lazily score/read main while the drain fence is up.
      // A prior plan read against the intentionally missing auth.json would cache
      // `undefined` and make this post-fence JWT fallback fail.
      writeFileSync(join(testDir, "auth.json"), JSON.stringify({
        tokens: { access_token: chatgptPlanJwt("pro"), account_id: "main-account" },
      }));
      expect(getMainAccountPlan()).toBe("pro");
    } finally {
      turn?.release();
      drain?.release();
    }
  });

  test("gated no-active drain reaches the atomic main claim before maintenance classification", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = undefined;
    let nativeReads = 0;
    let claimCalls = 0;
    let selectionReleases = 0;

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      beginCodexAccountSelection: () => ({
        mainProfileDraining: true,
        claimMainProfile: () => { claimCalls += 1; return false; },
        release: () => { selectionReleases += 1; },
      }),
      isMainAccountTokenLive: () => { nativeReads += 1; return true; },
      getMainAccountToken: () => {
        nativeReads += 1;
        return { accessToken: "main", chatgptAccountId: "main-account" };
      },
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map(),
        confirmedAccountIds: new Set(),
        credentialIdentities: new Map(),
      }),
    })).rejects.toBeInstanceOf(CodexMainProfileDrainingError);

    expect(claimCalls).toBe(1);
    expect(selectionReleases).toBe(1);
    expect(nativeReads).toBe(0);
  });

  test("direct mode returns caller-owned main context without touching pool selection", async () => {
    const cfg = { ...config(), activeCodexAccountId: "missing-pool-account" };
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer caller" }), cfg, "direct", {
      beginCodexAccountSelection: () => {
        throw new Error("caller-owned Direct must not reserve stored main");
      },
    }))
      .resolves.toEqual({ kind: "main", accountId: null });
  });
  test("direct mode fails locally without a caller bearer", async () => {
    await expect(resolveCodexAuthContext(new Headers(), config(), "direct"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer   " }), config(), "direct"))
      .rejects.toBeInstanceOf(CodexDirectAuthenticationError);
  });

  test("direct account-gated routing checks the caller credential, not local account state", async () => {
    let callerChecks = 0;
    let localDiscoveries = 0;
    const headers = new Headers({ authorization: "Bearer caller", "chatgpt-account-id": "caller-account" });
    await expect(resolveCodexAuthContext(headers, config(), "direct", {
      modelId: "gpt-daybreak-blue-latest",
      isDirectCallerEntitledToCodexModel: async (received, modelId) => {
        callerChecks += 1;
        expect(received).toBe(headers);
        expect(modelId).toBe("gpt-daybreak-blue-latest");
        return true;
      },
      resolveCodexModelEntitlements: async () => {
        localDiscoveries += 1;
        throw new Error("must not inspect local accounts");
      },
    })).resolves.toEqual({ kind: "main", accountId: null });
    expect(callerChecks).toBe(1);
    expect(localDiscoveries).toBe(0);
  });

  test("Direct admission-bearer substitution checks the stored main account grant", async () => {
    const entitledMain: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map([[MAIN_CODEX_ACCOUNT_ID, new Set(["gpt-daybreak-blue-latest"])]]),
      confirmedAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID]),
      credentialIdentities: new Map(),
    };
    let callerChecks = 0;
    let claimCalls = 0;
    let selectionReleases = 0;
    let claimed = false;
    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer ocx-admission" }),
      config(),
      "direct",
      {
        modelId: "gpt-daybreak-blue-latest",
        substituteMainCredentialForDirect: true,
        beginCodexAccountSelection: () => ({
          mainProfileDraining: false,
          claimMainProfile: () => {
            claimCalls += 1;
            claimed = true;
            return true;
          },
          release: () => { selectionReleases += 1; },
        }),
        resolveCodexModelEntitlements: async () => {
          expect(claimed).toBe(true);
          return entitledMain;
        },
        isDirectCallerEntitledToCodexModel: async () => {
          callerChecks += 1;
          return false;
        },
      },
    )).resolves.toEqual({ kind: "main", accountId: null });
    expect(callerChecks).toBe(0);
    expect(claimCalls).toBe(1);
    expect(selectionReleases).toBe(1);
  });

  test("Direct admission-bearer substitution fails closed during native-main drain", async () => {
    let entitlementCalls = 0;
    let claimCalls = 0;
    let selectionReleases = 0;
    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer ocx-admission" }),
      config(),
      "direct",
      {
        modelId: "gpt-5.5",
        substituteMainCredentialForDirect: true,
        beginCodexAccountSelection: () => ({
          mainProfileDraining: true,
          claimMainProfile: () => {
            claimCalls += 1;
            return false;
          },
          release: () => { selectionReleases += 1; },
        }),
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("must not read stored-main entitlements while draining");
        },
      },
    )).rejects.toBeInstanceOf(CodexMainProfileDrainingError);
    expect(entitlementCalls).toBe(0);
    expect(claimCalls).toBe(0);
    expect(selectionReleases).toBe(1);
  });

  test("Direct admission-bearer substitution fails closed when the atomic claim loses", async () => {
    let entitlementCalls = 0;
    let claimCalls = 0;
    let selectionReleases = 0;
    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer ocx-admission" }),
      config(),
      "direct",
      {
        modelId: "gpt-daybreak-blue-latest",
        substituteMainCredentialForDirect: true,
        beginCodexAccountSelection: () => ({
          mainProfileDraining: false,
          claimMainProfile: () => {
            claimCalls += 1;
            return false;
          },
          release: () => { selectionReleases += 1; },
        }),
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("must not read stored-main entitlements after a lost claim");
        },
      },
    )).rejects.toBeInstanceOf(CodexMainProfileDrainingError);
    expect(entitlementCalls).toBe(0);
    expect(claimCalls).toBe(1);
    expect(selectionReleases).toBe(1);
  });

  test("Direct admission-bearer substitution requires a turn-owned native-main claim", async () => {
    let entitlementCalls = 0;
    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer ocx-admission" }),
      config(),
      "direct",
      {
        modelId: "gpt-daybreak-blue-latest",
        substituteMainCredentialForDirect: true,
        resolveCodexModelEntitlements: async () => {
          entitlementCalls += 1;
          throw new Error("must not read stored-main entitlements without admission");
        },
      },
    )).rejects.toBeInstanceOf(CodexMainProfileDrainingError);
    expect(entitlementCalls).toBe(0);
  });

  test("account-gated native routing skips an active account without the model grant", async () => {
    const cfg = config();
    cfg.activeCodexAccountPinned = "pool-a";
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "main-token", account_id: "main-account" },
    }));
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    const entitlementSnapshot: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map([
        [MAIN_CODEX_ACCOUNT_ID, new Set(["gpt-daybreak-blue-latest"])],
        ["pool-a", new Set(["gpt-5.6-sol"])],
      ]),
      confirmedAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID, "pool-a"]),
      credentialIdentities: new Map(),
    };

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: "gpt-daybreak-blue-latest",
      isMainAccountTokenLive: () => true,
      getMainAccountToken: () => ({ accessToken: "main-token", chatgptAccountId: "main-account" }),
      resolveCodexModelEntitlements: async () => entitlementSnapshot,
      primeCodexPoolQuotas: async () => {},
    })).resolves.toMatchObject({
      kind: "main-pool",
      accountId: MAIN_CODEX_ACCOUNT_ID,
    });
    expect(cfg.activeCodexAccountId).toBe("pool-a");
    expect(cfg.activeCodexAccountPinned).toBe("pool-a");

    // The preceding model-only detour must not replace the operator's shared
    // selection; a following ordinary request still uses the pinned pool account.
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      modelId: "gpt-5.5",
      isMainAccountTokenLive: () => true,
      getMainAccountToken: () => ({ accessToken: "main-token", chatgptAccountId: "main-account" }),
      primeCodexPoolQuotas: async () => {},
    })).resolves.toMatchObject({
      kind: "pool",
      accountId: "pool-a",
    });
  });

  test("account-gated routing distinguishes an unavailable grant from no grant", async () => {
    const cfg = config();
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    const snapshot = (models: string[]): CodexModelEntitlementSnapshot => ({
      modelsByAccount: new Map([["pool-a", new Set(models)]]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map(),
    });
    const resolve = (models: string[]) => resolveCodexAuthContext(new Headers(), cfg, "pool", {
      excludeAccountId: "pool-a",
      modelId: "gpt-daybreak-blue-latest",
      resolveCodexModelEntitlements: async () => snapshot(models),
    });

    await expect(resolve(["gpt-daybreak-blue-latest"]))
      .rejects.toThrow("Codex accounts that support this model are currently unavailable");
    await expect(resolve(["gpt-5.6-sol"]))
      .rejects.toThrow("No eligible Codex account supports this model");

    const mainExcludedSnapshot: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map(),
      confirmedAccountIds: new Set(),
      credentialIdentities: new Map(),
    };
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      excludeAccountId: "pool-a",
      modelId: "gpt-daybreak-blue-latest",
      beginCodexAccountSelection: () => ({
        mainProfileDraining: true,
        claimMainProfile: () => false,
        release: () => {},
      }),
      resolveCodexModelEntitlements: async (_config, options) => {
        expect(options?.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID)).toBeTrue();
        return mainExcludedSnapshot;
      },
    })).rejects.toThrow("Codex accounts that support this model are currently unavailable");
  });

  test("auth resolution preserves per-model detours without replacing ordinary affinity", async () => {
    const cfg = config();
    cfg.accountPoolStrategy = "round-robin";
    cfg.accountPoolStickyLimit = 1;
    cfg.activeCodexAccountId = "pool-b";
    cfg.activeCodexAccountPinned = "pool-b";
    cfg.codexAccounts = [
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_acc_a" },
      { id: "pool-b", email: "b@example.test", isMain: false, chatgptAccountId: "pool_acc_b" },
      { id: "pool-c", email: "c@example.test", isMain: false, chatgptAccountId: "pool_acc_c" },
    ];
    for (const id of ["pool-a", "pool-b", "pool-c"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}-token`,
        refreshToken: `${id}-refresh`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `${id}-chatgpt`,
      });
    }
    resetCodexRoutingForManualSelection("pool-b");
    const headers = new Headers({ "x-codex-parent-thread-id": "auth-model-detour-thread" });
    const primeCodexPoolQuotas = async () => {};
    await expect(resolveCodexAuthContext(headers, cfg, "pool", {
      modelId: "gpt-5.5",
      primeCodexPoolQuotas,
    })).resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });

    const entitlementSnapshot: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map([
        ["pool-a", new Set(["gpt-daybreak-blue-latest", "gpt-5.6-sol"])],
        ["pool-c", new Set(["gpt-daybreak-blue-latest", "gpt-5.6-sol"])],
      ]),
      confirmedAccountIds: new Set(["pool-a", "pool-b", "pool-c"]),
      credentialIdentities: new Map(),
    };
    const gatedOptions = {
      primeCodexPoolQuotas,
      resolveCodexModelEntitlements: async () => entitlementSnapshot,
    };
    const first = await resolveCodexAuthContext(headers, cfg, "pool", {
      ...gatedOptions,
      modelId: "gpt-daybreak-blue-latest",
    });
    expect(first).toMatchObject({ kind: "pool" });
    await expect(resolveCodexAuthContext(headers, cfg, "pool", {
      ...gatedOptions,
      modelId: "gpt-daybreak-blue-latest",
    })).resolves.toMatchObject({ kind: "pool", accountId: first.accountId });

    const secondModel = await resolveCodexAuthContext(headers, cfg, "pool", {
      ...gatedOptions,
      modelId: "gpt-5.6-sol",
    });
    expect(secondModel).toMatchObject({ kind: "pool" });
    expect(secondModel.accountId).not.toBe(first.accountId);
    await expect(resolveCodexAuthContext(headers, cfg, "pool", {
      ...gatedOptions,
      modelId: "gpt-5.6-sol",
    })).resolves.toMatchObject({ kind: "pool", accountId: secondModel.accountId });

    await expect(resolveCodexAuthContext(headers, cfg, "pool", {
      modelId: "gpt-5.5",
      primeCodexPoolQuotas,
    })).resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
  });

  test("exact account-gated routing fails closed for an unentitled account", async () => {
    const cfg = config();
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    const entitlementSnapshot: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map([["pool-a", new Set(["gpt-5.6-sol"])]]),
      confirmedAccountIds: new Set(["pool-a"]),
      credentialIdentities: new Map(),
    };

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      accountId: "pool-a",
      modelId: "gpt-daybreak-blue-latest",
      resolveCodexModelEntitlements: async () => entitlementSnapshot,
    })).rejects.toThrow("Selected Codex account does not support this model");
  });

  test("ordinary native models do not pay the entitlement discovery path", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    let discoveries = 0;
    await expect(resolveCodexAuthContext(new Headers(), config(), "pool", {
      modelId: "gpt-5.5",
      resolveCodexModelEntitlements: async () => {
        discoveries += 1;
        throw new Error("must not run");
      },
    })).resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(discoveries).toBe(0);
  });

  test("exact account resolution overrides Direct without consulting Pool selection", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = "pool-b";
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    saveCodexAccountCredential("pool-a", {
      accessToken: "fixed_pool_token",
      refreshToken: "fixed_pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "fixed_pool_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "active_pool_token",
      refreshToken: "active_pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "active_pool_acc",
    });
    const headers = new Headers({ "x-codex-parent-thread-id": "exact-thread" });

    const exactContext = await resolveCodexAuthContext(headers, cfg, "direct", {
      accountId: "pool-a",
      modelId: "gpt-5.5",
    });
    expect(exactContext).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      accessToken: "fixed_pool_token",
      chatgptAccountId: "fixed_pool_acc",
      fixedAccount: true,
    });
    expect(applyCodexAuthContextToProvider(forwardProvider, exactContext, "pool")).toMatchObject({
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "fixed_pool_token", chatgptAccountId: "fixed_pool_acc" },
    });
    expect(cfg.activeCodexAccountId).toBe("pool-b");
    await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.5" }))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
  });

  test("Desktop session and thread headers derive one opaque reconnect affinity", async () => {
    const cfg = config();
    cfg.autoSwitchThreshold = 0;
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });
    const headers = new Headers({
      "session-id": "desktop-session-private",
      "thread-id": "desktop-thread-private",
    });

    const first = await resolveCodexAuthContext(headers, cfg, "pool");
    expect(first).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(first.kind).toBe("pool");
    if (first.kind !== "pool") throw new Error("expected pool context");
    expect(first.affinityKey?.startsWith("app:")).toBe(true);
    expect(first.affinityKey?.includes("desktop-session-private")).toBe(false);
    expect(first.affinityKey?.includes("desktop-thread-private")).toBe(false);

    cfg.activeCodexAccountId = "pool-b";
    const reconnect = await resolveCodexAuthContext(headers, cfg, "pool");
    expect(reconnect).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      affinityKey: first.affinityKey,
    });
  });

  test("the canonical parent-thread affinity stays authoritative over Desktop fallback headers", async () => {
    const cfg = config();
    cfg.autoSwitchThreshold = 0;
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    const headers = new Headers({
      "x-codex-parent-thread-id": "  canonical-parent-thread  ",
      "session-id": "desktop-session-private",
      "thread-id": "desktop-thread-private",
    });

    const resolved = await resolveCodexAuthContext(headers, cfg, "pool");
    expect(resolved).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      affinityKey: "canonical-parent-thread",
    });
  });

  test("an oversized parent-thread id falls back to the bounded Desktop pair", async () => {
    const cfg = config();
    cfg.autoSwitchThreshold = 0;
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    const headers = new Headers({
      "x-codex-parent-thread-id": "p".repeat(513),
      "session-id": "desktop-session-private",
      "thread-id": "desktop-thread-private",
    });

    const resolved = await resolveCodexAuthContext(headers, cfg, "pool");
    expect(resolved).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(resolved.kind).toBe("pool");
    if (resolved.kind !== "pool") throw new Error("expected pool context");
    expect(resolved.affinityKey?.startsWith("app:")).toBe(true);
    expect(resolved.affinityKey).not.toContain("desktop-session-private");
    expect(resolved.affinityKey).not.toContain("desktop-thread-private");
  });

  test("incomplete or oversized Desktop affinity headers remain unbound", async () => {
    const cfg = config();
    cfg.autoSwitchThreshold = 0;
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}_token`,
        refreshToken: `${id}_refresh`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `${id}_acc`,
      });
    }

    for (const headers of [
      new Headers({ "session-id": "session-only" }),
      new Headers({ "thread-id": "thread-only" }),
      new Headers({ "session-id": "s".repeat(513), "thread-id": "bounded-thread" }),
    ]) {
      clearThreadAccountMap();
      cfg.activeCodexAccountId = "pool-a";
      const first = await resolveCodexAuthContext(headers, cfg, "pool");
      expect(first).toMatchObject({ kind: "pool", accountId: "pool-a" });
      expect(first.kind === "pool" ? first.affinityKey : undefined).toBeUndefined();

      cfg.activeCodexAccountId = "pool-b";
      await expect(resolveCodexAuthContext(headers, cfg, "pool"))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
    }
  });

  test("exact account selection does not create Desktop Pool affinity", async () => {
    const cfg = config();
    cfg.autoSwitchThreshold = 0;
    cfg.activeCodexAccountId = "pool-b";
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}_token`,
        refreshToken: `${id}_refresh`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `${id}_acc`,
      });
    }
    const headers = new Headers({
      "session-id": "exact-desktop-session",
      "thread-id": "exact-desktop-thread",
    });

    const exact = await resolveCodexAuthContext(headers, cfg, "pool", { accountId: "pool-a" });
    expect(exact).toMatchObject({ kind: "pool", accountId: "pool-a", fixedAccount: true });
    expect(exact.kind === "pool" ? exact.affinityKey : undefined).toBeUndefined();

    await expect(resolveCodexAuthContext(headers, cfg, "pool"))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
  });

  test("late transient failure cannot delete a newer Desktop affinity binding", async () => {
    const cfg = config();
    cfg.autoSwitchThreshold = 0;
    cfg.upstreamFailoverThreshold = 3;
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    for (const id of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(id, {
        accessToken: `${id}_token`,
        refreshToken: `${id}_refresh`,
        expiresAt: Date.now() + 5 * 60_000,
        chatgptAccountId: `${id}_acc`,
      });
    }
    const headers = new Headers({
      "session-id": "failure-desktop-session",
      "thread-id": "failure-desktop-thread",
    });
    const first = await resolveCodexAuthContext(headers, cfg, "pool");
    if (first.kind !== "pool") throw new Error("expected pool context");
    expect(first.accountId).toBe("pool-a");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordCodexUpstreamOutcome(cfg, "pool-a", 500, {
        now: 1_800_000_000_000 + attempt,
        threadId: first.affinityKey,
      });
    }
    const rebound = await resolveCodexAuthContext(headers, cfg, "pool");
    expect(rebound).toMatchObject({ kind: "pool", accountId: "pool-b" });

    recordCodexUpstreamOutcome(cfg, "pool-a", 500, {
      now: 1_800_000_000_100,
      threadId: first.affinityKey,
    });
    clearCodexUpstreamHealth();
    cfg.activeCodexAccountId = "pool-a";
    await expect(resolveCodexAuthContext(headers, cfg, "pool"))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
  });

  test("selection order never bypasses an exact account selector", async () => {
    // Regression: `codexAccountPriorities` narrows the pool to the highest tier, but it
    // is an ordering boundary over the pool path only. A request that names an account
    // exactly must resolve to exactly that account, no matter how another account is
    // ordered — otherwise the selector itself would be overridden by routing metadata.
    const cfg = config();
    cfg.activeCodexAccountId = "pool-b";
    cfg.codexAccountPriorities = { "pool-b": 2, "pool-a": 1 };
    // A live pin is the stronger case than priority alone: `selectPriorityTier`
    // treats it as a hard ceiling and `pickPriorityPreemption` returns null while
    // it has headroom. An exact selector must bypass it all the same.
    cfg.activeCodexAccountPinned = "pool-b";
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });

    // The pool path honors the order: pool-b outranks pool-a, so an unbound request
    // prefers pool-b.
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", { modelId: "gpt-5.5" }))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });

    // An exact selector names pool-a: it must resolve to pool-a even though pool-b is
    // ordered earlier. Selection order is a tiebreak inside the eligible pool, never a
    // way to redirect a request that already named its account.
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      accountId: "pool-a",
      modelId: "gpt-5.5",
    })).resolves.toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      accessToken: "pool_a_token",
      chatgptAccountId: "pool_a_acc",
      fixedAccount: true,
    });
    expect(cfg.activeCodexAccountId).toBe("pool-b");
    // An exact selector must not release an operator pin either.
    expect(cfg.activeCodexAccountPinned).toBe("pool-b");
  });

  test("exact main-account resolution reads auth.json without consulting the active Pool account", async () => {
    const cfg = config();
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      tokens: { access_token: "opaque-live-main-token", account_id: "main-chatgpt-account" },
    }));

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      accountId: MAIN_CODEX_ACCOUNT_ID,
      modelId: "gpt-5.5",
    })).resolves.toMatchObject({
      kind: "main-pool",
      accountId: MAIN_CODEX_ACCOUNT_ID,
      accessToken: "opaque-live-main-token",
      chatgptAccountId: "main-chatgpt-account",
      fixedAccount: true,
    });
    expect(cfg.activeCodexAccountId).toBe("pool-a");
  });

  test("uses a validated native caller bearer for main without persisting it", async () => {
    const cfg = config();
    cfg.codexAccounts = [];
    cfg.activeCodexAccountId = undefined;
    const authPath = join(testDir, "auth.json");
    const originalAuth = JSON.stringify({
      tokens: {
        access_token: expiredJwt(),
        refresh_token: "operator-refresh-token",
        account_id: "operator-main-account",
      },
    });
    writeFileSync(authPath, originalAuth);
    const inbound = new Headers({
      authorization: "Bearer caller-keyring-token",
      "chatgpt-account-id": "caller-keyring-account",
      "openai-beta": "responses=experimental",
    });
    // This assertion is about request isolation, not config-generation reconciliation.
    // Use a definitely-current writer so earlier tests cannot make the setup a no-op.
    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID, Number.MAX_SAFE_INTEGER);
    let operatorRefreshes = 0;

    try {
      expect(hasForwardableCodexBearer(inbound, cfg)).toBe(true);
      expect(hasForwardableCodexBearer(new Headers({
        authorization: ["Bearer ocx", "data", "not-forwardable"].join("_"),
        "chatgpt-account-id": "caller-keyring-account",
      }), cfg)).toBe(false);
      const ctx = await resolveCodexAuthContext(inbound, cfg, "pool", {
        requestScopedMainCredential: true,
        nativeMainRefreshDependencies: {
          refreshToken: async () => {
            operatorRefreshes += 1;
            return {
              access: "wrong-refreshed-access",
              refresh: "wrong-rotated-refresh",
              expires: Date.now() + 3_600_000,
              accountId: "operator-main-account",
            };
          },
        },
      });
      expect(ctx).toMatchObject({
        kind: "main",
        accountId: null,
      });
      expect(ctx).not.toHaveProperty("accessToken");
      expect(ctx).not.toHaveProperty("chatgptAccountId");
      expect(ctx).not.toHaveProperty("affinityKey");
      expect(ctx).not.toHaveProperty("writerGeneration");

      const upstream = materializeCodexUpstreamAuth(inbound, ctx);
      expect(upstream.get("authorization")).toBe("Bearer caller-keyring-token");
      expect(upstream.get("chatgpt-account-id")).toBe("caller-keyring-account");
      expect(upstream.get("openai-beta")).toBe("responses=experimental");
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
      expect(operatorRefreshes).toBe(0);
      expect(readFileSync(authPath, "utf8")).toBe(originalAuth);
    } finally {
      clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    }
  });

  async function resolveRequestOwnedMainPinCase(options: {
    mainWeeklyPercent: number;
    poolWeeklyPercent: number;
    callerEntitled: boolean;
  }): Promise<{
    cfg: OcxConfig;
    context: Awaited<ReturnType<typeof resolveCodexAuthContext>>;
    directEntitlementChecks: number;
  }> {
    const cfg = config();
    cfg.accountPoolStrategy = "quota";
    cfg.autoSwitchThreshold = 90;
    cfg.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID;
    cfg.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID;
    cfg.codexAccountPriorities = {
      [MAIN_CODEX_ACCOUNT_ID]: 0,
      "pool-a": 0,
    };
    resetCodexRoutingForManualSelection(MAIN_CODEX_ACCOUNT_ID);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-token",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool-account",
    });
    setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, { weeklyPercent: options.mainWeeklyPercent });
    setAccountQuotaFromParsed("pool-a", { weeklyPercent: options.poolWeeklyPercent });
    let directEntitlementChecks = 0;
    const context = await resolveCodexAuthContext(new Headers({
      authorization: "Bearer caller-keyring-token",
      "chatgpt-account-id": "caller-keyring-account",
    }), cfg, "pool", {
      requestScopedMainCredential: true,
      modelId: "gpt-5.6-sol",
      isDirectCallerEntitledToCodexModel: async () => {
        directEntitlementChecks += 1;
        return options.callerEntitled;
      },
      resolveCodexModelEntitlements: async () => ({
        modelsByAccount: new Map([["pool-a", new Set(["gpt-5.6-sol"])]]),
        clientVersionByAccount: new Map([["pool-a", "0.150.1"]]),
        confirmedAccountIds: new Set(["pool-a"]),
        credentialIdentities: new Map([["pool-a", "pool:1:pool-account"]]),
      }),
    });
    return { cfg, context, directEntitlementChecks };
  }

  test("a healthy manual main pin keeps the validated caller bearer ahead of an exhausted pool account (#3157)", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 16,
      poolWeeklyPercent: 100,
      callerEntitled: true,
    });
    expect(context).toMatchObject({ kind: "main", accountId: null });
    expect(directEntitlementChecks).toBe(1);
    expect(cfg.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("an exhausted request-owned main pin still yields to the healthy Pool account (#3157)", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 100,
      poolWeeklyPercent: 16,
      callerEntitled: true,
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(directEntitlementChecks).toBe(0);
    expect(cfg.activeCodexAccountId).toBe("pool-a");
    expect(cfg.activeCodexAccountPinned).toBeUndefined();
  });

  test("a caller entitlement miss uses a Pool model detour without clearing the healthy main pin (#3157)", async () => {
    const { cfg, context, directEntitlementChecks } = await resolveRequestOwnedMainPinCase({
      mainWeeklyPercent: 16,
      poolWeeklyPercent: 20,
      callerEntitled: false,
    });
    expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(directEntitlementChecks).toBe(1);
    expect(cfg.activeCodexAccountId).toBe(MAIN_CODEX_ACCOUNT_ID);
    expect(cfg.activeCodexAccountPinned).toBe(MAIN_CODEX_ACCOUNT_ID);
  });

  test("a failed Pool account may fall back once to the validated caller-owned main credential", async () => {
    const cfg = config();
    cfg.codexAccounts = [
      { id: "pool-a", email: "pool-a@example.test", isMain: false, chatgptAccountId: "pool-account" },
    ];
    const inbound = new Headers({
      authorization: "Bearer caller-keyring-token",
      "chatgpt-account-id": "caller-keyring-account",
    });
    const emptyEntitlements: CodexModelEntitlementSnapshot = {
      modelsByAccount: new Map(),
      confirmedAccountIds: new Set(),
      credentialIdentities: new Map(),
    };
    let directEntitlementChecks = 0;
    const options = {
      requestScopedMainCredential: true,
      modelId: "gpt-daybreak-blue-latest",
      resolveCodexModelEntitlements: async () => emptyEntitlements,
      isDirectCallerEntitledToCodexModel: async () => {
        directEntitlementChecks += 1;
        return true;
      },
    };

    await expect(resolveCodexAuthContext(inbound, cfg, "pool", {
      ...options,
      excludeAccountId: "pool-a",
    })).resolves.toMatchObject({ kind: "main", accountId: null });
    expect(directEntitlementChecks).toBe(1);

    // If main itself was the failed credential, the retry must not loop back to it.
    await expect(resolveCodexAuthContext(inbound, { ...cfg, codexAccounts: [] }, "pool", {
      ...options,
      excludeAccountId: MAIN_CODEX_ACCOUNT_ID,
    })).rejects.toThrow("Codex accounts that support this model are currently unavailable");
    expect(directEntitlementChecks).toBe(1);
  });

  test("selects pool auth independently of the routed provider", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });

    const ctx = await resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool");

    expect(ctx).toMatchObject({
      kind: "pool",
      accountId: "pool-a",
      generation: 1,
      accessToken: "pool_token",
      chatgptAccountId: "pool_acc",
    });
  });

  test("exclusion selects another eligible account without changing the active account", async () => {
    const cfg = config();
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      excludeAccountId: "pool-a",
    })).resolves.toMatchObject({
      kind: "pool",
      accountId: "pool-b",
      accessToken: "pool_b_token",
      chatgptAccountId: "pool_b_acc",
    });
    expect(cfg.activeCodexAccountId).toBe("pool-a");
  });

  test("exclusion fails closed when no alternate account is eligible", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });

    await expect(resolveCodexAuthContext(
      new Headers({ authorization: "Bearer caller_token" }),
      config(),
      "pool",
      { excludeAccountId: "pool-a" },
    )).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
  });

  test("pause excludes new pool and exact selection without invalidating an in-flight context", async () => {
    const cfg = config();
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });

    const captured = await resolveCodexAuthContext(new Headers(), cfg, "pool");
    expect(captured).toMatchObject({ kind: "pool", accountId: "pool-a" });

    cfg.pausedCodexAccountIds = ["pool-a"];

    expect(isCodexAuthContextUsable(captured, cfg)).toBe(true);
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      accountId: "pool-a",
      modelId: "gpt-5.5",
    })).rejects.toThrow("Selected Codex account is unavailable");
    expect(cfg.activeCodexAccountId).toBe("pool-a");
    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool"))
      .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
  });

  test("exact selection reports reauthentication without falling back to the active Pool account", async () => {
    const cfg = config();
    cfg.activeCodexAccountId = "pool-b";
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });
    markAccountNeedsReauth("pool-a");

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      accountId: "pool-a",
      modelId: "gpt-5.5",
    })).rejects.toThrow("Selected Codex account needs reauthentication");
    expect(cfg.activeCodexAccountId).toBe("pool-b");
  });

  test("exact account failure never falls back to another usable account", async () => {
    const cfg = config();
    cfg.codexAccounts?.push({ id: "pool-b", email: "pool-b@example.test", isMain: false });
    saveCodexAccountCredential("pool-b", {
      accessToken: "pool_b_token",
      refreshToken: "pool_b_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_b_acc",
    });

    await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
      accountId: "pool-a",
      modelId: "gpt-5.5",
    })).rejects.toThrow("Selected Codex account is unavailable");
    expect(cfg.activeCodexAccountId).toBe("pool-a");
  });

  test("exact account never consumes a quota recovery probe", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_a_token",
      refreshToken: "pool_a_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_a_acc",
    });
    try {
      Date.now = () => now;
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        resetAt: Math.floor((now + 60 * 60_000) / 1_000),
        now,
        modelId: "gpt-5.5",
        fixedAccount: true,
      });
      Date.now = () => now + CODEX_QUOTA_PROBE_INTERVAL_MS;

      await expect(resolveCodexAuthContext(new Headers(), cfg, "pool", {
        accountId: "pool-a",
        modelId: "gpt-5.5",
      })).rejects.toBeInstanceOf(CodexAccountCooldownError);

      const ordinaryProbe = await resolveCodexAuthContext(new Headers(), cfg, "pool", {
        modelId: "gpt-5.5",
      });
      expect(ordinaryProbe).toMatchObject({ kind: "pool", accountId: "pool-a" });
      expect(ordinaryProbe.kind === "pool" ? ordinaryProbe.probeLeaseId : undefined).toBeTruthy();
    } finally {
      Date.now = originalNow;
    }
  });


  test("an admission bearer on main substitutes the stored credential, never forwards it (#1686)", () => {
    // The caller proved admission with one of OUR secrets. That secret must never leave the
    // process, so the only acceptable outcome is the stored main credential in its place.
    const admissionSecret = "ocx_data_localsecret";
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      tokens: { access_token: liveJwt(), account_id: "stored_main_acc" },
    }));

    const headers = materializeCodexUpstreamAuth(
      new Headers({ authorization: `Bearer ${admissionSecret}`, "openai-beta": "responses=experimental" }),
      { kind: "main", accountId: null },
      { substituteMainCredential: true },
    );

    expect(headers.get("authorization")).not.toContain(admissionSecret);
    expect(headers.get("authorization")).toBe(`Bearer ${liveJwt()}`);
    expect(headers.get("chatgpt-account-id")).toBe("stored_main_acc");
    // Unrelated forwarded headers still ride along.
    expect(headers.get("openai-beta")).toBe("responses=experimental");
  });

  test("substitution fails closed when no usable main credential exists (#1686)", () => {
    // Falling through here would forward the admission secret upstream, which is exactly
    // the leak the forward guard exists to prevent. Throw before any I/O instead.
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({ tokens: {} }));

    expect(() => materializeCodexUpstreamAuth(
      new Headers({ authorization: "Bearer ocx_data_localsecret" }),
      { kind: "main", accountId: null },
      { substituteMainCredential: true },
    )).toThrow(CodexMainSubstitutionUnavailableError);
  });

  test("a dedicated-header main caller keeps its own bearer as passthrough (#1686)", () => {
    // Without the substitution flag this is the user's own ChatGPT credential on the
    // canonical forward provider, and rewriting it would break Direct.
    const headers = materializeCodexUpstreamAuth(
      new Headers({ authorization: "Bearer user_chatgpt_token" }),
      { kind: "main", accountId: null },
    );
    expect(headers.get("authorization")).toBe("Bearer user_chatgpt_token");
  });
  test("selected pool headers replace inbound main auth", () => {
    const headers = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main_token", "chatgpt-account-id": "main_acc", "openai-beta": "responses=experimental" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    );

    expect(headers.get("authorization")).toBe("Bearer pool_token");
    expect(headers.get("chatgpt-account-id")).toBe("pool_acc");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
  });

  test("pool token failure marks reauth and throws before fallback", async () => {
    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
      .rejects.toBeInstanceOf(CodexAuthContextError);
    expect(isAccountNeedsReauth("pool-a")).toBe(true);
  });

  test("pool token failure error message does not expose local account id", async () => {
    try {
      await resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool");
      throw new Error("expected auth context failure");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAuthContextError);
      expect((err as Error).message).not.toContain("pool-a");
    }
  });

  test("cooled single pool account fails closed instead of falling back to inbound main auth", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config(), "pool-a", 429, { retryAfter: "60", now });

    await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
      .rejects.toBeInstanceOf(CodexAccountCooldownError);
  });

  test("reset-derived cooldown admits one probe and clears on its success (#433)", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    // Keep the credential valid against the frozen clock, not the wall clock —
    // otherwise the probe path tries a real token refresh.
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const headers = new Headers({ authorization: "Bearer main_token" });
    try {
      // Upstream announces a reset four days out; the account actually recovers early.
      const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
      Date.now = () => now;
      recordCodexUpstreamOutcome(config(), "pool-a", 429, { resetAt, now });

      // Before the probe interval the account is still short-circuited locally.
      Date.now = () => now + 1_000;
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      // After the interval exactly one request is admitted, carrying the lease.
      const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
      Date.now = () => probeAt;
      const probeCtx = await resolveCodexAuthContext(headers, config(), "pool");
      expect(probeCtx).toMatchObject({ kind: "pool", accountId: "pool-a" });
      const probeLeaseId = (probeCtx as { probeLeaseId?: string }).probeLeaseId;
      expect(probeLeaseId).toBeTruthy();
      // The admitted request must not be blocked again downstream.
      expect(() => assertCodexAuthContextNotCooled(probeCtx)).not.toThrow();

      // A second concurrent request still gets the cooldown.
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      // The probe succeeds: the account is proven healthy and routes normally again.
      recordCodexUpstreamOutcome(config(), "pool-a", 200, { now: probeAt + 500, probeLeaseId });
      Date.now = () => probeAt + 500;
      await expect(resolveCodexAuthContext(headers, config(), "pool")).resolves.toMatchObject({
        kind: "pool",
        accountId: "pool-a",
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("reset-derived native cooldowns stay within their confirmed quota group", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    const headers = new Headers({ authorization: "Bearer main_token" });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    try {
      Date.now = () => now;
      const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1000);
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.3-codex-spark",
      });

      // Spark owns a separate quota, so Terra can use the same account.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.4" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.4",
      });

      // Terra and Luna stay in the shared native quota group, while Spark keeps
      // its independent cooldown instead of being overwritten by Terra's 429.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.4-mini" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);

      // An explicit retry directive is still account-wide, regardless of the
      // originating model's otherwise independent quota group.
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        retryAfter: "60",
        modelId: "gpt-5.3-codex-spark",
      });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.4" }))
        .rejects.toBeInstanceOf(CodexAccountCooldownError);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a scoped cooldown uses another account without moving the independent native scope", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    cfg.codexAccounts?.push({
      id: "pool-b",
      email: "pool-b@example.test",
      isMain: false,
      chatgptAccountId: "pool_b_acc",
    });
    const headers = new Headers({
      authorization: "Bearer main_token",
      "x-codex-parent-thread-id": "independent-scope-thread",
    });
    for (const accountId of ["pool-a", "pool-b"]) {
      saveCodexAccountCredential(accountId, {
        accessToken: `${accountId}-token`,
        refreshToken: `${accountId}-refresh`,
        expiresAt: now + 24 * 60 * 60_000,
        chatgptAccountId: `${accountId}-acc`,
      });
    }
    try {
      Date.now = () => now;
      // Establish the shared-scope binding first. The Spark fallback below must
      // create a second binding rather than replacing this one.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.4" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });

      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt: Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000),
        modelId: "gpt-5.3-codex-spark",
      });

      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
      expect(cfg.activeCodexAccountId).toBe("pool-a");
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.4" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      // This second Spark request proves routing retained the peer choice for
      // the Spark affinity instead of relying on an auth-layer substitution.
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-b" });
    } finally {
      Date.now = originalNow;
    }
  });

  test("a successful Spark recovery probe leaves the shared native cooldown intact", async () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const cfg = config();
    const headers = new Headers({ authorization: "Bearer main_token" });
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 24 * 60 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    try {
      Date.now = () => now;
      const resetAt = Math.floor((now + 4 * 24 * 60 * 60_000) / 1_000);
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.3-codex-spark",
      });
      recordCodexUpstreamOutcome(cfg, "pool-a", 429, {
        now,
        resetAt,
        modelId: "gpt-5.4",
      });

      const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS;
      Date.now = () => probeAt;
      const sparkProbe = await resolveCodexAuthContext(headers, cfg, "pool", {
        modelId: "gpt-5.3-codex-spark",
      });
      expect(sparkProbe).toMatchObject({
        kind: "pool",
        probeQuotaScope: "spark",
      });

      recordCodexUpstreamOutcome(cfg, "pool-a", 200, {
        now: probeAt + 1,
        modelId: "gpt-5.3-codex-spark",
        probeLeaseId: (sparkProbe as { probeLeaseId?: string }).probeLeaseId,
        probeQuotaScope: (sparkProbe as { probeQuotaScope?: "spark" }).probeQuotaScope,
      });

      Date.now = () => probeAt + 1;
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.3-codex-spark" }))
        .resolves.toMatchObject({ kind: "pool", accountId: "pool-a" });
      await expect(resolveCodexAuthContext(headers, cfg, "pool", { modelId: "gpt-5.4-mini" }))
        .resolves.toMatchObject({ kind: "pool", probeQuotaScope: "shared" });
    } finally {
      Date.now = originalNow;
    }
  });

  test("expired thread affinity fails closed instead of falling back to main auth", async () => {
    const now = 1_800_000_000_000;
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: now + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    const originalNow = Date.now;
    const headers = new Headers({
      authorization: "Bearer main_token",
      "x-codex-parent-thread-id": "expired-auth-context",
    });
    try {
      Date.now = () => now;
      await expect(resolveCodexAuthContext(headers, config(), "pool")).resolves.toMatchObject({
        kind: "pool",
        accountId: "pool-a",
      });

      Date.now = () => now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1;
      await expect(resolveCodexAuthContext(headers, config(), "pool"))
        .rejects.toBeInstanceOf(CodexThreadAffinityExpiredError);
    } finally {
      Date.now = originalNow;
    }
  });

  test("cached pool auth context is rejected while cooled and accepted after expiry", () => {
    const originalNow = Date.now;
    const now = 1_800_000_000_000;
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    try {
      recordCodexUpstreamOutcome(config(), "pool-a", 429, { retryAfter: "60", now });
      Date.now = () => now + 1_000;
      expect(() => assertCodexAuthContextNotCooled(ctx)).toThrow(CodexAccountCooldownError);

      Date.now = () => now + 61_000;
      expect(() => assertCodexAuthContextNotCooled(ctx)).not.toThrow();
      expect(() => assertCodexAuthContextNotCooled({ kind: "main", accountId: null })).not.toThrow();
    } finally {
      Date.now = originalNow;
    }
  });

  test("generation conflict does not mark account as reauth-needed", async () => {
    saveCodexAccountCredential("pool-a", {
      accessToken: "old_token",
      refreshToken: "old_refresh",
      expiresAt: 0,
      chatgptAccountId: "pool_acc",
    });
    const replacement = {
      accessToken: "replacement_token",
      refreshToken: "replacement_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      saveCodexAccountCredential("pool-a", replacement);
      return new Response(JSON.stringify({ access_token: "stale_token", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(resolveCodexAuthContext(new Headers({ authorization: "Bearer main_token" }), config(), "pool"))
        .rejects.toBeInstanceOf(CodexAuthContextError);
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
      expect(getCodexAccountCredential("pool-a")).toEqual(replacement);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Codex transient refresh errors are classified as retryable", () => {
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialGenerationConflictError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialRefreshLockTimeoutError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialRefreshBusyError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new CodexCredentialRefreshStaleError())).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new ConfigMutationLockError("busy"))).toBe(false);
    expect(shouldMarkAccountNeedsReauthForCodexAuthFailure(new Error("bad token"))).toBe(true);
  });

  test("busy and stale Codex refresh failures do not mark the auth-context account for reauth", async () => {
    const originalFetch = globalThis.fetch;
    let releaseBusy!: () => void;
    const busyGate = new Promise<void>(resolve => { releaseBusy = resolve; });
    let busyFetches = 0;
    globalThis.fetch = (async () => {
      busyFetches += 1;
      await busyGate;
      return Response.json({ access_token: "busy-fresh", expires_in: 3600 });
    }) as typeof fetch;

    const admitted: Promise<unknown>[] = [];
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      for (let index = 0; index < 32; index += 1) {
        const id = `busy-${index}`;
        saveCodexAccountCredential(id, {
          accessToken: `old-${index}`,
          refreshToken: `refresh-${index}`,
          expiresAt: 0,
          chatgptAccountId: `account-${index}`,
        });
        admitted.push(getValidCodexToken(id));
      }
      await Promise.resolve();
      expect(busyFetches).toBe(32);
      saveCodexAccountCredential("pool-a", {
        accessToken: "pool-old",
        refreshToken: "pool-refresh",
        expiresAt: 0,
        chatgptAccountId: "pool_acc",
      });

      const busyError = await resolveCodexAuthContext(new Headers(), config(), "pool").catch(error => error);
      expect(busyError).toBeInstanceOf(CodexAuthContextError);
      expect((busyError as Error).cause).toBeInstanceOf(CodexCredentialRefreshBusyError);
      expect(isAccountNeedsReauth("pool-a")).toBe(false);

      releaseBusy();
      await Promise.all(admitted);

      saveCodexAccountCredential("pool-a", {
        accessToken: "stale-old",
        refreshToken: "stale-refresh",
        expiresAt: 0,
        chatgptAccountId: "pool_acc",
      });
      let staleFetches = 0;
      globalThis.fetch = (async (_input, init) => {
        staleFetches += 1;
        if (staleFetches === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
        return Response.json({ access_token: "stale-replacement", expires_in: 3600 });
      }) as typeof fetch;

      const staleOwner = resolveCodexAuthContext(new Headers(), config(), "pool");
      while (staleFetches === 0) await Promise.resolve();
      clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
      const replacement = resolveCodexAuthContext(new Headers(), config(), "pool");
      const staleError = await staleOwner.catch(error => error);
      expect(staleError).toBeInstanceOf(CodexAuthContextError);
      expect((staleError as Error).cause).toBeInstanceOf(CodexCredentialRefreshStaleError);
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
      await expect(replacement).resolves.toMatchObject({ accessToken: "stale-replacement" });
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
    } finally {
      clock?.mockRestore();
      releaseBusy();
      await Promise.allSettled(admitted);
      globalThis.fetch = originalFetch;
    }
  });

  test("guardian and quota consumers back off and retry a busy credential refresh without reauth", async () => {
    const originalFetch = globalThis.fetch;
    const now = Date.now();
    const capacity = await occupyCodexRefreshCapacity();
    const cfg = guardianConfig();
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-old",
      refreshToken: "pool-refresh",
      expiresAt: 0,
      chatgptAccountId: "pool_acc",
    });

    try {
      const guardian = await guardianSweep(now);
      expect(guardian.skippedBackoff).toContain("codex:pool-a");
      expect(guardian.failed).not.toContain("codex:pool-a");
      expect(readCodexAccountRecord("pool-a")?.lastCodexValidationStatus).not.toBe("failed");
      expect(isAccountNeedsReauth("pool-a")).toBe(false);

      const request = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
      const response = await handleCodexAuthAPI(request, new URL(request.url), cfg);
      expect(response?.status).toBe(200);
      const body = await response?.json() as { accounts: Array<{ id: string; needsReauth: boolean; quotaProbeSkipped?: boolean }> };
      expect(body.accounts.find(account => account.id === "pool-a")).toMatchObject({
        needsReauth: false,
        quotaProbeSkipped: true,
      });

      capacity.release();
      await Promise.allSettled(capacity.pending);
      globalThis.fetch = (async () => Response.json({ access_token: "retry-fresh", expires_in: 3600 })) as typeof fetch;
      const retry = await guardianSweep(now + 1_001);
      expect(retry.refreshed).toContain("codex:pool-a");
      expect(retry.skippedBackoff).not.toContain("codex:pool-a");
    } finally {
      capacity.release();
      await Promise.allSettled(capacity.pending);
      globalThis.fetch = originalFetch;
    }
  });

  test("guardian and quota consumers back off and retry a stale credential refresh without reauth", async () => {
    const originalFetch = globalThis.fetch;
    const now = Date.now();
    const cfg = guardianConfig();
    saveCodexAccountCredential("pool-a", {
      accessToken: "stale-old",
      refreshToken: "stale-refresh",
      expiresAt: 0,
      chatgptAccountId: "pool_acc",
    });
    let refreshFetches = 0;
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>(resolve => { releaseReplacement = resolve; });
    let clock: ReturnType<typeof spyOn> | undefined;
    globalThis.fetch = (async (_input, init) => {
      refreshFetches += 1;
      if (refreshFetches === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      if (refreshFetches === 2) await replacementGate;
      return Response.json({ access_token: "replacement-fresh", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const request = new Request("http://localhost/api/codex-auth/accounts?refresh=1");
      const quotaPending = handleCodexAuthAPI(request, new URL(request.url), cfg);
      await waitFor(() => refreshFetches === 1);
      const guardianPending = guardianSweep(now);
      await Promise.resolve();

      clock = spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
      const replacement = getValidCodexToken("pool-a");
      const [guardian, response] = await Promise.all([guardianPending, quotaPending]);
      releaseReplacement();
      await expect(replacement).resolves.toMatchObject({ accessToken: "replacement-fresh" });

      expect(guardian.skippedBackoff).toContain("codex:pool-a");
      expect(guardian.failed).not.toContain("codex:pool-a");
      expect(readCodexAccountRecord("pool-a")?.lastCodexValidationStatus).not.toBe("failed");
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
      expect(response?.status).toBe(200);
      const body = await response?.json() as { accounts: Array<{ id: string; needsReauth: boolean; quotaProbeSkipped?: boolean }> };
      expect(body.accounts.find(account => account.id === "pool-a")).toMatchObject({
        needsReauth: false,
        quotaProbeSkipped: true,
      });

      clock.mockRestore();
      clock = undefined;
      saveCodexAccountCredential("pool-a", {
        accessToken: "retry-old",
        refreshToken: "retry-refresh",
        expiresAt: 0,
        chatgptAccountId: "pool_acc",
      });
      const retry = await guardianSweep(now + 1_001);
      expect(retry.refreshed).toContain("codex:pool-a");
      expect(retry.skippedBackoff).not.toContain("codex:pool-a");
    } finally {
      releaseReplacement();
      clock?.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ["busy", new CodexCredentialRefreshBusyError()],
    ["stale", new CodexCredentialRefreshStaleError()],
  ])("login returns a retryable response for a %s credential refresh failure", async (_kind, refreshError) => {
    const oauth = await import("../src/oauth");
    const startLogin = spyOn(oauth, "startLoginFlow").mockRejectedValue(refreshError);
    const cfg = config();
    try {
      const request = new Request("http://localhost/api/codex-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "pool-a", reauth: true }),
      });
      const response = await handleCodexAuthAPI(request, new URL(request.url), cfg);
      expect(response?.status).toBe(503);
      expect(response?.headers.get("Retry-After")).toBe("1");
      expect(await response?.json()).toEqual({ error: "server_busy", code: "server_busy" });
      expect(isAccountNeedsReauth("pool-a")).toBe(false);
    } finally {
      startLogin.mockRestore();
    }
  });

  test("runtime provider metadata is applied only to forward provider copies", () => {
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };
    const runtimeForward = applyCodexAuthContextToProvider(forwardProvider, ctx, "pool");
    expect(runtimeForward).toMatchObject({
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    });
    expect(forwardProvider).not.toHaveProperty("_codexAccountOverride");

    const routed = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
    expect(applyCodexAuthContextToProvider(routed, ctx, "pool")).toBe(routed);
    expect(applyCodexAuthContextToProvider(forwardProvider, ctx, "direct")).toBe(forwardProvider);
  });

  test("runtime provider metadata is stripped before persistence", () => {
    const runtimeProvider = {
      ...forwardProvider,
      _codexAccountRequired: true,
      _codexAccountOverride: { accessToken: "pool_token", chatgptAccountId: "pool_acc" },
    };

    const stripped = stripCodexRuntimeProviderFields(runtimeProvider);

    expect(stripped).not.toHaveProperty("_codexAccountRequired");
    expect(stripped).not.toHaveProperty("_codexAccountOverride");
    expect(stripped).toMatchObject(forwardProvider);
  });

  test("auth context usability follows account lifecycle state", () => {
    const cfg = config();
    const ctx = { kind: "pool" as const, accountId: "pool-a", generation: 1, accessToken: "pool_token", chatgptAccountId: "pool_acc" };

    expect(isCodexAuthContextUsable({ kind: "main", accountId: null }, cfg)).toBe(true);
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(false);

    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(true);

    saveCodexAccountCredential("pool-a", {
      accessToken: "replacement_token",
      refreshToken: "replacement_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    expect(isCodexAuthContextUsable(ctx, cfg)).toBe(false);

    const replacementCtx = { ...ctx, generation: 2, accessToken: "replacement_token" };
    expect(isCodexAuthContextUsable(replacementCtx, cfg)).toBe(true);

    removeCodexAccountCredential("pool-a");
    expect(isCodexAuthContextUsable(replacementCtx, cfg)).toBe(false);

    saveCodexAccountCredential("pool-a", {
      accessToken: "pool_token",
      refreshToken: "pool_refresh",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "pool_acc",
    });
    cfg.codexAccounts = cfg.codexAccounts?.filter(account => account.id !== "pool-a");
    expect(isCodexAuthContextUsable({ ...ctx, generation: 4 }, cfg)).toBe(false);
  });
});

// A cooled-down account is the ONLY thing standing between the user and a working
// Codex Desktop, because injected routing has no second path. The refusal therefore has
// to say who is cooled, until when, and how to escape — without leaking the raw id to a
// possibly remote data-plane client.
describe("cooldown error surface", () => {
  test("native-main maintenance identifies OpenCodex instead of upstream capacity", async () => {
    const response = codexMainProfileDrainingResponse();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    const body = await response.json() as { error?: { message?: string; code?: string } };
    expect(body.error).toMatchObject({
      message: CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE,
      code: "server_is_overloaded",
    });
  });

  test("message names the account, deadline, source, and escape command", () => {
    const until = Date.parse("2026-07-26T10:00:00.000Z");
    const err = new CodexAccountCooldownError("acct_9f3c21", until, "reset-derived");

    const message = cooldownErrorMessage(err);

    expect(message).toContain("2026-07-26T10:00:00.000Z");
    expect(message).toContain("reset-derived");
    expect(message).toContain("ocx account clear-cooldown openai <id>");
    // Masked, never raw: /v1/* bodies can reach remote authenticated clients when the
    // proxy binds a non-loopback hostname.
    expect(message).not.toContain("acct_9f3c21");
    expect(message).toContain("account-…3c21");
  });

  test("message identifies a model-scoped cooldown without implying an account-wide block", () => {
    const err = new CodexAccountCooldownError(
      "acct_9f3c21",
      Date.parse("2026-07-26T10:00:00.000Z"),
      "reset-derived",
      "spark",
    );

    const message = cooldownErrorMessage(err);

    expect(message).toContain("Spark quota is cooling down");
    expect(message).not.toContain("Selected Codex account (account-…3c21) is cooling down");
  });

  test("the main login renders as the alias users actually type", () => {
    const err = new CodexAccountCooldownError(MAIN_CODEX_ACCOUNT_ID, Date.now() + 60_000);

    const message = cooldownErrorMessage(err);

    expect(message).toContain("(main)");
    expect(message).not.toContain("__main__");
    // No recorded source falls back to the default label rather than printing undefined.
    expect(message).toContain("source: default");
  });

  test("HTTP form carries a Retry-After the client can act on", async () => {
    const now = 1_800_000_000_000;
    const err = new CodexAccountCooldownError("pool-a", now + 90_000, "retry-after");

    const response = cooldownErrorResponse(err, now);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("90");
    const body = await response.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain("ocx account clear-cooldown");
  });

  test("an already-elapsed cooldown still yields a valid Retry-After", () => {
    const now = 1_800_000_000_000;
    const err = new CodexAccountCooldownError("pool-a", now - 5_000, "default");

    expect(cooldownErrorResponse(err, now).headers.get("Retry-After")).toBe("1");
  });
});

// #2108: a Windows reboot can leave the native-main fence closed until `ocx restart`, and the
// reporter could not tell us WHICH gate reason settled because nothing ever logged it. The 503
// message must stay byte-identical (claude-messages.ts:818 matches it to keep the fence a 503
// instead of remapping to Anthropic 529), and headers never survive to /api/logs, so stdout is
// the only surface that reaches every path this fence fires on.
describe("native-main fence names its gate reason", () => {
  // Reset on BOTH sides: an afterEach only protects tests that run after this file, and the
  // dedup is module state shared with every other file in the same process.
  beforeEach(() => {
    __resetNativeMainFenceReasonLog();
  });

  afterEach(() => {
    __resetNativeMainFenceReasonLog();
  });

  test("the thrown fence carries the settled reason and says so once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fence = blockNativeMainStartupForUnownedServiceHome("ownership-unknown");
    try {
      const err = new CodexMainProfileDrainingError();

      expect(err.reason).toBe("ownership-unknown");
      expect(err.message).toBe(CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE);
      const lines = warn.mock.calls.map(call => call.join(" "));
      expect(lines.filter(line => line.includes("ownership-unknown"))).toHaveLength(1);
      // The homeId is derived from a profile directory path and has no business in a log line.
      expect(lines.join("\n")).not.toContain("homeId");

      // A retrying client must not turn the diagnostic into the noise it was meant to cut.
      new CodexMainProfileDrainingError();
      new CodexMainProfileDrainingError();
      expect(lines.length).toBe(warn.mock.calls.length);
    } finally {
      warn.mockRestore();
      await fence.release();
    }
  });

  test("a different fence reports a different reason, so the value is read and not assumed", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fence = blockNativeMainStartupForUnownedServiceHome("foreign-ownership");
    try {
      expect(new CodexMainProfileDrainingError().reason).toBe("foreign-ownership");
      expect(warn.mock.calls.map(call => call.join(" ")).join("\n")).toContain("foreign-ownership");
    } finally {
      warn.mockRestore();
      await fence.release();
    }
  });

  // The claimMainProfile() site throws the same error for the turn-drain fence, which
  // is NOT the startup gate: the snapshot there reads `ready`. Inventing a reason for it would
  // send the next reboot report chasing a startup gate that never closed.
  test("the turn-drain fence stays silent instead of borrowing a startup reason", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(new CodexMainProfileDrainingError().reason).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
