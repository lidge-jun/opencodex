import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_PROVIDER_ID,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildOpencodeConfig,
  buildOpencodeEnv,
  buildOpencodeProviderBlock,
  mergeOpencodeConfig,
  opencodeApiKey,
  opencodeGlobalConfigPath,
  opencodeModelKey,
  opencodeNotFoundHint,
  parseJsonc,
  projectConfigOverridesProvider,
  readBaseOpencodeConfig,
} from "../src/cli/opencode";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

describe("ocx opencode provider block", () => {
  test("points at the live proxy port over the OpenAI-compatible surface", () => {
    const block = buildOpencodeProviderBlock(10123, [], []);
    expect(block.options.baseURL).toBe("http://127.0.0.1:10123/v1");
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
  });

  // The generated file is written to disk and outlives the child, so the admission key
  // must never be serialized into it (AGENTS.md: token serialization is a blocker).
  test("apiKey is an env reference, never a literal secret", () => {
    const block = buildOpencodeProviderBlock(10100, [], []);
    expect(block.options.apiKey).toBe(`{env:${OPENCODE_API_KEY_ENV}}`);
    expect(JSON.stringify(block)).not.toContain("sk-");
  });

  test("routed models key on provider/id, native slugs stay bare", () => {
    const block = buildOpencodeProviderBlock(10100, ["gpt-5.6-sol"], [
      { provider: "kiro", id: "glm-5" },
    ]);
    expect(Object.keys(block.models).sort()).toEqual(["gpt-5.6-sol", "kiro/glm-5"]);
  });

  test("limit.context is emitted only from an authoritative contextWindow — never guessed", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "with-window", contextWindow: 200_000 },
      { provider: "kiro", id: "no-window" },
      { provider: "kiro", id: "zero-window", contextWindow: 0 },
    ]);
    expect(block.models["kiro/with-window"]?.limit?.context).toBe(200_000);
    // No authoritative window -> no limit at all, so opencode keeps its own default.
    expect(block.models["kiro/no-window"]?.limit).toBeUndefined();
    expect(block.models["kiro/zero-window"]?.limit).toBeUndefined();
  });

  // Regression: opencode rejects the whole config with "Missing key …limit.output" when a
  // limit block carries context alone, so the pair must always be emitted together.
  test("limit.output rides along with context because opencode's schema requires the pair", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "m", contextWindow: 200_000 },
    ]);
    expect(block.models["kiro/m"]?.limit).toEqual({ context: 200_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
  });

  // A model whose whole context is smaller than the placeholder budget would otherwise be
  // emitted with output > context, which is an impossible model definition.
  test("limit.output is clamped to the context window for small-context models", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "local", id: "tiny", contextWindow: 8_192 },
    ]);
    expect(block.models["local/tiny"]?.limit).toEqual({ context: 8_192, output: 8_192 });
  });

  test("native slugs pick up authoritative context windows from the resolver", () => {
    const block = buildOpencodeProviderBlock(10100, ["gpt-5.4", "unknown-native"], [], slug =>
      slug === "gpt-5.4" ? 1_000_000 : undefined);
    expect(block.models["gpt-5.4"]?.limit).toEqual({ context: 1_000_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
    expect(block.models["unknown-native"]?.limit).toBeUndefined();
  });

  test("displayName is used for the label when the catalog provides one", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "glm-5", displayName: "GLM-5" },
      { provider: "kiro", id: "qwen3-coder-next" },
    ]);
    expect(block.models["kiro/glm-5"]?.name).toBe("GLM-5 (kiro)");
    expect(block.models["kiro/qwen3-coder-next"]?.name).toBe("qwen3-coder-next (kiro)");
  });

  test("duplicate keys keep the first entry instead of throwing", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "dup", displayName: "First" },
      { provider: "kiro", id: "dup", displayName: "Second" },
    ]);
    expect(block.models["kiro/dup"]?.name).toBe("First (kiro)");
  });

  test("model key helper distinguishes native from routed", () => {
    expect(opencodeModelKey("native", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(opencodeModelKey("kiro", "glm-5")).toBe("kiro/glm-5");
  });
});

