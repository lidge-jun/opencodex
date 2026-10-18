import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { getConfigPath, getDefaultConfig, loadConfig, validateConfigCandidate } from "../../src/config";
import { sanitizeOpenCodeZenOverridesForLoad } from "../../src/config/opencode-zen-upgrade";
import { readConfigDiagnostics, readConfigFileSnapshot } from "../../src/config/diagnostics";
import { handleConfigCommand } from "../../src/cli/config-command";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { createTempHome } from "../helpers/temp-home";

test("Claude saved overrides and Responses-only preferences migrate without changing unrelated models", () => {
  const raw = candidate({ "claude-sonnet-5-5": "openai-chat", "claude-opus-5-5": "openai-responses", "qwen-model": "openai-chat" }, {
    modelPreferHostedTools: { "claude-opus-5-5": ["image_generation"] },
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    sanitizeOpenCodeZenOverridesForLoad(raw);
    expect(raw.providers["opencode-zen"].modelAdapters).toEqual({ "qwen-model": "openai-chat" });
    expect(raw.providers["opencode-zen"].modelPreferHostedTools).toBeUndefined();
    expect(validateConfigCandidate(raw).ok).toBe(true);
  } finally { warn.mockRestore(); }
});

test.each(["vertex", "cloud-code-assist"])("Claude migration preserves Google mode %s and Gemini overrides", googleMode => {
  const raw = candidate({ "claude-opus-5-5": "openai-responses", "gemini-3.7-flash": "openai-responses" }, { googleMode });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    sanitizeOpenCodeZenOverridesForLoad(raw);
    expect(raw.providers["opencode-zen"].modelAdapters).toEqual({ "gemini-3.7-flash": "openai-responses" });
    expect(raw.providers["opencode-zen"].googleMode).toBe(googleMode);
    expect(validateConfigCandidate(raw).ok).toBe(true);
  } finally { warn.mockRestore(); }
});

const BASES = ["https://opencode.ai/zen/v1", "https://opencode.ai/inference/v1"];
const WARNING = "OpenCode Zen Gemini and Claude models now use their native APIs; obsolete Chat/Responses overrides were ignored while loading config.json.";

function candidate(modelAdapters: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "opencode-zen",
    providers: {
      "opencode-zen": {
        adapter: "openai-chat", baseUrl: BASES[0]!, authMode: "key", googleMode: "ai-studio",
        apiKey: "synthetic-zen-upgrade-key", note: "Saved Zen provider", modelAdapters, ...overrides,
      },
      "saved-gateway": {
        adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", apiKey: "synthetic-other-key",
        note: "Keep this provider", modelAdapters: { "gemini-3.7-flash": "openai-responses" },
        modelPreferHostedTools: { "gemini-3.7-flash": ["image_generation"] },
      },
    },
    codexAccounts: [{ id: "saved-account", email: "fixture@example.test", alias: "Saved account", plan: "plus", isMain: false }],
    codexAccountPriorities: { "saved-account": 25 },
    activeCodexAccountPinned: "saved-account",
    pausedCodexAccountIds: ["saved-account"],
  };
}

