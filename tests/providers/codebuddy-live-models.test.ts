import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  fetchCodeBuddyModels,
  parseCodeBuddyHelpRoster,
  setFetchCodeBuddyModelsForTests,
  type CodeBuddyExecFn,
} from "../../src/adapters/codebuddy/live-models";
import { CODEBUDDY_CN_PROFILE, clearCodeBuddyBinaryCache } from "../../src/adapters/codebuddy/profiles";
import { gatherRoutedModels, resetCatalogRuntimeStateForTests } from "../../src/codex/catalog";
import { clearModelCache, setCached } from "../../src/codex/model-cache";
import type { OcxConfig } from "../../src/types";

// The binary-discovery cache is module-level; reset it so one test's injected binary
// cannot mask another test's missing-binary case.
beforeEach(() => clearCodeBuddyBinaryCache());

const ROSTER_LINE = "  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (hy4-preview-f, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3-pay, minimax-m2.7, kimi-k3-2, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro)";

describe("CodeBuddy help-roster parser", () => {
  test("parses the account roster in order", () => {
    const result = parseCodeBuddyHelpRoster(ROSTER_LINE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toHaveLength(16);
      expect(result.models[0]).toBe("hy4-preview-f");
      expect(result.models).toContain("kimi-k3-2");
      expect(result.models).toContain("deepseek-v4.1-flash");
    }
  });

  test("filters custom selectors, blanks, and duplicates", () => {
    const result = parseCodeBuddyHelpRoster("--model <model>  Model for the current session. Please provide the model ID. Currently supported: (kimi-k3-2, custom:mine, kimi-k3-2, )");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual(["kimi-k3-2"]);
  });

  test("a missing roster line fails closed", () => {
    expect(parseCodeBuddyHelpRoster("Usage: codebuddy|cbc [options] [command] [prompt]"))
      .toMatchObject({ ok: false, error: "invalid_output" });
  });

  test("parses a roster line reflowed across multiple lines", () => {
    // The vendor help formatter wraps long descriptions to the terminal width, so the
    // intro sentence and the roster itself can both break across lines.
    const wrapped = [
      "  --model <model>",
      "      Model for the current session. Please provide the",
      "model ID. Currently supported: (glm-5.3, kimi-k3-2,",
      "  hy4-preview-f)",
    ].join("\n");
    const result = parseCodeBuddyHelpRoster(wrapped);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual(["glm-5.3", "kimi-k3-2", "hy4-preview-f"]);
  });

  test("a changed intro sentence still parses", () => {
    const result = parseCodeBuddyHelpRoster("--model <model>  Pick a model. Currently supported: (glm-5.3)");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual(["glm-5.3"]);
  });

  test("an empty roster fails closed", () => {
    expect(parseCodeBuddyHelpRoster("--model <model>  Model for the current session. Please provide the model ID. Currently supported: ()"))
      .toMatchObject({ ok: false, error: "empty" });
  });
});

describe("CodeBuddy live model fetch", () => {
  test("spawns the CLI with the account env and returns the roster", async () => {
    let seenCommand = "";
    let seenArgs: readonly string[] = [];
    let seenEnv: Record<string, string> = {};
    const exec: CodeBuddyExecFn = async (command, args, options) => {
      seenCommand = command;
      seenArgs = args;
      seenEnv = options.env;
      return { stdout: ROSTER_LINE, stderr: "" };
    };
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { which: () => "/usr/bin/codebuddy", exec });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toContain("kimi-k3-2");
    expect(seenCommand).toBe("/usr/bin/codebuddy");
    expect(seenArgs).toEqual(["--help"]);
    expect(seenEnv.CODEBUDDY_API_KEY).toBe("cb-cn-key");
    expect(seenEnv.CODEBUDDY_INTERNET_ENVIRONMENT).toBe("internal");
  });

  test("a missing CLI is a clear error, never a crash", async () => {
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { which: () => undefined });
    expect(result).toMatchObject({ ok: false, error: "cli_not_found" });
  });
});

describe("CodeBuddy catalog cache isolation", () => {
  afterEach(() => {
    setFetchCodeBuddyModelsForTests(null);
    clearModelCache();
    resetCatalogRuntimeStateForTests();
  });

  function codeBuddyConfig(apiKey: string): OcxConfig {
    return {
      providers: {
        "codebuddy-cn": {
          adapter: "codebuddy",
          baseUrl: "https://www.codebuddy.cn",
          authMode: "key",
          apiKey,
          liveModels: true,
          defaultModel: "default",
          // Mirrors the registry seed: the static list ships the vendor default even though
          // the account-scoped --help roster does not print it.
          models: ["default"],
        },
      },
    } as unknown as OcxConfig;
  }

  test("a fetch-failure cooldown for one key does not suppress another key's discovery", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let keyBFetches = 0;
      setFetchCodeBuddyModelsForTests((_profile, apiKey) => {
        if (apiKey === "cb-key-a") return { ok: false, error: "process", detail: "denied" };
        keyBFetches += 1;
        return { ok: true, models: ["roster-b-model"] };
      });

      // Seed a stale (TTL-expired) roster for key B so the cooldown branch is reachable.
      const identityB = createHash("sha256").update("cb-key-b").digest("hex");
      setCached("codebuddy-cn", [{ id: "roster-b-old", provider: "codebuddy-cn" }], Date.now() - 3_600_000, undefined, identityB);

      // Key A fails discovery: the cooldown must be recorded against A's fingerprint only.
      const withA = await gatherRoutedModels(codeBuddyConfig("cb-key-a"));
      expect(withA.filter(m => m.provider === "codebuddy-cn").map(m => m.id)).not.toContain("roster-b-model");

      // Key B still has its own stale roster, but A's cooldown is not B's: discovery must run.
      const withB = await gatherRoutedModels(codeBuddyConfig("cb-key-b"));
      expect(keyBFetches).toBe(1);
      expect(withB.filter(m => m.provider === "codebuddy-cn").map(m => m.id)).toContain("roster-b-model");
    } finally {
      warn.mockRestore();
    }
  });

  test("a second account never receives the first account's fresh or stale roster", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setFetchCodeBuddyModelsForTests((_profile, apiKey) => (
        apiKey === "cb-key-a"
          ? { ok: true, models: ["roster-a-model"] }
          : { ok: false, error: "process", detail: "denied" }
      ));

      const first = await gatherRoutedModels(codeBuddyConfig("cb-key-a"));
      const firstIds = first.filter(model => model.provider === "codebuddy-cn").map(model => model.id);
      expect(firstIds).toContain("roster-a-model");
      // The vendor default is callable even though the live roster omits it.
      expect(firstIds).toContain("default");

      // Key B's fetch fails: neither the fresh nor the stale cache entry recorded for key A
      // may leak into key B's catalog.
      const second = await gatherRoutedModels(codeBuddyConfig("cb-key-b"));
      const secondIds = second.filter(model => model.provider === "codebuddy-cn").map(model => model.id);
      expect(secondIds).not.toContain("roster-a-model");
      expect(secondIds).toContain("default");
    } finally {
      warn.mockRestore();
    }
  });
});
