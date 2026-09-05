import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexCooldownRecoveryProbeState,
  runCodexCooldownRecoveryProbes,
} from "../../src/codex/auth-api";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota } from "../../src/codex/quota";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  claimDueCodexQuotaRecoveryProbes,
  clearCodexUpstreamHealth,
  codexQuotaScopeForModel,
  getCodexQuotaHealthSnapshot,
  recordCodexUpstreamOutcome,
  type CodexQuotaScope,
} from "../../src/codex/routing";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const START = 1_800_000_000_000;
const DUE = START + CODEX_QUOTA_PROBE_INTERVAL_MS + 2;
const MODELS = {
  shared: "gpt-5.6-sol",
  spark: "gpt-5.3-codex-spark",
  reserve: "gpt-reserve",
} satisfies Record<CodexQuotaScope, string>;

// Added-account state deliberately exercises the generic worker's claim filter.
// It does not represent an allowed added-account Reserve dispatch.
function makeConfig(): OcxConfig {
  return {
    port: 0,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    defaultProvider: "openai",
    activeCodexAccountId: "reserve-fixture",
    accountPoolStrategy: "fill-first",
    codexAccounts: [{ id: "reserve-fixture", email: "reserve@example.test", plan: "team", isMain: false }],
  } as OcxConfig;
}

function cool(config: OcxConfig, scope: CodexQuotaScope, now = START): void {
  recordCodexUpstreamOutcome(config, "reserve-fixture", 429, {
    modelId: MODELS[scope],
    resetAt: now + 60 * 60_000,
    fixedAccount: true,
    now,
  });
}

describe("Reserve quota scope", () => {
  let directory: string;
  let previousHome: string | undefined;
  let previousCodexHome: string | undefined;
  let previousFetch: typeof fetch;
  let calls: number;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    previousFetch = globalThis.fetch;
    directory = mkdtempSync(join(tmpdir(), "ocx-reserve-quota-scope-"));
    process.env.OPENCODEX_HOME = directory;
    process.env.CODEX_HOME = join(directory, "codex");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
    saveCodexAccountCredential("reserve-fixture", {
      accessToken: "reserve-quota-fixture-access",
      refreshToken: "reserve-quota-fixture-refresh",
      expiresAt: Date.now() + 60 * 60_000,
      chatgptAccountId: "reserve-quota-fixture-account",
    });
    calls = 0;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(new Headers(init?.headers).get("x-openai-codex-luna-reserve")).toBeNull();
      return Response.json({
        plan_type: "team",
        rate_limit: { secondary_window: { used_percent: 10, reset_at: 1_900_000_000 } },
      });
    }, { preconnect: previousFetch.preconnect });
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    // Cancels the quota writer's pending persistence timer before restoring homes.
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearCodexCooldownRecoveryProbeState();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(directory);
  });

  test("maps only the exact Reserve wire model into its independent scope", () => {
    expect(codexQuotaScopeForModel("gpt-reserve")).toBe("reserve");
    expect(codexQuotaScopeForModel(" GPT-RESERVE ")).toBe("reserve");
    expect(codexQuotaScopeForModel("gpt-reserve-preview")).toBe("shared");
    expect(codexQuotaScopeForModel("main/gpt-reserve")).toBe("shared");
    expect(codexQuotaScopeForModel("gpt-5.3-codex-spark")).toBe("spark");
    expect(codexQuotaScopeForModel("gpt-5.6-luna")).toBe("shared");
    expect(codexQuotaScopeForModel(undefined)).toBeUndefined();
  });

  test("shared and Spark reset-derived limits do not imply Reserve exhaustion", () => {
    const config = makeConfig();
    cool(config, "shared");
    cool(config, "spark");
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 1)).toBeNull();
    cool(config, "reserve", START + 1);
    for (const scope of ["shared", "spark", "reserve"] as const) {
      expect(getCodexQuotaHealthSnapshot("reserve-fixture", scope, START + 2)).toMatchObject({
        quotaScope: scope,
        cooldownSource: "reset-derived",
      });
    }
  });

  test.each(["shared", "spark"] as const)("Reserve exhaustion leaves %s quota usable", scope => {
    const config = makeConfig();
    cool(config, "reserve");
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", scope, START + 1)).toBeNull();
  });

  test.each(["retry-after", "default"] as const)("%s remains account-wide and wins over Reserve scope", source => {
    const config = makeConfig();
    cool(config, "reserve");
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, {
      modelId: "gpt-reserve",
      fixedAccount: true,
      now: START + 1,
      ...(source === "retry-after" ? { retryAfter: "60", resetAt: START + 60 * 60_000 } : {}),
    });
    for (const scope of ["shared", "spark", "reserve"] as const) {
      expect(getCodexQuotaHealthSnapshot("reserve-fixture", scope, START + 2)).toEqual({
        cooldownUntil: START + 60_001,
        cooldownSource: source,
      });
    }
    // Expiring the shorter global throttle reveals, rather than erases, Reserve's cooldown.
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 60_002))
      .toMatchObject({ quotaScope: "reserve", cooldownSource: "reset-derived" });
  });

  test("ordinary unleased native success does not clear Reserve health", () => {
    const config = makeConfig();
    cool(config, "reserve");
    const before = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 1);
    expect(before).not.toBeNull();
    for (const modelId of ["gpt-5.6-luna", "gpt-5.3-codex-spark", undefined]) {
      recordCodexUpstreamOutcome(config, "reserve-fixture", 200, { modelId, now: START + 2 });
      expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", START + 3)).toEqual(before);
    }
  });

  test("generic recovery never claims a Reserve-only cooldown or reads upstream", async () => {
    const config = makeConfig();
    cool(config, "reserve");
    expect(claimDueCodexQuotaRecoveryProbes(config, 4, DUE)).toEqual([]);
    await runCodexCooldownRecoveryProbes(config, DUE);
    expect(calls).toBe(0);
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1)).not.toBeNull();
  });

  test("generic recovery still clears an unscoped legacy reset without clearing Reserve", async () => {
    const config = makeConfig();
    cool(config, "reserve");
    recordCodexUpstreamOutcome(config, "reserve-fixture", 429, {
      resetAt: START + 60 * 60_000,
      fixedAccount: true,
      now: START + 1,
    });
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE))
      .toMatchObject({ cooldownSource: "reset-derived" });
    await runCodexCooldownRecoveryProbes(config, DUE);
    expect(calls).toBe(1);
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1))
      .toMatchObject({ quotaScope: "reserve", cooldownSource: "reset-derived" });
  });

  test.each([false, true])("shared WHAM recovery preserves Reserve, older Reserve=%s", async reserveFirst => {
    const config = makeConfig();
    cool(config, reserveFirst ? "reserve" : "shared");
    cool(config, reserveFirst ? "shared" : "reserve", START + 1);
    const before = getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE);
    expect(before).not.toBeNull();
    await runCodexCooldownRecoveryProbes(config, DUE);
    expect(calls).toBe(1);
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "shared", DUE + 1)).toBeNull();
    expect(getCodexQuotaHealthSnapshot("reserve-fixture", "reserve", DUE + 1)).toEqual(before);
  });
});