describe("ocx opencode config merge", () => {
  test("only the opencodex provider key is overwritten; everything else survives", () => {
    const base = {
      $schema: "https://opencode.ai/config.json",
      model: "kirocc/claude-opus-5",
      keybinds: { leader: "ctrl+x" },
      provider: {
        kirocc: { npm: "@ai-sdk/anthropic", options: { baseURL: "http://127.0.0.1:3456/v1" } },
        [OPENCODE_PROVIDER_ID]: { npm: "stale", name: "stale", options: {}, models: { old: {} } },
      },
    };
    const merged = mergeOpencodeConfig(base, buildOpencodeConfig(10100, [], [{ provider: "kiro", id: "glm-5" }]));
    // User's own default model, keybinds and hand-wired providers are untouched.
    expect(merged.model).toBe("kirocc/claude-opus-5");
    expect(merged.keybinds).toEqual({ leader: "ctrl+x" });
    const providers = merged.provider as Record<string, { models?: Record<string, unknown> }>;
    expect(providers.kirocc).toEqual(base.provider.kirocc);
    // Ours is replaced wholesale, so removed models do not linger.
    expect(providers[OPENCODE_PROVIDER_ID]?.models).toEqual({ "kiro/glm-5": { name: "glm-5 (kiro)" } });
  });

  test("a null base yields a standalone config", () => {
    const merged = mergeOpencodeConfig(null, buildOpencodeConfig(10100, [], []));
    expect(merged.$schema).toBe("https://opencode.ai/config.json");
    expect(Object.keys(merged.provider as object)).toEqual([OPENCODE_PROVIDER_ID]);
  });

  test("a base config with no provider map is handled", () => {
    const merged = mergeOpencodeConfig({ model: "x" }, buildOpencodeConfig(10100, [], []));
    expect(merged.model).toBe("x");
    expect(Object.keys(merged.provider as object)).toEqual([OPENCODE_PROVIDER_ID]);
  });
});

describe("ocx opencode JSONC parsing", () => {
  test("plain JSON parses unchanged", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  // opencode documents opencode.json as JSONC, so these are valid user configs.
  test("line and block comments are accepted", () => {
    expect(parseJsonc('{\n // lead\n "a": 1 /* trail */\n}')).toEqual({ a: 1 });
  });

  test("trailing commas are accepted", () => {
    expect(parseJsonc('{"a":[1,2,],"b":2,}')).toEqual({ a: [1, 2], b: 2 });
  });

  test("comment-like and comma-like text inside strings is preserved", () => {
    expect(parseJsonc('{"url":"http://x/v1","note":"a // b /* c */","t":"x,"}'))
      .toEqual({ url: "http://x/v1", note: "a // b /* c */", t: "x," });
  });

  test("escaped quotes do not break string tracking", () => {
    expect(parseJsonc('{"a":"he said \\"hi\\" // not a comment"}'))
      .toEqual({ a: 'he said "hi" // not a comment' });
  });

  test("genuinely malformed input still throws", () => {
    expect(() => parseJsonc("{ not json")).toThrow();
  });
});

describe("ocx opencode base config discovery", () => {
  test("missing global config is not an error — there is simply nothing to carry forward", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
    const result = readBaseOpencodeConfig({ XDG_CONFIG_HOME: dir }, join(dir, "generated.json"));
    expect(result.config).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("existing global config is read and reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(join(dir, "opencode", "opencode.json"), JSON.stringify({ model: "kirocc/claude-opus-5" }));
    const result = readBaseOpencodeConfig({ XDG_CONFIG_HOME: dir }, join(dir, "generated.json"));
    expect(result.config).toEqual({ model: "kirocc/claude-opus-5" });
    expect(result.sourcePath).toBe(join(dir, "opencode", "opencode.json"));
  });

  test("a commented (JSONC) global config launches instead of being rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(join(dir, "opencode", "opencode.json"), '{\n // my default\n "model": "kirocc/claude-opus-5",\n}');
    const result = readBaseOpencodeConfig({ XDG_CONFIG_HOME: dir }, join(dir, "generated.json"));
    expect(result.config).toEqual({ model: "kirocc/claude-opus-5" });
    expect(result.error).toBeUndefined();
  });

  test("malformed config surfaces an error instead of silently dropping user settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(join(dir, "opencode", "opencode.json"), "{ not json");
    const result = readBaseOpencodeConfig({ XDG_CONFIG_HOME: dir }, join(dir, "generated.json"));
    expect(result.config).toBeNull();
    expect(result.error).toBeDefined();
  });

  test("the generated file is never used as its own base (stale entries would compound)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
    const generated = join(dir, "generated.json");
    writeFileSync(generated, JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { models: { stale: {} } } } }));
    const result = readBaseOpencodeConfig({ OPENCODE_CONFIG: generated, XDG_CONFIG_HOME: dir }, generated);
    expect(result.config).toBeNull();
  });

  test("an explicitly exported OPENCODE_CONFIG is preferred over the global path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-"));
    const explicit = join(dir, "mine.json");
    writeFileSync(explicit, JSON.stringify({ model: "explicit" }));
    mkdirSync(join(dir, "opencode"), { recursive: true });
    writeFileSync(join(dir, "opencode", "opencode.json"), JSON.stringify({ model: "global" }));
    const result = readBaseOpencodeConfig({ OPENCODE_CONFIG: explicit, XDG_CONFIG_HOME: dir }, join(dir, "generated.json"));
    expect(result.config).toEqual({ model: "explicit" });
  });

  test("global path follows XDG_CONFIG_HOME when set", () => {
    expect(opencodeGlobalConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "opencode", "opencode.json"));
    expect(opencodeGlobalConfigPath({}, "/home/u")).toBe(join("/home/u", ".config", "opencode", "opencode.json"));
  });
});

