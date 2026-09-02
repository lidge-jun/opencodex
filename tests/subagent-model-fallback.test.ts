import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySubagentModelFallback,
  buildSubagentModelChain,
  getSubagentQuotaPrimeStateForTests,
  isNativeModelQuotaExhausted,
  isSubagentModelUnavailable,
  maybePrimeSubagentQuota,
  noteSubagentModelFailure,
  readCodexAgentModelFallback,
  resetSubagentModelFallbackStateForTests,
  resolveAgentModelFallbackForPrimary,
  resolveConfiguredModelFallbackForPrimary,
  scanCodexAgentRolesWithTomlModelFallback,
  selectAvailableSubagentModel,
  setSubagentQuotaPrimeForTests,
  subagentFallbackGuidanceText,
} from "../src/codex/subagent-model-fallback";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../src/codex/quota";
import {
  canAcquireCodexQuotaProbeLease,
  canAcquireCodexQuotaScopeProbeLease,
  clearCodexUpstreamHealthForAccount,
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// beforeEach writes three Codex credentials (NTFS ACL harden on Windows). Under
// `bun test --isolate` on a loaded windows-latest runner that can exceed the
// default 5s hook budget (seen as beforeEach/afterEach timeout at ~7.6s).
setDefaultTimeout(30_000);

const savedCodexHome = process.env.CODEX_HOME;
const savedOpencodexHome = process.env.OPENCODEX_HOME;
let testDir: string;

function installPoolCredential(accountId: string, now = Date.now()): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `${accountId}_token`,
    refreshToken: `${accountId}_refresh`,
    expiresAt: now + 24 * 60 * 60_000,
    chatgptAccountId: `${accountId}_acc`,
  });
}

function cfg(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      // Omitted codexAccountMode — canonical openai defaults to pool via routeModel.
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      xai: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://api.x.ai/v1" },
    },
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 80,
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: "pool-a", email: "a@example.test", isMain: false, chatgptAccountId: "pool_a_acc" },
      { id: "account-a", email: "aa@example.test", isMain: false, chatgptAccountId: "aa_acc" },
      { id: "account-b", email: "bb@example.test", isMain: false, chatgptAccountId: "bb_acc" },
    ],
    subagentModelFallback: [
      "gpt-5.6-sol",
      "alibaba-token-plan/qwen3.8-max",
      "kimi/k3",
    ],
    ...overrides,
  };
}

function codexHomeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-subagent-fallback-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  process.env.CODEX_HOME = dir;
  return dir;
}

// Credential writes can hit Windows ACL harden stalls under full-suite isolate
// load (GHA windows-latest: beforeEach/afterEach hook timed out ~7.6s).
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-subagent-fb-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  installPoolCredential("pool-a");
  installPoolCredential("account-a");
  installPoolCredential("account-b");
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("account-a");
  clearAccountNeedsReauth("account-b");
  clearAccountNeedsReauth("main");
}, { timeout: 30_000 });

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (savedOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedOpencodexHome;
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("account-a");
  clearAccountNeedsReauth("account-b");
  clearAccountNeedsReauth("main");
  clearCodexUpstreamHealthForAccount("pool-a");
  clearCodexUpstreamHealthForAccount("account-a");
  clearCodexUpstreamHealthForAccount("account-b");
  removeTreeWithRetry(testDir);
}, { timeout: 30_000 });

