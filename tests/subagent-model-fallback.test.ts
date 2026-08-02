import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  selectAvailableSubagentModel,
  setSubagentQuotaPrimeForTests,
  subagentFallbackGuidanceText,
} from "../src/codex/subagent-model-fallback";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../src/codex/account-runtime-state";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/quota";
import type { OcxConfig } from "../src/types";

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
      openai: { adapter: "openai-responses" },
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
      "alibaba-token-plan/qwen3.8-max-preview",
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
  rmSync(testDir, { recursive: true, force: true });
}, { timeout: 30_000 });

describe("subagent model fallback chain", () => {
  test("buildSubagentModelChain dedupes and preserves order", () => {
    expect(buildSubagentModelChain("gpt-5.6-sol", cfg())).toEqual([
      "gpt-5.6-sol",
      "alibaba-token-plan/qwen3.8-max-preview",
      "kimi/k3",
    ]);
    expect(buildSubagentModelChain("kimi/k3", cfg())).toEqual([
      "kimi/k3",
      "gpt-5.6-sol",
      "alibaba-token-plan/qwen3.8-max-preview",
    ]);
  });

  test("selectAvailableSubagentModel skips quota-exhausted native models", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("pool-a", 95, undefined, 20);
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", cfg());
    expect(selected).toEqual({
      model: "alibaba-token-plan/qwen3.8-max-preview",
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
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "quota exhausted", cfg());
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", cfg());
    expect(selected.model).toBe("kimi/k3");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg())).toBe(true);
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
      "alibaba-token-plan/qwen3.8-max-preview",
    );
    expect(getSubagentQuotaPrimeStateForTests().primedAt).toBeGreaterThan(0);
    expect(getSubagentQuotaPrimeStateForTests().inFlight).toBe(false);
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
      "alibaba-token-plan/qwen3.8-max-preview",
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
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "429", cfg());
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg())).toBe(true);
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
      skipped: ["gpt-5.6-sol", "alibaba-token-plan/qwen3.8-max-preview", "kimi/k3"],
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
      skipped: ["gpt-5.6-sol", "alibaba-token-plan/qwen3.8-max-preview", "kimi/k3"],
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
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "429", cfg(), "pool-a");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg(), "pool-a")).toBe(true);
    expect(isSubagentModelUnavailable("kimi/k3", cfg(), "pool-a")).toBe(false);
  });

  test("readCodexAgentModelFallback parses multiline TOML arrays", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [",
      "  \"alibaba-token-plan/qwen3.8-max-preview\",",
      "  \"kimi/k3\",",
      "]",
      "",
    ].join("\n"), "utf8");
    expect(readCodexAgentModelFallback("executor", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max-preview",
      "kimi/k3",
    ]);
  });

  test("readCodexAgentModelFallback stops at the model_fallback array terminator", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [",
      "  \"alibaba-token-plan/qwen3.8-max-preview\",",
      "]",
      "tools = [\"search\", \"edit\"]",
      "",
    ].join("\n"), "utf8");
    expect(readCodexAgentModelFallback("executor", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max-preview",
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
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "quota exhausted", cfg(), "account-a");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg(), "account-b")).toBe(true);
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
      to: "alibaba-token-plan/qwen3.8-max-preview",
      skipped: ["gpt-5.6-sol"],
    });
    expect(parsed.modelId).toBe("alibaba-token-plan/qwen3.8-max-preview");
    expect((parsed._rawBody as { model?: string }).model).toBe("alibaba-token-plan/qwen3.8-max-preview");
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

  test("applySubagentModelFallback can use per-agent model_fallback without global config", () => {
    const dir = codexHomeFixture();
    writeFileSync(join(dir, "agents", "executor.toml"), [
      "name = \"executor\"",
      "model = \"gpt-5.6-sol\"",
      "model_fallback = [\"alibaba-token-plan/qwen3.8-max-preview\"]",
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
    expect(result?.to).toBe("alibaba-token-plan/qwen3.8-max-preview");
    expect(resolveAgentModelFallbackForPrimary("gpt-5.6-sol", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max-preview",
    ]);
    expect(readCodexAgentModelFallback("executor", dir)).toEqual([
      "alibaba-token-plan/qwen3.8-max-preview",
    ]);
  });

  test("subagentFallbackGuidanceText renders configured chain", () => {
    expect(subagentFallbackGuidanceText(cfg())).toContain("gpt-5.6-sol");
    expect(subagentFallbackGuidanceText(cfg({ subagentModelFallback: undefined }))).toBe("");
  });
});