describe("ocx opencode project-layer detection", () => {
  // opencode loads the project layer after OPENCODE_CONFIG, so a project-level
  // provider.opencodex silently outranks the generated block; the launcher warns.
  test("detects a project config that redefines our provider key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(projectConfigOverridesProvider(dir)).toBe(join(dir, "opencode.json"));
  });

  test("ignores a project config that defines other providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { other: { npm: "x" } } }));
    expect(projectConfigOverridesProvider(dir)).toBeNull();
  });

  test("no project config is not a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    expect(projectConfigOverridesProvider(dir)).toBeNull();
  });
});

describe("ocx opencode env assembly", () => {
  test("OPENCODE_CONFIG always points at the generated file", () => {
    // The launcher has already absorbed the user's own config, so honouring a
    // pre-existing export here would drop the provider block this command installs.
    const env = buildOpencodeEnv("/gen/opencode-config.json", "sk-ocx-123", { OPENCODE_CONFIG: "/user/mine.json", PATH: "/bin" });
    expect(env.OPENCODE_CONFIG).toBe("/gen/opencode-config.json");
    expect(env.PATH).toBe("/bin");
  });

  test("the admission key travels in the child env, matching the config's {env:…} reference", () => {
    const env = buildOpencodeEnv("/gen/c.json", "sk-ocx-123", {});
    expect(env[OPENCODE_API_KEY_ENV]).toBe("sk-ocx-123");
  });
});

describe("ocx opencode admission key", () => {
  // A non-loopback bind requires OPENCODEX_API_AUTH_TOKEN and may have no apiKeys at
  // all; emitting the placeholder there would 401 every request.
  test("the environment token wins over a configured API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, { OPENCODEX_API_AUTH_TOKEN: "sk-env" })).toBe("sk-env");
  });

  test("falls back to the configured proxy API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, {})).toBe("sk-cfg");
  });

  test("falls back to a placeholder on an open loopback proxy", () => {
    expect(opencodeApiKey(cfg(), {})).toBe("ocx");
  });
});

describe("ocx opencode not-found hint", () => {
  test("cmd.exe reports command-not-found as 9009", () => {
    expect(opencodeNotFoundHint(9009, null, "win32")).toContain("npm install -g opencode-ai");
  });

  test("signal exits and other platforms are not hints", () => {
    expect(opencodeNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(opencodeNotFoundHint(9009, null, "linux")).toBeNull();
    expect(opencodeNotFoundHint(0, null, "win32")).toBeNull();
  });
});