describe("subagent model fallback chain", () => {
  test("buildSubagentModelChain dedupes and preserves order", () => {
    expect(buildSubagentModelChain("gpt-5.6-sol", cfg())).toEqual([
      "gpt-5.6-sol",
      "alibaba-token-plan/qwen3.8-max",
      "kimi/k3",
    ]);
    expect(buildSubagentModelChain("kimi/k3", cfg())).toEqual([
      "kimi/k3",
      "gpt-5.6-sol",
      "alibaba-token-plan/qwen3.8-max",
    ]);
    expect(buildSubagentModelChain("work/gpt-5.5", cfg({
      codexAccountNamespaces: { work: "account-a", Work: "account-b" },
      subagentModelFallback: ["Work/gpt-5.5"],
    }))).toEqual(["work/gpt-5.5", "Work/gpt-5.5"]);
    expect(buildSubagentModelChain("work/gpt-5.5", cfg({
      codexAccountNamespaces: { work: "account-a" },
      subagentModelFallback: ["Work/gpt-5.5"],
    }))).toEqual(["work/gpt-5.5", "Work/gpt-5.5"]);
    expect(buildSubagentModelChain("work/gpt-5.5", cfg({
      codexAccountNamespaces: { work: "account-a" },
      subagentModelFallback: ["work/GPT-5.5"],
    }))).toEqual(["work/gpt-5.5"]);
    expect(buildSubagentModelChain("kimi/k3", cfg({
      subagentModelFallback: ["KIMI/K3"],
    }))).toEqual(["kimi/k3"]);
  });

  test("selectAvailableSubagentModel skips quota-exhausted native models", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", cfg());
    expect(selected).toEqual({
      model: "alibaba-token-plan/qwen3.8-max",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("selectAvailableSubagentModel scopes quota exhaustion to the selected account", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("account-a", 95, undefined, 20);
    updateAccountQuota("account-b", 10, undefined, 20);
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", cfg(), [], "account-b");
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: [],
    });
  });

  test("selectAvailableSubagentModel skips cached routed failures", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max", "quota exhausted", cfg());
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", cfg());
    expect(selected.model).toBe("kimi/k3");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max", cfg())).toBe(true);
  });

  test("selectAvailableSubagentModel skips stale fallback entries that cannot route", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg({
        subagentModelFallback: [
          "missing-provider/does-not-exist",
          "kimi/k3",
        ],
      }),
    );
    expect(selected).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol", "missing-provider/does-not-exist"],
    });
  });

  test("selectAvailableSubagentModel admits account selectors and checks their fixed account", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("account-a", 10, undefined, 20);
    const config = cfg({
      codexAccountNamespaces: { team: "account-a" },
      subagentModelFallback: ["team/gpt-5.5", "kimi/k3"],
    });

    expect(isSubagentModelUnavailable("team/gpt-5.5", config, "pool-a")).toBe(false);
    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a")).toEqual({
      model: "team/gpt-5.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("fixed account candidates preserve selectors and enforce per-model entitlements", () => {
    updateAccountQuota("account-a", 10, undefined, 20);
    const config = cfg({ codexAccountNamespaces: { team: "account-a" } });
    const throwingPreview = () => {
      throw new Error("fixed account must not call Pool preview");
    };

    expect(isSubagentModelUnavailable(
      "team/gpt-5.5",
      config,
      "pool-a",
      Date.now(),
      { modelEligibleAccountIds: new Set(["account-a"]) },
      throwingPreview,
      () => undefined,
    )).toBe(false);
    expect(isSubagentModelUnavailable(
      "team/gpt-daybreak-blue-latest",
      config,
      "pool-a",
      Date.now(),
      undefined,
      throwingPreview,
      () => new Set(["account-b"]),
    )).toBe(true);
    expect(isSubagentModelUnavailable(
      "team/gpt-daybreak-blue-latest",
      config,
      "pool-a",
      Date.now(),
      undefined,
      throwingPreview,
      () => new Set(["account-a"]),
    )).toBe(false);
  });

  test("unqualified gated candidates pass their entitlement set into Pool preview", () => {
    const now = 1_800_000_000_000;
    const config = cfg({
      autoSwitchThreshold: 0,
      codexAccountNamespaces: { team: "account-a" },
      subagentModelFallback: ["gpt-daybreak-blue-latest", "xai/grok-4.5"],
    });
    updateAccountQuota("account-a", 10, undefined, 20);
    updateAccountQuota("account-b", 10, undefined, 20);
    noteSubagentModelFailure("team/gpt-5.6-sol", "429", config, "account-a", now);

    const previews: Array<{ modelId: string | undefined; eligible: string[] | undefined }> = [];
    const selected = selectAvailableSubagentModel(
      "team/gpt-5.6-sol",
      config,
      [],
      "account-a",
      now,
      false,
      undefined,
      [],
      (modelId, _previewNow, eligibleAccountIds) => {
        previews.push({
          modelId,
          eligible: eligibleAccountIds ? [...eligibleAccountIds] : undefined,
        });
        return eligibleAccountIds?.has("account-b") ? "account-b" : "account-a";
      },
      modelId => modelId === "gpt-daybreak-blue-latest"
        ? new Set(["account-b"])
        : undefined,
    );

    expect(selected).toEqual({
      model: "gpt-daybreak-blue-latest",
      rewritten: true,
      skipped: ["team/gpt-5.6-sol"],
    });
    expect(previews).toEqual([{
      modelId: "gpt-daybreak-blue-latest",
      eligible: ["account-b"],
    }]);
  });

  test("a null candidate account preview does not fall back to the active Pool account", () => {
    updateAccountQuota("pool-a", 10, undefined, 20);
    const config = cfg({ subagentModelFallback: ["kimi/k3"] });

    expect(selectAvailableSubagentModel(
      "gpt-5.6-sol",
      config,
      [],
      "pool-a",
      Date.now(),
      false,
      undefined,
      [],
      () => null,
    )).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("case-distinct account selector fallbacks remain independent", () => {
    updateAccountQuota("pool-a", 95, undefined, 20);
    const config = cfg({
      codexAccountNamespaces: { work: "account-a", Work: "account-b" },
      pausedCodexAccountIds: ["account-a"],
      subagentModelFallback: ["work/gpt-5.5", "Work/gpt-5.5", "kimi/k3"],
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a")).toEqual({
      model: "Work/gpt-5.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol", "work/gpt-5.5"],
    });
  });

  test("account selector fallback skips a model-scoped cooldown on its fixed account", () => {
    const now = 1_800_000_000_000;
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("account-a", 10, undefined, 20);
    const config = cfg({
      codexAccountNamespaces: { team: "account-a" },
      subagentModelFallback: ["team/gpt-5.5", "kimi/k3"],
    });
    recordCodexUpstreamOutcome(config, "account-a", 429, {
      fixedAccount: true,
      modelId: "gpt-5.5",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", now + 1)).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol", "team/gpt-5.5"],
    });
  });

  test("account selector fallback never uses Pool's account-wide cooldown probe", () => {
    const now = 1_800_000_000_000;
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("account-a", 10, undefined, 20);
    const config = cfg({
      codexAccountNamespaces: { team: "account-a" },
      subagentModelFallback: ["team/gpt-5.5", "kimi/k3"],
    });
    recordCodexUpstreamOutcome(config, "account-a", 429, {
      fixedAccount: true,
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(canAcquireCodexQuotaProbeLease("account-a", probeAt)).toBe(true);
    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", probeAt)).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol", "team/gpt-5.5"],
    });
  });

  test("account selector fallback ignores cooldowns for an unrelated quota scope", () => {
    const now = 1_800_000_000_000;
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("account-a", 10, undefined, 20);
    const config = cfg({
      codexAccountNamespaces: { team: "account-a" },
      subagentModelFallback: ["team/gpt-5.5", "kimi/k3"],
    });
    recordCodexUpstreamOutcome(config, "account-a", 429, {
      fixedAccount: true,
      modelId: "gpt-5.3-codex-spark",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", now + 1)).toEqual({
      model: "team/gpt-5.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("Pool fallback skips a reset-derived cooldown in the model's quota scope", () => {
    const now = 1_800_000_000_000;
    updateAccountQuota("pool-a", 10, undefined, 20);
    const config = cfg({ subagentModelFallback: ["kimi/k3"] });
    recordCodexUpstreamOutcome(config, "pool-a", 429, {
      modelId: "gpt-5.6-sol",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", now + 1)).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("Pool fallback admits a due reset-derived probe in the model's quota scope", () => {
    const now = 1_800_000_000_000;
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    updateAccountQuota("pool-a", 10, undefined, 20);
    const config = cfg({ subagentModelFallback: ["kimi/k3"] });
    recordCodexUpstreamOutcome(config, "pool-a", 429, {
      modelId: "gpt-5.6-sol",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(canAcquireCodexQuotaScopeProbeLease("pool-a", "shared", probeAt)).toBe(true);
    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", probeAt)).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: [],
    });
  });

  test("Pool fallback ignores a reset-derived cooldown for an unrelated quota scope", () => {
    const now = 1_800_000_000_000;
    updateAccountQuota("pool-a", 10, undefined, 20);
    const config = cfg({ subagentModelFallback: ["kimi/k3"] });
    recordCodexUpstreamOutcome(config, "pool-a", 429, {
      modelId: "gpt-5.3-codex-spark",
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", now + 1)).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: [],
    });
  });

  test("Pool fallback preserves account-wide cooldown probe pacing", () => {
    const now = 1_800_000_000_000;
    const probeAt = now + CODEX_QUOTA_PROBE_INTERVAL_MS + 1;
    updateAccountQuota("pool-a", 10, undefined, 20);
    const config = cfg({ subagentModelFallback: ["kimi/k3"] });
    recordCodexUpstreamOutcome(config, "pool-a", 429, {
      now,
      resetAt: Math.floor((now + 60 * 60_000) / 1_000),
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", now + 1).model)
      .toBe("kimi/k3");
    expect(canAcquireCodexQuotaProbeLease("pool-a", probeAt)).toBe(true);
    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a", probeAt).model)
      .toBe("gpt-5.6-sol");
  });

  test("account selector fallbacks still reject invalid or disabled native models", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    updateAccountQuota("account-a", 10, undefined, 20);
    const config = cfg({
      codexAccountNamespaces: { team: "account-a", other: "account-b" },
      subagentModelFallback: ["team/claude-opus-4-6", "kimi/k3"],
    });

    expect(selectAvailableSubagentModel("gpt-5.6-sol", config, [], "pool-a")).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol", "team/claude-opus-4-6"],
    });
    expect(isSubagentModelUnavailable(
      "team/gpt-5.5",
      { ...config, disabledModels: ["gpt-5.5"] },
      "pool-a",
    )).toBe(true);
    expect(isSubagentModelUnavailable(
      "team/gpt-5.5",
      { ...config, disabledModels: ["openai/gpt-5.5"] },
      "pool-a",
    )).toBe(true);
    expect(isSubagentModelUnavailable(
      "team/gpt-5.5",
      { ...config, disabledModels: ["team/gpt-5.5"] },
      "pool-a",
    )).toBe(true);
    expect(isSubagentModelUnavailable(
      "other/gpt-5.5",
      { ...config, disabledModels: ["team/gpt-5.5"] },
      "pool-a",
    )).toBe(false);
  });

  test("noteSubagentModelFailure treats numeric 429 as quota-like", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("kimi/k3", "429", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(true);
  });

  test("noteSubagentModelFailure records generic rate-limit wording as a health block", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("kimi/k3", "Rate limit exceeded. Please try again later.", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(true);

    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("kimi/k3", "Too Many Requests", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(true);

    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("kimi/k3", "provider temporarily rate limited", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(true);
  });

  test("noteSubagentModelFailure ignores unrelated errors", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("kimi/k3", "connection refused", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(false);
    noteSubagentModelFailure("kimi/k3", "invalid_request_error: missing field", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(false);
  });

  test("await maybePrimeSubagentQuota waits for deferred refresh before selection", async () => {
    resetSubagentModelFallbackStateForTests();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let midRefreshModel = "";

    setSubagentQuotaPrimeForTests(async () => {
      midRefreshModel = selectAvailableSubagentModel("gpt-5.6-sol", cfg()).model;
      await gate;
      updateAccountQuota("pool-a", 95, undefined, 20);
    });

    const priming = maybePrimeSubagentQuota(cfg());
    expect(selectAvailableSubagentModel("gpt-5.6-sol", cfg()).model).toBe("gpt-5.6-sol");
    release();
    await priming;
    expect(midRefreshModel).toBe("gpt-5.6-sol");
    expect(selectAvailableSubagentModel("gpt-5.6-sol", cfg()).model).toBe(
      "alibaba-token-plan/qwen3.8-max",
    );
    expect(getSubagentQuotaPrimeStateForTests().primedAt).toBeGreaterThan(0);
    expect(getSubagentQuotaPrimeStateForTests().inFlight).toBe(false);
  });

  test("fenced quota priming does not invoke the injected refresh", async () => {
    resetSubagentModelFallbackStateForTests();
    let calls = 0;
    setSubagentQuotaPrimeForTests(async () => {
      calls += 1;
    });

    await maybePrimeSubagentQuota(cfg(), Date.now(), { nativeMainReadsForbidden: true });

    expect(calls).toBe(0);
    expect(getSubagentQuotaPrimeStateForTests()).toEqual({ primedAt: 0, inFlight: false });
  });

  test("concurrent maybePrimeSubagentQuota callers share one in-flight refresh", async () => {
    resetSubagentModelFallbackStateForTests();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setSubagentQuotaPrimeForTests(async () => {
      calls += 1;
      await gate;
      updateAccountQuota("pool-a", 95, undefined, 20);
    });

    const a = maybePrimeSubagentQuota(cfg());
    const b = maybePrimeSubagentQuota(cfg());
    const c = maybePrimeSubagentQuota(cfg());
    expect(getSubagentQuotaPrimeStateForTests().inFlight).toBe(true);
    release();
    await Promise.all([a, b, c]);
    expect(calls).toBe(1);
    expect(selectAvailableSubagentModel("gpt-5.6-sol", cfg()).model).toBe(
      "alibaba-token-plan/qwen3.8-max",
    );
  });

  test("failed quota prime does not mark success TTL and allows retry", async () => {
    resetSubagentModelFallbackStateForTests();
    let calls = 0;
    setSubagentQuotaPrimeForTests(async () => {
      calls += 1;
      throw new Error("prime failed");
    });
    await maybePrimeSubagentQuota(cfg());
    expect(calls).toBe(1);
    expect(getSubagentQuotaPrimeStateForTests().primedAt).toBe(0);
    expect(getSubagentQuotaPrimeStateForTests().inFlight).toBe(false);

    setSubagentQuotaPrimeForTests(async () => {
      calls += 1;
      updateAccountQuota("pool-a", 95, undefined, 20);
    });
    await maybePrimeSubagentQuota(cfg());
    expect(calls).toBe(2);
    expect(getSubagentQuotaPrimeStateForTests().primedAt).toBeGreaterThan(0);
  });

  test("reset clears timestamp, in-flight, and health state", async () => {
    resetSubagentModelFallbackStateForTests();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setSubagentQuotaPrimeForTests(async () => {
      await gate;
      throw new Error("cancelled after reset");
    });
    const priming = maybePrimeSubagentQuota(cfg());
    noteSubagentModelFailure("kimi/k3", "429", cfg());
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(true);
    expect(getSubagentQuotaPrimeStateForTests().inFlight).toBe(true);
    resetSubagentModelFallbackStateForTests();
    expect(getSubagentQuotaPrimeStateForTests()).toEqual({ primedAt: 0, inFlight: false });
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(false);
    release();
    await priming;
    expect(getSubagentQuotaPrimeStateForTests()).toEqual({ primedAt: 0, inFlight: false });
  });

  test("noteSubagentModelFailure records the configured fallback slug", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max", "429", cfg());
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max", cfg())).toBe(true);
    expect(isSubagentModelUnavailable("kimi/k3", cfg())).toBe(false);
  });

  test("selectAvailableSubagentModel can require native-only fallback for encrypted tasks", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg(),
      [],
      "pool-a",
      Date.now(),
      true,
    );
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: ["gpt-5.6-sol", "alibaba-token-plan/qwen3.8-max", "kimi/k3"],
    });
  });

  test("selectAvailableSubagentModel can stay native-only for encrypted spawns", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg(),
      [],
      "pool-a",
      Date.now(),
      true,
    );
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: ["gpt-5.6-sol", "alibaba-token-plan/qwen3.8-max", "kimi/k3"],
    });
  });

  test("direct bare GPT route ignores exhausted retained pool account quota", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const config = cfg({
      activeCodexAccountId: "pool-a",
      autoSwitchThreshold: 80,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      },
      subagentModelFallback: ["kimi/k3"],
    });
    expect(isSubagentModelUnavailable("gpt-5.6-sol", config, "pool-a")).toBe(false);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      config,
      [],
      "pool-a",
    );
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: [],
    });
  });

  test("another pool provider in config does not affect a direct GPT candidate", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const config = cfg({
      activeCodexAccountId: "pool-a",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        "openai-pool": {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
        kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      },
      subagentModelFallback: ["kimi/k3"],
    });
    expect(isNativeModelQuotaExhausted("gpt-5.6-sol", config, "pool-a")).toBe(false);
    expect(isSubagentModelUnavailable("gpt-5.6-sol", config, "pool-a")).toBe(false);
  });

  test("a full burst window makes the native model exhausted only while it holds (#3029)", () => {
    // Subagent fallback reads the same usage score as pool selection, so a stale terminal
    // reading pushes subagents off a native model whose five-hour window has already reset.
    // The clock is passed explicitly and deliberately far from wall time: a fixture whose
    // clock matches Date.now() cannot tell a threaded clock from a substituted one.
    const now = 1_700_000_000_000;
    const config = cfg({
      activeCodexAccountId: "pool-a",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      subagentModelFallback: ["kimi/k3"],
    });

    resetSubagentModelFallbackStateForTests();
    clearAccountQuota("pool-a");
    setAccountQuotaFromParsed("pool-a", { shortPercent: 100, shortResetAt: now + 60_000 });
    expect(isNativeModelQuotaExhausted("gpt-5.6-sol", config, "pool-a", now)).toBe(true);

    resetSubagentModelFallbackStateForTests();
    clearAccountQuota("pool-a");
    setAccountQuotaFromParsed("pool-a", { shortPercent: 100, shortResetAt: now - 60_000 });
    expect(isNativeModelQuotaExhausted("gpt-5.6-sol", config, "pool-a", now)).toBe(false);
  });

  test("openai-direct/gpt-5.5 is accepted as encrypted-task fallback when canonical", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const config = cfg({
      activeCodexAccountId: "pool-a",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
        "openai-direct": {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      },
      subagentModelFallback: ["openai-direct/gpt-5.5", "kimi/k3"],
    });
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      config,
      [],
      "pool-a",
      Date.now(),
      true,
    );
    expect(selected).toEqual({
      model: "openai-direct/gpt-5.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("namespaced noncanonical OpenAI-compatible provider is rejected for encrypted tasks", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const config = cfg({
      activeCodexAccountId: "pool-a",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
        "openai-compat": {
          adapter: "openai-responses",
          baseUrl: "https://api.example.com/v1",
          authMode: "key",
          apiKey: "sk-test",
        },
        kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      },
      subagentModelFallback: ["openai-compat/gpt-5.5", "kimi/k3"],
    });
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      config,
      [],
      "pool-a",
      Date.now(),
      true,
    );
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: ["gpt-5.6-sol", "openai-compat/gpt-5.5", "kimi/k3"],
    });
  });

  test("pool quota affects only candidates whose resolved route uses pool mode", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const config = cfg({
      activeCodexAccountId: "pool-a",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
        "openai-direct": {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      },
      subagentModelFallback: ["openai-direct/gpt-5.5", "kimi/k3"],
    });
    expect(isNativeModelQuotaExhausted("gpt-5.6-sol", config, "pool-a")).toBe(true);
    expect(isNativeModelQuotaExhausted("openai-direct/gpt-5.5", config, "pool-a")).toBe(false);
    expect(isNativeModelQuotaExhausted("kimi/k3", config, "pool-a")).toBe(false);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      config,
      [],
      "pool-a",
    );
    expect(selected).toEqual({
      model: "openai-direct/gpt-5.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("omitted openai codexAccountMode still requires a usable pool account", () => {
    resetSubagentModelFallbackStateForTests();
    // Default cfg omits codexAccountMode on openai (defaults to pool via routeModel).
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg({ subagentModelFallback: ["xai/grok-4.5"] }),
      [],
      null,
    );
    expect(selected).toEqual({
      model: "xai/grok-4.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("no usable pool account falls back to XAI", () => {
    resetSubagentModelFallbackStateForTests();
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg({
        activeCodexAccountId: undefined,
        codexAccounts: [{ id: "main", email: "main@example.test", isMain: true }],
        subagentModelFallback: ["xai/grok-4.5"],
      }),
      [],
      null,
    );
    expect(selected).toEqual({
      model: "xai/grok-4.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("reauthentication-required pool account falls back to XAI", () => {
    resetSubagentModelFallbackStateForTests();
    markAccountNeedsReauth("pool-a");
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg({ subagentModelFallback: ["xai/grok-4.5"] }),
      [],
      "pool-a",
    );
    expect(selected).toEqual({
      model: "xai/grok-4.5",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("explicit direct mode remains unaffected by missing pool accounts", () => {
    resetSubagentModelFallbackStateForTests();
    const config = cfg({
      activeCodexAccountId: undefined,
      codexAccounts: [{ id: "main", email: "main@example.test", isMain: true }],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        xai: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://api.x.ai/v1" },
      },
      subagentModelFallback: ["xai/grok-4.5"],
    });
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", config, [], null);
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: [],
    });
  });

  test("noteSubagentModelFailure records failures under the configured fallback slug", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max", "429", cfg(), "pool-a");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max", cfg(), "pool-a")).toBe(true);
    expect(isSubagentModelUnavailable("kimi/k3", cfg(), "pool-a")).toBe(false);
  });

  test("readCodexAgentModelFallback parses multiline TOML arrays", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [",
      "  \"alibaba-token-plan/qwen3.8-max\",",
      "  \"kimi/k3\",",
      "]",
      "",
    ].join("\n"), "utf8");
    expect(readCodexAgentModelFallback("executor", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max",
      "kimi/k3",
    ]);
  });

  test("readCodexAgentModelFallback stops at the model_fallback array terminator", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [",
      "  \"alibaba-token-plan/qwen3.8-max\",",
      "]",
      "tools = [\"search\", \"edit\"]",
      "",
    ].join("\n"), "utf8");
    expect(readCodexAgentModelFallback("executor", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max",
    ]);
  });

  test("selectAvailableSubagentModel skips disabled bare native fallback entries", () => {
    resetSubagentModelFallbackStateForTests();
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg({
        disabledModels: ["gpt-5.6-sol"],
        subagentModelFallback: ["kimi/k3"],
      }),
    );
    expect(selected).toEqual({
      model: "kimi/k3",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("selectAvailableSubagentModel allows raw slash model ids without provider namespaces", () => {
    resetSubagentModelFallbackStateForTests();
    // Health-block the primary model only. A raw vendor/model id still routes through the
    // default provider; it must remain selectable (not rejected as an unknown namespace).
    noteSubagentModelFailure("gpt-5.6-sol", "429", cfg());
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg({
        subagentModelFallback: [
          "anthropic/claude-sonnet-4-6",
          "kimi/k3",
        ],
      }),
    );
    expect(selected).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      rewritten: true,
      skipped: ["gpt-5.6-sol"],
    });
  });

  test("noteSubagentModelFailure scopes routed-provider health globally", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max", "quota exhausted", cfg(), "account-a");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max", cfg(), "account-b")).toBe(true);
  });

  test("applySubagentModelFallback rewrites parsed request model", () => {
    updateAccountQuota("pool-a", 95);
    const parsed = {
      modelId: "gpt-5.6-sol",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-sol" },
    };
    const result = applySubagentModelFallback(
      parsed as never,
      new Headers({ "x-openai-subagent": "collab_spawn" }),
      cfg(),
    );
    expect(result).toEqual({
      from: "gpt-5.6-sol",
      to: "alibaba-token-plan/qwen3.8-max",
      skipped: ["gpt-5.6-sol"],
    });
    expect(parsed.modelId).toBe("alibaba-token-plan/qwen3.8-max");
    expect((parsed._rawBody as { model?: string }).model).toBe("alibaba-token-plan/qwen3.8-max");
  });

  test("applySubagentModelFallback is a no-op for main turns", () => {
    updateAccountQuota("pool-a", 95);
    const parsed = {
      modelId: "gpt-5.6-sol",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-sol" },
    };
    expect(applySubagentModelFallback(parsed as never, new Headers(), cfg())).toBeNull();
    expect(parsed.modelId).toBe("gpt-5.6-sol");
  });

  test("role model_fallback preserves case-distinct account selectors", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [",
      "  \"work/gpt-5.5\",",
      "  \"Work/gpt-5.5\",",
      "  \"work/GPT-5.5\",",
      "  \"kimi/k3\",",
      "]",
      "",
    ].join("\n"), "utf8");
    const namespaces = { work: "account-a", Work: "account-b" };
    expect(resolveAgentModelFallbackForPrimary("gpt-5.6-sol", dir, namespaces)).toEqual([
      "work/gpt-5.5",
      "Work/gpt-5.5",
      "kimi/k3",
    ]);
    // Without configured namespaces the slash prefix is treated like a provider id and
    // remains case-insensitive, matching ordinary provider/model de-duplication.
    expect(resolveAgentModelFallbackForPrimary("gpt-5.6-sol", dir)).toEqual([
      "work/gpt-5.5",
      "kimi/k3",
    ]);
  });

  test("applySubagentModelFallback can use per-agent model_fallback without global config", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"alibaba-token-plan/qwen3.8-max\"]",
      "",
    ].join("\n"), "utf8");
    updateAccountQuota("pool-a", 95);
    const parsed = {
      modelId: "gpt-5.6-sol",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-sol" },
    };
    const result = applySubagentModelFallback(
      parsed as never,
      new Headers({ "x-openai-subagent": "collab_spawn" }),
      cfg({ subagentModelFallback: undefined }),
    );
    expect(result?.to).toBe("alibaba-token-plan/qwen3.8-max");
    expect(resolveAgentModelFallbackForPrimary("gpt-5.6-sol", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max",
    ]);
    expect(readCodexAgentModelFallback("executor", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max",
    ]);
  });

  test("config-keyed per-model fallback resolves for the primary model", () => {
    const config = cfg({
      subagentModelFallbackByModel: {
        "gpt-5.6-sol": ["alibaba-token-plan/qwen3.8-max", "kimi/k3"],
        "other-model": ["xai/grok-4.5"],
      },
    });
    expect(resolveConfiguredModelFallbackForPrimary("gpt-5.6-sol", config)).toEqual([
      "alibaba-token-plan/qwen3.8-max",
      "kimi/k3",
    ]);
    expect(resolveConfiguredModelFallbackForPrimary("other-model", config)).toEqual([
      "xai/grok-4.5",
    ]);
    expect(resolveConfiguredModelFallbackForPrimary("unlisted", config)).toEqual([]);
  });

  test("config-keyed fallback dedupes across keys and preserves account-selector case", () => {
    const config = cfg({
      codexAccountNamespaces: { work: "account-a", Work: "account-b" },
      subagentModelFallbackByModel: {
        "gpt-5.6-sol": ["work/gpt-5.5", "Work/gpt-5.5", "work/GPT-5.5", "kimi/k3"],
        "openrouter/anthropic/claude": ["xai/grok-4.5"],
        "openrouter/anthropic-claude": ["kimi/k3", "xai/grok-4.5"],
      },
    });
    expect(resolveConfiguredModelFallbackForPrimary("gpt-5.6-sol", config)).toEqual([
      "work/gpt-5.5",
      "Work/gpt-5.5",
      "kimi/k3",
    ]);
    expect(resolveConfiguredModelFallbackForPrimary("openrouter/anthropic/claude", config)).toEqual([
      "xai/grok-4.5",
      "kimi/k3",
    ]);
  });

  test("applySubagentModelFallback prefers config-keyed chains over TOML model_fallback", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"kimi/k3\"]",
      "",
    ].join("\n"), "utf8");
    updateAccountQuota("pool-a", 95);
    const parsed = {
      modelId: "gpt-5.6-sol",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-sol" },
    };
    const result = applySubagentModelFallback(
      parsed as never,
      new Headers({ "x-openai-subagent": "collab_spawn" }),
      cfg({
        subagentModelFallback: undefined,
        subagentModelFallbackByModel: {
          "gpt-5.6-sol": ["alibaba-token-plan/qwen3.8-max"],
        },
      }),
    );
    expect(result?.to).toBe("alibaba-token-plan/qwen3.8-max");
  });

  test("applySubagentModelFallback orders and dedupes all four fallback stages", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"xai/grok-4.5\", \"KIMI/K3\"]",
      "",
    ].join("\n"), "utf8");
    const config = cfg({
      subagentModelFallbackByModel: {
        "gpt-5.6-sol": ["alibaba-token-plan/qwen3.8-max", "GPT-5.6-SOL"],
      },
      subagentModelFallback: ["kimi/k3", "ALIBABA-TOKEN-PLAN/QWEN3.8-MAX"],
    });
    updateAccountQuota("pool-a", 95);
    for (const model of ["alibaba-token-plan/qwen3.8-max", "kimi/k3", "xai/grok-4.5"]) {
      noteSubagentModelFailure(model, "quota exhausted", config);
    }
    const parsed = {
      modelId: "gpt-5.6-sol",
      options: {},
      context: { messages: [] },
      _rawBody: { model: "gpt-5.6-sol" },
    };
    const result = applySubagentModelFallback(
      parsed as never,
      new Headers({ "x-openai-subagent": "collab_spawn" }),
      config,
    );
    expect(result).toEqual({
      from: "gpt-5.6-sol",
      to: "gpt-5.6-sol",
      skipped: [
        "gpt-5.6-sol",
        "alibaba-token-plan/qwen3.8-max",
        "kimi/k3",
        "xai/grok-4.5",
      ],
    });
  });

  test("scanCodexAgentRolesWithTomlModelFallback reports roles carrying the field, including empty arrays", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "with_fallback.toml"), [
      "name = \"with_fallback\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"kimi/k3\"]",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "empty_fallback.toml"), [
      "name = \"empty_fallback\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = []",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "clean.toml"), [
      "name = \"clean\"",
      "model = \"gpt-5.6-sol\"",
      "",
    ].join("\n"), "utf8");
    expect(scanCodexAgentRolesWithTomlModelFallback(dir).sort()).toEqual([
      "empty_fallback",
      "with_fallback",
    ]);
    expect(readCodexAgentModelFallback("empty_fallback", dir)).toEqual([]);
  });

  test("scanCodexAgentRolesWithTomlModelFallback recognizes quoted model_fallback keys", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "quoted_key.toml"), [
      "name = \"quoted_key\"",
      "model = \"gpt-5.6-sol\"",
      "\"model_fallback\" = [\"kimi/k3\"]",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "literal_key.toml"), [
      "name = \"literal_key\"",
      "model = \"gpt-5.6-sol\"",
      "'model_fallback' = []",
      "",
    ].join("\n"), "utf8");
    expect(scanCodexAgentRolesWithTomlModelFallback(dir).sort()).toEqual([
      "literal_key",
      "quoted_key",
    ]);
    expect(readCodexAgentModelFallback("quoted_key", dir)).toEqual(["kimi/k3"]);
    expect(readCodexAgentModelFallback("literal_key", dir)).toEqual([]);
  });

  test("scanCodexAgentRolesWithTomlModelFallback ignores model_fallback text inside strings", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "multiline_text.toml"), [
      "name = \"multiline_text\"",
      "model = \"gpt-5.6-sol\"",
      "description = \"\"\"",
      "model_fallback = []",
      "\"model_fallback\" = [\"kimi/k3\"]",
      "\"\"\"",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "single_line_text.toml"), [
      "name = \"single_line_text\"",
      "model = \"gpt-5.6-sol\"",
      "description = \"model_fallback = [\\\"kimi/k3\\\"]\"",
      "",
    ].join("\n"), "utf8");
    expect(scanCodexAgentRolesWithTomlModelFallback(dir)).toEqual([]);
    expect(readCodexAgentModelFallback("multiline_text", dir)).toEqual([]);
  });

  test("scanCodexAgentRolesWithTomlModelFallback handles escaped triple quotes inside multiline strings", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "escaped_open.toml"), [
      "name = \"escaped_open\"",
      "model = \"gpt-5.6-sol\"",
      "description = \"\"\"a\\\"\"\"",
      "model_fallback = []",
      "\"\"\"",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "escaped_continuation.toml"), [
      "name = \"escaped_continuation\"",
      "model = \"gpt-5.6-sol\"",
      "description = \"\"\"",
      "still inside \\\"\"\"",
      "model_fallback = []",
      "\"\"\"",
      "",
    ].join("\n"), "utf8");
    expect(scanCodexAgentRolesWithTomlModelFallback(dir)).toEqual([]);
    expect(readCodexAgentModelFallback("escaped_open", dir)).toEqual([]);
    expect(readCodexAgentModelFallback("escaped_continuation", dir)).toEqual([]);
  });

  test("readCodexAgentModelFallback rejects string arrays without proper commas", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "missing_comma.toml"), [
      "name = \"missing_comma\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"kimi/k3\" \"alibaba-token-plan/qwen3.8-max\"]",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "leading_comma.toml"), [
      "name = \"leading_comma\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [, \"kimi/k3\"]",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "trailing_token.toml"), [
      "name = \"trailing_token\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"kimi/k3\"] invalid",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(dir, "agents", "inline_comment.toml"), [
      "name = \"inline_comment\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"kimi/k3\"] # keep",
      "",
    ].join("\n"), "utf8");
    expect(readCodexAgentModelFallback("missing_comma", dir)).toEqual([]);
    expect(readCodexAgentModelFallback("leading_comma", dir)).toEqual([]);
    expect(readCodexAgentModelFallback("trailing_token", dir)).toEqual([]);
    expect(readCodexAgentModelFallback("inline_comment", dir)).toEqual(["kimi/k3"]);
    // Doctor reports every role carrying the field, even when its value is malformed.
    expect(scanCodexAgentRolesWithTomlModelFallback(dir).sort()).toEqual([
      "inline_comment",
      "leading_comma",
      "missing_comma",
      "trailing_token",
    ]);
  });

  test("subagentFallbackGuidanceText renders configured chain", () => {
    expect(subagentFallbackGuidanceText(cfg())).toContain("gpt-5.6-sol");
    expect(subagentFallbackGuidanceText(cfg({ subagentModelFallback: undefined }))).toBe("");
  });
});
