import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXPORT_CLIENTS,
  KILO_API_KEY_ENV_REF,
  KILO_CONFIG_SCHEMA,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  buildClientContribution,
  kiloConfigPath,
  kiloHomeDir,
  type ExportContext,
} from "../../src/clients/config-export";
import type { KiloGeneratedConfig } from "../../src/clients/config-export/kilo";
import { PARSE_FAILED, parseConfig } from "../../src/integrations/config-io";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { readIntegrationState } from "../../src/integrations/state";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { applyIntegration, disableIntegration, restoreIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LOOPBACK: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

const REMOTE: OcxConfig = { ...LOOPBACK, hostname: "0.0.0.0" } as OcxConfig;

function context(config: OcxConfig = LOOPBACK): ExportContext {
  return {
    baseUrl: "http://127.0.0.1:10100/v1",
    config,
    models: [
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000, inputModalities: ["text", "image"] },
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
      { namespaced: "audio/only", provider: "audio", id: "only", inputModalities: ["audio"] },
      { namespaced: "unknown/mod", provider: "unknown", id: "mod", inputModalities: ["smell"] },
    ],
  };
}

describe("kilo client config", () => {
  test("emits a V1-only document with Kilo's schema and npm package", () => {
    const document = buildClientConfig("kilo", context()) as KiloGeneratedConfig;
    expect(document.$schema).toBe(KILO_CONFIG_SCHEMA);
    expect(document).not.toHaveProperty("providers");
    expect(Object.keys(document.provider)).toEqual([OPENCODE_PROVIDER_ID]);
    const provider = document.provider[OPENCODE_PROVIDER_ID]!;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.name).toBe("OpenCodex");
    expect(JSON.stringify(document)).not.toContain('"package"');
    expect(JSON.stringify(provider.models)).not.toContain("variants");
  });

  test("the contribution owns only provider.opencodex", () => {
    const contribution = buildClientContribution("kilo", context());
    expect(contribution.clientId).toBe("kilo");
    expect(contribution.fragments.map(fragment => fragment.path)).toEqual([["provider", OPENCODE_PROVIDER_ID]]);
  });

  test("loopback uses the Kilo env ref; remote uses the admission header; never a real key", () => {
    const sentinel = ["sk", "live", "kilo", "sentinel"].join("-");
    const withKey = { ...LOOPBACK, apiKeys: [{ key: sentinel }] } as OcxConfig;
    const loopback = buildClientConfig("kilo", context(withKey)) as KiloGeneratedConfig;
    expect(loopback.provider[OPENCODE_PROVIDER_ID]!.options.apiKey).toBe(KILO_API_KEY_ENV_REF);
    expect(loopback.provider[OPENCODE_PROVIDER_ID]!.options.headers).toBeUndefined();

    const remote = buildClientConfig("kilo", context({ ...REMOTE, apiKeys: [{ key: sentinel }] } as OcxConfig)) as KiloGeneratedConfig;
    expect(remote.provider[OPENCODE_PROVIDER_ID]!.options.apiKey).toBeUndefined();
    expect(remote.provider[OPENCODE_PROVIDER_ID]!.options.headers).toEqual({ "x-opencodex-api-key": KILO_API_KEY_ENV_REF });

    const bytes = buildClientConfigText("kilo", context(withKey)).text;
    expect(bytes).not.toContain(sentinel);
    expect(bytes).not.toContain("OPENCODEX_OPENCODE_API_KEY");
    expect(EXPORT_CLIENTS.kilo.loopbackOnly).toBe(false);
    expect(EXPORT_CLIENTS.kilo.filename).toBe("kilo.jsonc");
    expect(EXPORT_CLIENTS.kilo.format).toBe("json");
  });

  test("audio-only and unknown modalities follow OpenCode's capability helper", () => {
    const document = buildClientConfig("kilo", context()) as KiloGeneratedConfig;
    const models = document.provider[OPENCODE_PROVIDER_ID]!.models;
    expect(models["audio/only"]).toEqual({
      name: "only (audio)",
      attachment: true,
      modalities: { input: ["audio"], output: ["text"] },
    });
    expect(models["unknown/mod"]).toEqual({ name: "mod (unknown)" });
    expect(models["mystery/model"]!.limit).toBeUndefined();
    expect(EXPORT_CLIENTS.kilo.summarize(document)).toEqual({ modelCount: 4, modelsWithoutLimits: 3 });
  });

  test("path order: first existing candidate wins; empty dir is kilo.jsonc; XDG relocates", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-kilo-path-"));
    try {
      const home = join(root, "home");
      const dir = kiloHomeDir({}, home);
      expect(dir).toBe(join(home, ".config", "kilo"));
      mkdirSync(dir, { recursive: true });
      expect(kiloConfigPath({}, home)).toBe(join(dir, "kilo.jsonc"));
      writeFileSync(join(dir, "config.json"), "{}\n");
      expect(kiloConfigPath({}, home)).toBe(join(dir, "config.json"));
      writeFileSync(join(dir, "kilo.json"), "{}\n");
      expect(kiloConfigPath({}, home)).toBe(join(dir, "kilo.json"));
      writeFileSync(join(dir, "kilo.jsonc"), "{}\n");
      expect(kiloConfigPath({}, home)).toBe(join(dir, "kilo.jsonc"));

      const xdg = join(root, "xdg");
      mkdirSync(join(xdg, "kilo"), { recursive: true });
      expect(kiloHomeDir({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "kilo"));
      expect(kiloConfigPath({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "kilo", "kilo.jsonc"));
      expect(INTEGRATION_CLIENTS.kilo.detectDir({ XDG_CONFIG_HOME: xdg }, home)).toBe(join(xdg, "kilo"));
    } finally {
      removeTreeWithRetry(root);
    }
  });
});

