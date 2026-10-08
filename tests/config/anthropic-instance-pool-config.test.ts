import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configDiagnosticsFromRaw,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  readConfigDiagnostics,
  saveConfig,
  validateConfigCandidate,
} from "../../src/config";
import {
  isAnthropicPoolEnabledFor,
  rawAnthropicAccountPool,
  resolveAnthropicAccountPoolConfig,
} from "../../src/oauth/anthropic-pool-config";
import { ANTHROPIC_INSTANCE_IDS, type AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { AnthropicAccountPoolConfig, OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-instance-config-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function configWithBothInstances(): OcxConfig {
  const config = getDefaultConfig();
  config.providers.anthropic = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" };
  config.providers.anthropic2 = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" };
  config.providers.unrelated = {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://example.com/v1", apiKey: "fixture-preserved",
  };
  return config;
}

/** Raw fixtures deliberately cross the file boundary without pretending to be valid typed config. */
function withRawPool(instance: AnthropicInstanceId, pool: unknown): unknown {
  const config = configWithBothInstances();
  return instance === "anthropic"
    ? { ...config, anthropicAccountPool: pool }
    : { ...config, providers: { ...config.providers, anthropic2: { ...config.providers.anthropic2, anthropicAccountPool: pool } } };
}

function pathFor(instance: AnthropicInstanceId): string {
  return instance === "anthropic" ? "anthropicAccountPool" : "providers.anthropic2.anthropicAccountPool";
}

function expectRejected(value: unknown, path: string): void {
  const result = validateConfigCandidate(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(path);
}

describe("Anthropic pool configuration locations", () => {
  test("A and B resolve their own raw object with no inheritance in either direction", () => {
    const config = configWithBothInstances();
    const a: AnthropicAccountPoolConfig = { enabled: true, strategy: "round-robin", stickyLimit: 3, quotaWindow: "weekly" };
    const b: AnthropicAccountPoolConfig = { enabled: false, strategy: "fill-first", stickyLimit: 7, quotaWindow: "max-utilization" };
    config.anthropicAccountPool = a;
    expect(rawAnthropicAccountPool(config, "anthropic")).toBe(a);
    expect(resolveAnthropicAccountPoolConfig(config, "anthropic")).toBe(a);
    expect(resolveAnthropicAccountPoolConfig(config, "anthropic2")).toEqual({});
    expect(isAnthropicPoolEnabledFor(config, "anthropic")).toBe(true);
    expect(isAnthropicPoolEnabledFor(config, "anthropic2")).toBe(false);
    config.providers.anthropic2.anthropicAccountPool = b;
    expect(rawAnthropicAccountPool(config, "anthropic2")).toBe(b);
    expect(resolveAnthropicAccountPoolConfig(config, "anthropic2")).toBe(b);
    expect(isAnthropicPoolEnabledFor(config, "anthropic2")).toBe(false);
    delete config.anthropicAccountPool;
    b.enabled = true;
    expect(resolveAnthropicAccountPoolConfig(config, "anthropic")).toEqual({});
    expect(isAnthropicPoolEnabledFor(config, "anthropic")).toBe(false);
    expect(isAnthropicPoolEnabledFor(config, "anthropic2")).toBe(true);
    delete config.providers.anthropic2;
    expect(resolveAnthropicAccountPoolConfig(config, "anthropic2")).toEqual({});
  });

  test("validated pool objects preserve each location independently", () => {
    const config = configWithBothInstances();
    config.anthropicAccountPool = { enabled: true, nativeMessages: false, stickyLimit: 2 };
    config.providers.anthropic2.anthropicAccountPool = {
      enabled: false, nativeMessages: true, stickyLimit: 8, autoSwitchThreshold: 60,
      strategy: "fill-first", quotaWindow: "weekly",
      routes: [{ name: "opus", match: "claude-opus-*", accounts: ["b-only"], fallback: false }],
    };
    const validated = validateConfigCandidate(config);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.config.anthropicAccountPool).toEqual(config.anthropicAccountPool);
    expect(validated.config.providers.anthropic2.anthropicAccountPool).toEqual(config.providers.anthropic2.anthropicAccountPool);
    saveConfig(validated.config);
    const loaded = loadConfig();
    expect(loaded.anthropicAccountPool).toEqual(config.anthropicAccountPool);
    expect(loaded.providers.anthropic2.anthropicAccountPool).toEqual(config.providers.anthropic2.anthropicAccountPool);
  });

  test("default and old A-only files never materialize B", () => {
    const config = getDefaultConfig();
    config.anthropicAccountPool = { enabled: true, stickyLimit: 4 };
    writeFileSync(getConfigPath(), JSON.stringify(config));
    expect(Object.hasOwn(loadConfig().providers, "anthropic2")).toBe(false);
    expect(Object.hasOwn(readConfigDiagnostics().config.providers, "anthropic2")).toBe(false);
  });

  for (const instance of ANTHROPIC_INSTANCE_IDS) {
    test(`${instance}: malformed nativeMessages loads false without losing sibling fields or providers`, () => {
      for (const nativeMessages of ["false", null, 0, [], {}]) {
        const raw = withRawPool(instance, { enabled: true, nativeMessages, stickyLimit: 3 });
        writeFileSync(getConfigPath(), JSON.stringify(raw));
        const loaded = loadConfig();
        expect(rawAnthropicAccountPool(loaded, instance)).toEqual({ enabled: true, nativeMessages: false, stickyLimit: 3 });
        expect(loaded.providers.unrelated.apiKey).toBe("fixture-preserved");
        expect(loaded.providers.anthropic).toMatchObject({ adapter: "anthropic", authMode: "oauth" });
        expect(loaded.providers.anthropic2).toMatchObject({ adapter: "anthropic", authMode: "oauth" });
        expectRejected(raw, `${pathFor(instance)}.nativeMessages`);
        const diagnostics = readConfigDiagnostics();
        expect(diagnostics.error).toContain(`${pathFor(instance)}.nativeMessages`);
        expect(diagnostics.config.providers.unrelated.apiKey).toBe("fixture-preserved");
      }
    });

    test(`${instance}: malformed pool containers load absent and remain errors on writes/diagnostics`, () => {
      for (const pool of [null, "false", 0, [], true]) {
        const raw = withRawPool(instance, pool);
        writeFileSync(getConfigPath(), JSON.stringify(raw));
        const loaded = loadConfig();
        expect(rawAnthropicAccountPool(loaded, instance)).toBeUndefined();
        expect(loaded.providers.unrelated.apiKey).toBe("fixture-preserved");
        expectRejected(raw, pathFor(instance));
        const diagnostics = readConfigDiagnostics();
        expect(diagnostics.error).toContain(pathFor(instance));
        expect(diagnostics.config.providers.unrelated.apiKey).toBe("fixture-preserved");
      }
    });

    test(`${instance}: missing native preference stays absent; historical passthrough load is preserved`, () => {
      const raw = withRawPool(instance, { enabled: "historical-raw", stickyLimit: "historical-raw", futureSetting: 9 });
      writeFileSync(getConfigPath(), JSON.stringify(raw));
      expect(rawAnthropicAccountPool(loadConfig(), instance)).toEqual({
        enabled: "historical-raw", stickyLimit: "historical-raw", futureSetting: 9,
      });
      expect(validateConfigCandidate(withRawPool(instance, { enabled: true })).ok).toBe(true);
      const pool = rawAnthropicAccountPool(loadConfig(), instance) as Record<string, unknown>;
      expect(Object.hasOwn(pool, "nativeMessages")).toBe(false);
    });

    test(`${instance}: route validation applies to its own location`, () => {
      const invalid = withRawPool(instance, { routes: [{ name: "broken", match: "claude-*", accounts: [] }] });
      expectRejected(invalid, `${pathFor(instance)}.routes`);
      expect(configDiagnosticsFromRaw(JSON.stringify(invalid)).error).toContain(`${pathFor(instance)}.routes`);
      expect(validateConfigCandidate(withRawPool(instance, {
        routes: [{ name: "valid", match: "claude-*", accounts: ["own-account"], fallback: true }],
      })).ok).toBe(true);
    });
  }

  test("provider-local pool fields on A and unrelated providers are diagnosed, never silently accepted", () => {
    for (const name of ["anthropic", "unrelated", "custom-anthropic"]) {
      for (const pool of [{ enabled: true }, null]) {
        const config = configWithBothInstances();
        const raw = {
          ...config, providers: { ...config.providers, [name]: {
            ...(config.providers[name] ?? config.providers.anthropic), anthropicAccountPool: pool,
          } },
        };
        const path = `providers.${name}.anthropicAccountPool`;
        expectRejected(raw, path);
        const diagnostics = configDiagnosticsFromRaw(JSON.stringify(raw));
        expect(diagnostics.source).toBe("file");
        expect(diagnostics.error).toContain(path);
        expect(diagnostics.error).toContain("misplaced field");
        expect(diagnostics.config.providers.unrelated.apiKey).toBe("fixture-preserved");
      }
    }
  });
});

type SidecarField = "webSearchSidecar" | "visionSidecar";
function withSidecar(scope: "global" | "claude", field: SidecarField, setting: unknown): unknown {
  const config = configWithBothInstances();
  return scope === "global" ? { ...config, [field]: setting }
    : { ...config, claudeCode: { [field]: setting } };
}

describe("explicit Anthropic helper instance preferences", () => {
  test("Claude instance overrides validate against the inherited global backend", () => {
    const config = configWithBothInstances();
    config.webSearchSidecar = { backend: "openai" };
    config.claudeCode = { webSearchSidecar: { anthropicInstance: "anthropic2" } };
    expectRejected(config, "claudeCode.webSearchSidecar.anthropicInstance");
    config.webSearchSidecar.backend = "anthropic";
    expect(validateConfigCandidate(config).ok).toBe(true);
    config.webSearchSidecar.anthropicInstance = "anthropic2";
    config.claudeCode.webSearchSidecar = { backend: "xai" };
    expectRejected(config, "claudeCode.webSearchSidecar.anthropicInstance");
  });

  test("an explicit search instance cannot use the default OpenAI backend", () => {
    expectRejected(withSidecar("global", "webSearchSidecar", { anthropicInstance: "anthropic2" }), "webSearchSidecar.anthropicInstance");
  });

  for (const scope of ["global", "claude"] as const) {
    for (const field of ["webSearchSidecar", "visionSidecar"] as const) {
      const path = `${scope === "claude" ? "claudeCode." : ""}${field}.anthropicInstance`;
      test(`${scope} ${field}: exact instance ids survive validation and file round trips`, () => {
        for (const anthropicInstance of ANTHROPIC_INSTANCE_IDS) {
          const setting = { backend: "anthropic", anthropicInstance, model: "claude-sonnet-5" };
          const raw = withSidecar(scope, field, setting);
          const result = validateConfigCandidate(raw);
          expect(result.ok).toBe(true);
          if (!result.ok) continue;
          saveConfig(result.config);
          const loaded = loadConfig();
          const owner = scope === "global" ? loaded : loaded.claudeCode!;
          expect(owner[field]).toEqual(setting);
          expect(readConfigDiagnostics().error).toBeNull();
        }
      });

      test(`${scope} ${field}: malformed ids and foreign backends are rejected`, () => {
        for (const anthropicInstance of ["anthropic3", "anthropic-apikey", "Anthropic", null, {}, 2]) {
          expectRejected(withSidecar(scope, field, { backend: "anthropic", anthropicInstance }), path);
        }
        const backends = field === "visionSidecar" ? ["openai", "routed"] : ["openai", "xai", "gemini", "exa"];
        for (const backend of backends) {
          const raw = withSidecar(scope, field, { backend, anthropicInstance: "anthropic2" });
          expectRejected(raw, path);
          expect(configDiagnosticsFromRaw(JSON.stringify(raw)).error).toContain(path);
        }
      });

      test(`${scope} ${field}: absence stays absent after saving`, () => {
        const setting = { backend: "anthropic", model: "claude-sonnet-5" };
        const result = validateConfigCandidate(withSidecar(scope, field, setting));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        saveConfig(result.config);
        const stored = JSON.parse(readFileSync(getConfigPath(), "utf8"));
        const owner = scope === "global" ? stored : stored.claudeCode;
        expect(owner[field]).toEqual(setting);
        expect(Object.hasOwn(owner[field], "anthropicInstance")).toBe(false);
      });
    }
  }
});