describe("OpenCode Zen saved-config upgrade", () => {
  test.each(BASES)("loads old Gemini overrides at %s without losing providers, accounts or file bytes", baseUrl => {
    const home = createTempHome("ocx-zen-config-upgrade-");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = candidate({
        "gemini-3.6-flash": "openai-chat",
        "GeMiNi-3.7-Flash": "openai-responses",
        "  GEMINI-future  ": "openai-chat",
        "gpt-6.1-sol": "openai-responses",
      }, { baseUrl });
      const bytes = Buffer.from(`\uFEFF${JSON.stringify(raw, null, 2)}\r\n`, "utf8");
      writeFileSync(getConfigPath(), bytes);
      const filesBefore = readdirSync(home.root).sort();
      const loaded = loadConfig();

      expect(loaded.defaultProvider).toBe("opencode-zen");
      expect(Object.keys(loaded.providers).sort()).toEqual(["opencode-zen", "saved-gateway"]);
      expect(loaded.providers["opencode-zen"]).toMatchObject({
        adapter: "openai-chat", apiKey: raw.providers["opencode-zen"].apiKey,
        note: "Saved Zen provider", modelAdapters: { "gpt-6.1-sol": "openai-responses" },
      });
      expect(loaded.providers["opencode-zen"].modelAdapters).toEqual({ "gpt-6.1-sol": "openai-responses" });
      expect(loaded.providers["saved-gateway"]).toMatchObject(raw.providers["saved-gateway"]);
      expect(loaded.codexAccounts).toEqual(raw.codexAccounts);
      expect(loaded.codexAccountPriorities).toEqual(raw.codexAccountPriorities);
      expect(loaded.activeCodexAccountPinned).toBe(raw.activeCodexAccountPinned);
      expect(loaded.pausedCodexAccountIds).toEqual(raw.pausedCodexAccountIds);
      expect(readFileSync(getConfigPath())).toEqual(bytes);
      expect(readdirSync(home.root).sort()).toEqual(filesBefore);
      expect(warn.mock.calls.filter(call => call[0] === WARNING)).toEqual([[WARNING]]);
    } finally {
      warn.mockRestore();
      home.remove();
    }
  });

  test.each(["openai-chat", "openai-responses"])("removes an obsolete-only %s map when loading omitted auth/mode defaults", adapter => {
    const home = createTempHome("ocx-zen-config-empty-map-");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = candidate({ "  GeMiNi-3.7-flash  ": adapter }, { authMode: undefined, googleMode: undefined });
      const bytes = JSON.stringify(raw);
      writeFileSync(getConfigPath(), bytes);
      const loaded = loadConfig();
      expect(loaded.providers["opencode-zen"]).toBeDefined();
      expect(Object.hasOwn(loaded.providers["opencode-zen"], "modelAdapters")).toBe(false);
      expect(loaded.providers["saved-gateway"]).toMatchObject(raw.providers["saved-gateway"]);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      expect(warn.mock.calls).toEqual([[WARNING]]);
    } finally {
      warn.mockRestore();
      home.remove();
    }
  });

  test.each(BASES)("diagnostics, export and persisted edits preserve saved state at %s", async baseUrl => {
    const home = createTempHome("ocx-zen-config-readers-");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    const previousExit = process.exitCode;
    try {
      const raw = candidate({ "gemini-3.7-flash": "openai-responses" }, { baseUrl });
      const bytes = "\uFEFF" + JSON.stringify(raw, null, 2) + "\r\n";
      writeFileSync(getConfigPath(), bytes);
      const snapshot = readConfigFileSnapshot();
      expect(snapshot.raw).toBe(bytes);
      expect(snapshot.diagnostics.source).toBe("file");
      expect(snapshot.diagnostics.error).toBeNull();
      expect(snapshot.diagnostics.config).toEqual(loadConfig());
      const exported = home.path("export.json");
      expect(await handleConfigCommand(["export", exported, "--json"])).toBe(0);
      expect(JSON.parse(readFileSync(exported, "utf8"))).toEqual(snapshot.diagnostics.config);
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      expect(await handleConfigCommand(["set", "port", "10201", "--json"])).toBe(0);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(persisted.port).toBe(10201);
      expect(Object.keys(persisted.providers).sort()).toEqual(["opencode-zen", "saved-gateway"]);
      expect(persisted.providers["opencode-zen"]).toMatchObject({
        apiKey: raw.providers["opencode-zen"].apiKey, note: "Saved Zen provider",
      });
      expect(persisted.providers["opencode-zen"].modelAdapters).toBeUndefined();
      expect(persisted.providers["saved-gateway"]).toEqual(raw.providers["saved-gateway"]);
      expect(persisted.codexAccounts).toEqual(raw.codexAccounts);
      expect(persisted.codexAccountPriorities).toEqual(raw.codexAccountPriorities);
      expect(persisted.activeCodexAccountPinned).toBe(raw.activeCodexAccountPinned);
      expect(persisted.pausedCodexAccountIds).toEqual(raw.pausedCodexAccountIds);
      expect(readConfigDiagnostics()).toMatchObject({ source: "file", error: null });
    } finally {
      warn.mockRestore(); out.mockRestore(); err.mockRestore(); process.exitCode = previousExit;
      await flushConfigDirHardeningAndReaps(home.root);
      home.remove();
    }
  });

  test.each(["model", "provider"])("migrates only valid legacy Gemini hosted preferences from %s Responses", mode => {
    const home = createTempHome("ocx-zen-hosted-upgrade-");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unrelated = mode === "model" ? { "gpt-6.1-sol": ["image_generation"] } : {};
      const raw = candidate(mode === "model"
        ? { "gemini-3.7-flash": "openai-responses", "gpt-6.1-sol": "openai-responses" } : undefined, {
        adapter: mode === "provider" ? "openai-responses" : "openai-chat",
        modelPreferHostedTools: { "gemini-3.7-flash": ["image_generation"], ...unrelated },
      });
      const bytes = JSON.stringify(raw);
      writeFileSync(getConfigPath(), bytes);
      const loaded = loadConfig();
      expect(Object.keys(loaded.providers).sort()).toEqual(["opencode-zen", "saved-gateway"]);
      expect(loaded.codexAccounts).toEqual(raw.codexAccounts);
      expect(loaded.providers["opencode-zen"].modelPreferHostedTools).toEqual(mode === "model" ? unrelated : undefined);
      expect(loaded.providers["saved-gateway"]).toEqual(raw.providers["saved-gateway"]);
      expect(readConfigDiagnostics()).toMatchObject({ source: "file", error: null, config: loaded });
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    } finally { warn.mockRestore(); home.remove(); }
  });

  test("new writes still reject Google-incompatible hosted preferences without mutating the candidate", () => {
    const raw = candidate(undefined, { modelPreferHostedTools: { "gemini-3.7-flash": ["image_generation"] } });
    const original = structuredClone(raw);
    const result = validateConfigCandidate(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("modelPreferHostedTools");
    expect(raw).toEqual(original);
  });

  test.each(["openai-chat", "openai-responses"])("strict candidate validation still rejects a new %s override without modifying it", adapter => {
    for (const model of ["gemini-3.7-flash", "GeMiNi-future", "  GEMINI-3.6-flash  "]) {
      const raw = candidate({ [model]: adapter });
      const original = structuredClone(raw);
      const result = validateConfigCandidate(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("modelAdapters");
        expect(result.error).toContain("only speaks one wire");
      }
      expect(raw).toEqual(original);
    }
  });
});

