import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { getConfigPath, getDefaultConfig, loadConfig, validateConfigCandidate } from "../../src/config";
import { readConfigFileSnapshot } from "../../src/config/diagnostics";
import { handleConfigCommand } from "../../src/cli/config-command";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { sanitizeOpenCodeOverridesForLoad } from "../../src/config/opencode-wire-upgrade";
import { OPENCODE_GO_LEGACY_NAME_PINS, OPENCODE_GO_MODEL_WIRES } from "../../src/types/opencode-go";
import { pinnedWireAdapter } from "../../src/types/wire";
import { createTempHome } from "../helpers/temp-home";

const NEW_PINS = ["gemini-4-argon-contributor", "qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash"];
const RESPONSES = Object.keys(OPENCODE_GO_MODEL_WIRES).filter(model => OPENCODE_GO_MODEL_WIRES[model] === "openai-responses");

function candidate(modelAdapters: unknown, extra: Record<string, unknown> = {}) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "synthetic-go-upgrade-key",
        note: "Saved Go provider", modelAdapters, ...extra,
      },
      "saved-gateway": {
        adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1", apiKey: "synthetic-other-key",
        modelAdapters: { "qwen3.7-plus": "openai-responses" },
        modelPreferHostedTools: { "qwen3.7-plus": ["image_generation"] },
      },
    },
    codexAccounts: [{ id: "saved-account", email: "fixture@example.test", alias: "Saved account", plan: "plus", isMain: false }],
    codexAccountPriorities: { "saved-account": 25 },
    activeCodexAccountPinned: "saved-account",
    pausedCodexAccountIds: ["saved-account"],
    routingProfiles: { saved: { candidates: [{ provider: "saved-gateway", model: "qwen3.7-plus" }] } },
  };
}

function checkReaders(raw: ReturnType<typeof candidate>) {
  const home = createTempHome("ocx-go-config-upgrade-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bytes = Buffer.from("\uFEFF" + JSON.stringify(raw, null, 2) + "\r\n");
    writeFileSync(getConfigPath(), bytes);
    const filesBefore = readdirSync(home.root).sort();
    const loaded = loadConfig();
    const snapshot = readConfigFileSnapshot();
    expect(snapshot.raw).toBe(bytes.toString());
    expect(snapshot.diagnostics).toMatchObject({ source: "file", error: null, config: loaded });
    expect(loaded.defaultProvider).toBe("opencode-go");
    expect(Object.keys(loaded.providers).sort()).toEqual(["opencode-go", "saved-gateway"]);
    expect(loaded.providers["saved-gateway"]).toEqual(raw.providers["saved-gateway"]);
    expect(loaded.providers["opencode-go"]).toMatchObject({ apiKey: "synthetic-go-upgrade-key", note: "Saved Go provider" });
    expect(loaded.codexAccounts).toEqual(raw.codexAccounts);
    expect(loaded.codexAccountPriorities).toEqual(raw.codexAccountPriorities);
    expect(loaded.activeCodexAccountPinned).toBe(raw.activeCodexAccountPinned);
    expect(loaded.pausedCodexAccountIds).toEqual(raw.pausedCodexAccountIds);
    expect(loaded.routingProfiles).toEqual(raw.routingProfiles);
    for (const model of NEW_PINS) {
      expect(pinnedWireAdapter("opencode-go", model, loaded.providers["opencode-go"]))
        .toBe(OPENCODE_GO_MODEL_WIRES[model]);
    }
    expect(readFileSync(getConfigPath())).toEqual(bytes);
    expect(readdirSync(home.root).sort()).toEqual(filesBefore);
    return loaded.providers["opencode-go"];
  } finally { warn.mockRestore(); home.remove(); }
}