describe("kilo JSONC apply/disable/restore", () => {
  let home: string;
  let store: IntegrationStateStore;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ocx-kilo-writer-"));
    home = join(base, "home");
    mkdirSync(home, { recursive: true });
    store = createIntegrationStateStore(join(base, "store", "integrations"));
  });

  afterEach(() => {
    removeTreeWithRetry(dirname(home));
  });

  const kitchenSink = `{
  // user comment
  "$schema": "https://app.kilo.ai/config.json",
  "model": "anthropic/claude-opus-4",
  "enabled_providers": ["anthropic"],
  "mcp": { "keep": true },
  "provider": {
    "anthropic": { "npm": "@ai-sdk/anthropic" },
  },
}
`;

  test("JSONC comments and trailing commas parse; apply/disable leave non-owned keys", () => {
    const spec = INTEGRATION_CLIENTS.kilo;
    mkdirSync(spec.detectDir({}, home), { recursive: true });
    const configPath = spec.configPath({}, home);
    writeFileSync(configPath, kitchenSink);

    const parsed = parseConfig(kitchenSink, "json", { jsonc: true });
    expect(parsed).not.toBe(PARSE_FAILED);
    expect(parsed).toMatchObject({
      model: "anthropic/claude-opus-4",
      enabled_providers: ["anthropic"],
      mcp: { keep: true },
      provider: { anthropic: { npm: "@ai-sdk/anthropic" } },
    });
    expect(parseConfig(kitchenSink, "json")).toBe(PARSE_FAILED);

    const write = {
      clientId: "kilo" as const,
      models: context().models,
      config: LOOPBACK,
      port: 10100,
      env: {} as NodeJS.ProcessEnv,
      home,
      store,
    };
    const applied = applyIntegration(write);
    expect(applied.ok).toBe(true);
    const afterApply = JSON.parse(readFileSync(configPath, "utf8")) as KiloGeneratedConfig & {
      model: string;
      enabled_providers: string[];
      mcp: { keep: boolean };
      provider: Record<string, unknown>;
    };
    expect(afterApply.model).toBe("anthropic/claude-opus-4");
    expect(afterApply.enabled_providers).toEqual(["anthropic"]);
    expect(afterApply.mcp).toEqual({ keep: true });
    expect(afterApply.provider.anthropic).toEqual({ npm: "@ai-sdk/anthropic" });
    expect(afterApply.provider[OPENCODE_PROVIDER_ID]).toBeDefined();
    expect(afterApply).not.toHaveProperty("providers");

    const disabled = disableIntegration(write);
    expect(disabled.ok).toBe(true);
    const afterDisable = JSON.parse(readFileSync(configPath, "utf8")) as typeof afterApply;
    expect(afterDisable.provider[OPENCODE_PROVIDER_ID]).toBeUndefined();
    expect(afterDisable.provider.anthropic).toEqual({ npm: "@ai-sdk/anthropic" });
    expect(afterDisable.model).toBe("anthropic/claude-opus-4");
    expect(afterDisable.mcp).toEqual({ keep: true });

    const restored = restoreIntegration({ ...write, opId: store.listOperations("kilo")[0]!.opId });
    expect(restored.ok).toBe(true);
  });

  test("a block comment is a token separator, not deletion: malformed values refuse", () => {
    // `1/*x*/2` is two tokens; stripping the comment to nothing would yield
    // `12` — a different valid value. The stripper keeps a separator, so the
    // rewrite gate sees a parse failure instead of a changed user value.
    expect(parseConfig('{"value":1/*c*/2}', "json", { jsonc: true })).toBe(PARSE_FAILED);
    // Where a comment was, whitespace is legal: valid JSONC is unaffected.
    expect(parseConfig('{"value": 1 /* keep */ , "b": [1,/*c*/2]}', "json", { jsonc: true })).toEqual({ value: 1, b: [1, 2] });
  });

  test("an unterminated block comment is PARSE_FAILED, and apply refuses without touching the file", () => {
    const spec = INTEGRATION_CLIENTS.kilo;
    mkdirSync(spec.detectDir({}, home), { recursive: true });
    const configPath = spec.configPath({}, home);
    const poisoned = '{\n  "model": "keep",\n  /* never closed\n';
    writeFileSync(configPath, poisoned);

    // Stripping an unterminated block comment would delete the malformed tail;
    // the stripper throws instead so the rewrite gate sees a parse failure.
    expect(parseConfig(poisoned, "json", { jsonc: true })).toBe(PARSE_FAILED);

    const applied = applyIntegration({
      clientId: "kilo", models: context().models, config: LOOPBACK,
      port: 10100, env: {} as NodeJS.ProcessEnv, home, store,
    });
    expect(applied.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(poisoned);
  });

  test("lifecycle stays bound to the owned file when a higher-priority candidate appears", () => {
    /*
     * Resolution picks the first EXISTING candidate, so apply can own
     * config.json while a later-created kilo.jsonc wins discovery. The
     * ownership record then binds reads and mutations to config.json while
     * it still exists: status reports it, disable removes OUR block from it,
     * and the newcomer is never touched. Only after the record is dropped
     * does priority discovery pick kilo.jsonc up again.
     */
    const spec = INTEGRATION_CLIENTS.kilo;
    const dir = spec.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const ownedPath = join(dir, "config.json");
    writeFileSync(ownedPath, "{}\n");

    const write = {
      clientId: "kilo" as const,
      models: context().models,
      config: LOOPBACK,
      port: 10100,
      env: {} as NodeJS.ProcessEnv,
      home,
      store,
    };
    expect(applyIntegration(write).ok).toBe(true);
    const owned = readFileSync(ownedPath, "utf8");
    expect(owned).toContain(OPENCODE_PROVIDER_ID);

    const newcomer = join(dir, "kilo.jsonc");
    const newcomerText = '{ "model": "keep" }\n';
    writeFileSync(newcomer, newcomerText);

    const bound = readIntegrationState(write);
    expect(bound.state).toBe("current");
    expect(bound.configPath).toBe(ownedPath);

    const disabled = disableIntegration(write);
    expect(disabled.ok).toBe(true);
    const afterDisable = JSON.parse(readFileSync(ownedPath, "utf8")) as { provider?: Record<string, unknown> };
    expect(afterDisable.provider?.[OPENCODE_PROVIDER_ID]).toBeUndefined();
    expect(readFileSync(newcomer, "utf8")).toBe(newcomerText);

    // Record dropped: discovery is priority again, pointing at the newcomer.
    const released = readIntegrationState(write);
    expect(released.state).toBe("absent");
    expect(released.configPath).toBe(newcomer);
  });

  test("restore and its preview stay bound to the journaled file when a higher-priority candidate appears", () => {
    const spec = INTEGRATION_CLIENTS.kilo;
    const dir = spec.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const ownedPath = join(dir, "config.json");
    writeFileSync(ownedPath, "{}\n");

    const write = {
      clientId: "kilo" as const,
      models: context().models,
      config: LOOPBACK,
      port: 10100,
      env: {} as NodeJS.ProcessEnv,
      home,
      store,
    };
    expect(applyIntegration(write).ok).toBe(true);

    const newcomer = join(dir, "kilo.jsonc");
    const newcomerText = '{ "model": "keep" }\n';
    writeFileSync(newcomer, newcomerText);

    expect(disableIntegration(write).ok).toBe(true);
    const disableOp = store.listOperations("kilo")[0]!;

    // Fresh priority discovery now picks the newcomer; the journaled disable
    // op names config.json, still one of Kilo's own candidates here, so both
    // restore paths act on the journaled file instead of refusing.
    const preview = previewIntegration(write, { operation: "restore", opId: disableOp.opId });
    expect(preview.refusalReason).toBeUndefined();
    expect(preview.canApply).toBe(true);

    const restored = restoreIntegration({ ...write, opId: disableOp.opId });
    expect(restored.ok).toBe(true);
    expect(readFileSync(ownedPath, "utf8")).toContain(OPENCODE_PROVIDER_ID);
    expect(readFileSync(newcomer, "utf8")).toBe(newcomerText);
  });
});