describe("OpenCode Zen load sanitizer boundaries", () => {
  const exclusions: Array<[string, Record<string, unknown>]> = [
    ["custom destination", { baseUrl: "https://gateway.example.test/v1" }],
    ["Go destination", { baseUrl: "https://opencode.ai/zen/go/v1" }],
    ["lookalike host", { baseUrl: "https://opencode.ai.evil.test/zen/v1" }],
    ["query-bearing URL", { baseUrl: "https://opencode.ai/zen/v1?route=other" }],
    ["OAuth", { authMode: "oauth" }],
    ["forward auth", { authMode: "forward" }],
    ["no auth", { authMode: "none" }],
    ["Vertex", { googleMode: "vertex" }],
    ["Cloud Code Assist", { googleMode: "cloud-code-assist" }],
  ];
  test.each(exclusions)("preserves overrides and emits no upgrade warning for %s", (_label, overrides) => {
    const raw = candidate({ "  GeMiNi-3.7-flash  ": "openai-responses" }, {
      ...overrides, modelPreferHostedTools: { "  GeMiNi-3.7-flash  ": ["image_generation"] },
    });
    const original = structuredClone(raw);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      sanitizeOpenCodeZenOverridesForLoad(raw);
      expect(raw).toEqual(original);
      expect(warn.mock.calls).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  test("only the canonical provider name is migrated", () => {
    const raw = { providers: { "my-zen": candidate({ "gemini-3.7-flash": "openai-chat" }).providers["opencode-zen"] } };
    const original = structuredClone(raw);
    sanitizeOpenCodeZenOverridesForLoad(raw);
    expect(raw).toEqual(original);
  });

  test("invalid overrides remain visible to strict validation while obsolete allowed entries are removed", () => {
    const retained = { "gemini-invalid": "google", "gemini-spaced": " openai-chat", "gemini-number": 42,
      "unrelated-model": "bogus", "not-gemini-model": "openai-chat", " ": "openai-responses" };
    const raw = candidate({ ...retained, "gemini-3.7-flash": "openai-responses" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      sanitizeOpenCodeZenOverridesForLoad(raw);
      expect(raw.providers["opencode-zen"].modelAdapters).toEqual(retained);
      expect(validateConfigCandidate(raw).ok).toBe(false);
      expect(warn.mock.calls).toEqual([[WARNING]]);
    } finally { warn.mockRestore(); }
  });

  test("malformed, denied and non-Responses Gemini preferences remain subject to validation", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of [null, "image_generation", [], ["web_search"], ["image_generation", 42]]) {
        const raw = candidate({ "gemini-3.7-flash": "openai-responses" }, {
          modelPreferHostedTools: { "gemini-3.7-flash": value },
        });
        sanitizeOpenCodeZenOverridesForLoad(raw);
        expect(raw.providers["opencode-zen"]).toMatchObject({ modelPreferHostedTools: { "gemini-3.7-flash": value } });
        expect(validateConfigCandidate(raw).ok).toBe(false);
      }
      for (const overrides of [
        { unsupportedHostedTools: ["image_gen"], modelAdapters: { "gemini-3.7-flash": "openai-responses" } },
        { modelAdapters: undefined },
        { adapter: "openai-responses", modelAdapters: { "gemini-3.7-flash": "openai-chat" } },
      ]) {
        const prefs = { "gemini-3.7-flash": ["image_generation"] };
        const raw = candidate(undefined, { ...overrides, modelPreferHostedTools: prefs });
        sanitizeOpenCodeZenOverridesForLoad(raw);
        expect(raw.providers["opencode-zen"]).toMatchObject({ modelPreferHostedTools: prefs });
        const once = structuredClone(raw);
        sanitizeOpenCodeZenOverridesForLoad(raw);
        expect(raw).toEqual(once);
        expect(validateConfigCandidate(raw).ok).toBe(false);
      }
    } finally { warn.mockRestore(); }
  });

  test("malformed hosted-tool denials do not throw before load degradation", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const unsupportedHostedTools of [null, 42, "image_gen", {}, [null, 42]]) {
        const raw = candidate({ "gemini-3.7-flash": "openai-responses" }, {
          unsupportedHostedTools, modelPreferHostedTools: { "gemini-3.7-flash": ["image_generation"] },
        });
        expect(() => sanitizeOpenCodeZenOverridesForLoad(raw)).not.toThrow();
        expect(raw.providers["opencode-zen"]).toMatchObject({ unsupportedHostedTools });
        expect(Object.hasOwn(raw.providers["opencode-zen"], "modelPreferHostedTools")).toBe(false);
      }
    } finally { warn.mockRestore(); }
  });
  test("malformed containers and maps are left untouched", () => {
    for (const raw of [undefined, null, false, [], {}, { providers: null }, { providers: [] },
      { providers: { "opencode-zen": null } }, { providers: { "opencode-zen": [] } },
      ...[undefined, null, "openai-chat", 42, ["openai-chat"]].map(map => candidate(map))]) {
      const original = structuredClone(raw);
      sanitizeOpenCodeZenOverridesForLoad(raw);
      expect(raw).toEqual(original);
    }
  });

  test("warns once with fixed text, removes an empty map and is idempotent", () => {
    const raw = candidate({ "gemini-sensitive-fixture": "openai-chat", "gemini-other-fixture": "openai-responses" },
      { baseUrl: "  https://opencode.ai/zen/v1///  " });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      sanitizeOpenCodeZenOverridesForLoad(raw);
      expect(Object.hasOwn(raw.providers["opencode-zen"], "modelAdapters")).toBe(false);
      const sanitized = structuredClone(raw);
      sanitizeOpenCodeZenOverridesForLoad(raw);
      expect(raw).toEqual(sanitized);
      expect(warn.mock.calls).toEqual([[WARNING]]);
    } finally { warn.mockRestore(); }
  });
});