describe("OpenCode Go saved native-wire upgrade", () => {
  test("covers every newly pinned model while excluding historical pins and Responses defaults", () => {
    expect(Object.entries(OPENCODE_GO_MODEL_WIRES)
      .filter(([model, wire]) => wire !== "openai-responses" && !OPENCODE_GO_LEGACY_NAME_PINS.has(model))
      .map(([model]) => model)).toEqual(NEW_PINS);
  });

  for (const model of NEW_PINS) {
    for (const adapter of ["openai-chat", "openai-responses"]) {
      test(`load and diagnostics preserve state for old ${model} ${adapter} overrides`, () => {
        for (const key of [model, `  ${model}  `]) {
          const raw = candidate({ [key]: adapter, ...Object.fromEntries(RESPONSES.map(id => [id, "openai-chat"])) });
          expect(checkReaders(raw).modelAdapters).toEqual(Object.fromEntries(RESPONSES.map(id => [id, "openai-chat"])));
        }
      });
    }
    test(`load and diagnostics migrate valid old ${model} hosted preferences`, () => {
      for (const key of [model, ` ${model} `]) {
        const raw = candidate({ [key]: "openai-responses", "gpt-6-luna": "openai-responses" }, {
          modelPreferHostedTools: { [key]: ["image_generation"], "gpt-6-luna": ["image_generation"] },
        });
        const loaded = checkReaders(raw);
        expect(loaded.modelAdapters).toEqual({ "gpt-6-luna": "openai-responses" });
        expect(loaded.modelPreferHostedTools).toEqual({ "gpt-6-luna": ["image_generation"] });
      }
    });
  }

  test("removes empty override and hosted-preference maps in both readers", () => {
    const raw = candidate({ "qwen3.7-plus": "openai-responses" }, {
      modelPreferHostedTools: { "qwen3.7-plus": ["image_generation"] },
    });
    const loaded = checkReaders(raw);
    expect(loaded.modelAdapters).toBeUndefined();
    expect(loaded.modelPreferHostedTools).toBeUndefined();
  });

  test("an explicit config edit persists the upgrade and preserves the rest of the saved config", async () => {
    const home = createTempHome("ocx-go-config-edit-");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    const previousExit = process.exitCode;
    try {
      const raw = candidate({ "qwen3.7-plus": "openai-responses" }, {
        authMode: "key", googleMode: "ai-studio",
        modelPreferHostedTools: { "qwen3.7-plus": ["image_generation"] },
      });
      writeFileSync(getConfigPath(), JSON.stringify(raw));
      expect(await handleConfigCommand(["set", "port", "10201", "--json"])).toBe(0);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
      expect(persisted).toMatchObject({ ...raw, port: 10201, providers: {
        ...raw.providers, "opencode-go": {
          adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "synthetic-go-upgrade-key", note: "Saved Go provider",
          authMode: "key", googleMode: "ai-studio",
        },
      } });
      expect(persisted.providers["opencode-go"].modelAdapters).toBeUndefined();
      expect(persisted.providers["opencode-go"].modelPreferHostedTools).toBeUndefined();
      expect(readConfigFileSnapshot().diagnostics).toMatchObject({ source: "file", error: null });
    } finally {
      warn.mockRestore(); out.mockRestore(); err.mockRestore(); process.exitCode = previousExit;
      await flushConfigDirHardeningAndReaps(home.root);
      home.remove();
    }
  });

  test.each(["https://opencode.ai/inference/go/v1", "https://gateway.example.test/v1"])(
    "matches validation's historical Go URL pin for %s", baseUrl => {
      expect(checkReaders(candidate({ "qwen3.8-max": "openai-chat" }, { baseUrl })).modelAdapters).toBeUndefined();
    },
  );

  test("strict writes still reject all newly pinned overrides without mutating the candidate", () => {
    for (const model of NEW_PINS) {
      for (const adapter of ["openai-chat", "openai-responses"]) {
        const raw = candidate({ [model]: adapter });
        const original = structuredClone(raw);
        const result = validateConfigCandidate(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("only speaks one wire");
        expect(raw).toEqual(original);
      }
    }
  });
});

describe("Go upgrade boundaries", () => {
  test("leaves historical pins, unknown ids, case variants and invalid override values to validation", () => {
    const retained = { ...Object.fromEntries([...OPENCODE_GO_LEGACY_NAME_PINS].map(model => [model, "openai-chat"])),
      "qwen3.7-plus": "anthropic", "qwen3.8-max": " openai-chat", "qwen3.8-flash": 42,
      "QWEN3.7-PLUS": "openai-chat", "gemini-future": "openai-responses", " ": "openai-chat" };
    const raw = candidate(retained);
    const original = structuredClone(raw);
    sanitizeOpenCodeOverridesForLoad(raw);
    expect(raw).toEqual(original);
    expect(validateConfigCandidate(raw).ok).toBe(false);
  });

  test("does not erase previously invalid or denied hosted preferences on repeated passes", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const extra of [
        ...[null, "image_generation", [], ["web_search"], ["image_generation", 42]].map(value => ({
          modelPreferHostedTools: { "qwen3.7-plus": value },
        })),
        { unsupportedHostedTools: ["image_gen"], modelPreferHostedTools: { "qwen3.7-plus": ["image_generation"] } },
        { modelAdapters: { "qwen3.7-plus": "openai-chat" }, modelPreferHostedTools: { "qwen3.7-plus": ["image_generation"] } },
        { modelAdapters: undefined, adapter: "openai-responses", modelPreferHostedTools: { "qwen3.7-plus": ["image_generation"] } },
      ]) {
        const raw = candidate({ "qwen3.7-plus": "openai-responses" }, extra);
        const original = structuredClone(raw);
        sanitizeOpenCodeOverridesForLoad(raw);
        sanitizeOpenCodeOverridesForLoad(raw);
        expect(raw).toEqual(original);
        expect(validateConfigCandidate(raw).ok).toBe(false);
      }
    } finally { warn.mockRestore(); }
  });

  test("unsupported auth and Google modes, other provider names and malformed maps stay untouched", () => {
    for (const extra of [{ authMode: "oauth" }, { authMode: "forward" }, { authMode: "none" },
      { googleMode: "vertex" }, { googleMode: "cloud-code-assist" },
      ...[null, 42, "openai-chat", ["openai-responses"]].map(modelAdapters => ({ modelAdapters }))]) {
      const raw = candidate({ "qwen3.7-plus": "openai-chat" }, extra);
      const original = structuredClone(raw);
      sanitizeOpenCodeOverridesForLoad(raw);
      expect(raw).toEqual(original);
    }
    const raw = { providers: { "my-go": candidate({ "qwen3.7-plus": "openai-chat" }).providers["opencode-go"] } };
    const original = structuredClone(raw);
    sanitizeOpenCodeOverridesForLoad(raw);
    expect(raw).toEqual(original);
  });

  test("upgrade is idempotent and warning text contains no configured names or values", () => {
    const raw = candidate({ "qwen3.7-plus": "openai-chat", "qwen3.8-max": "openai-responses" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      sanitizeOpenCodeOverridesForLoad(raw);
      const once = structuredClone(raw);
      sanitizeOpenCodeOverridesForLoad(raw);
      expect(raw).toEqual(once);
      expect(warn.mock.calls).toEqual([["OpenCode Go native models now use their required APIs; obsolete Chat/Responses overrides were ignored while loading config.json."]]);
    } finally { warn.mockRestore(); }
  });
});
