import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySubagentModelFallback,
  buildSubagentModelChain,
  isSubagentModelUnavailable,
  noteSubagentModelFailure,
  readCodexAgentModelFallback,
  resetSubagentModelFallbackStateForTests,
  resolveAgentModelFallbackForPrimary,
  selectAvailableSubagentModel,
  subagentFallbackGuidanceText,
} from "../src/codex/subagent-model-fallback";
import { clearAccountQuota, updateAccountQuota } from "../src/codex/quota";
import type { OcxConfig } from "../src/types";

const savedCodexHome = process.env.CODEX_HOME;

function cfg(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: { adapter: "openai-responses" },
      "alibaba-token-plan": { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
      kimi: { adapter: "openai-chat", apiKey: "test", baseUrl: "https://example.invalid" },
    },
    defaultProvider: "openai",
    activeCodexAccountId: "main",
    autoSwitchThreshold: 80,
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

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
});

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
    updateAccountQuota("main", 95, undefined, 20);
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
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "quota exhausted", cfg());
    const selected = selectAvailableSubagentModel("gpt-5.6-sol", cfg());
    expect(selected.model).toBe("kimi/k3");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg())).toBe(true);
  });

  test("selectAvailableSubagentModel skips stale fallback entries that cannot route", () => {
    resetSubagentModelFallbackStateForTests();
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

  test("noteSubagentModelFailure records the configured fallback slug", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "429", cfg());
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg())).toBe(true);
    expect(isSubagentModelUnavailable("qwen3.8-max-preview", cfg())).toBe(false);
  });

  test("selectAvailableSubagentModel can require native-only fallback for encrypted tasks", () => {
    resetSubagentModelFallbackStateForTests();
    updateAccountQuota("main", 95, undefined, 20);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg(),
      [],
      "main",
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
    updateAccountQuota("main", 95, undefined, 20);
    const selected = selectAvailableSubagentModel(
      "gpt-5.6-sol",
      cfg(),
      [],
      "main",
      Date.now(),
      true,
    );
    expect(selected).toEqual({
      model: "gpt-5.6-sol",
      rewritten: false,
      skipped: ["gpt-5.6-sol", "alibaba-token-plan/qwen3.8-max-preview", "kimi/k3"],
    });
  });

  test("noteSubagentModelFailure records failures under the configured fallback slug", () => {
    resetSubagentModelFallbackStateForTests();
    noteSubagentModelFailure("alibaba-token-plan/qwen3.8-max-preview", "429", cfg(), "main");
    expect(isSubagentModelUnavailable("alibaba-token-plan/qwen3.8-max-preview", cfg(), "main")).toBe(true);
    expect(isSubagentModelUnavailable("qwen3.8-max-preview", cfg(), "main")).toBe(false);
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
    updateAccountQuota("main", 95);
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
    updateAccountQuota("main", 95);
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
    updateAccountQuota("main", 95);
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
