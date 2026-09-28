import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
import { PARSE_FAILED, fileIO, parseConfig } from "../../src/integrations/config-io";
import { inspectKiloCandidates } from "../../src/integrations/kilo-candidates";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { readIntegrationState } from "../../src/integrations/state";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { applyIntegration, disableIntegration, overwriteIntegration, restoreIntegration } from "../../src/integrations/writer";
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
  test("uses the model output limit in Kilo's context metadata", () => {
    const document = buildClientConfig("kilo", {
      ...context(),
      models: [{ namespaced: "custom/limited", provider: "custom", id: "limited", contextWindow: 100_000, maxTokens: 8_192 }],
    }) as KiloGeneratedConfig;
    expect(document.provider[OPENCODE_PROVIDER_ID]?.models["custom/limited"]?.limit)
      .toEqual({ context: 100_000, output: 8_192 });
  });

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

  test("emits the exact documented provider shape for one routed model", () => {
    expect(buildClientConfig("kilo", { ...context(), models: [
      { namespaced: "sample/model", provider: "sample", id: "model", displayName: "Sample", contextWindow: 8192, maxTokens: 1024 },
    ] })).toEqual({
      $schema: "https://app.kilo.ai/config.json",
      provider: { opencodex: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCodex",
        options: { baseURL: "http://127.0.0.1:10100/v1", apiKey: "{env:OPENCODEX_KILO_API_KEY}" },
        models: { "sample/model": { name: "Sample (sample)", limit: { context: 8192, output: 1024 } } },
      } },
    });
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

  test("Windows-shaped home and XDG paths retain native separators", () => {
    expect(kiloHomeDir({}, "C:\\Users\\Ada")).toBe("C:\\Users\\Ada\\.config\\kilo");
    expect(kiloHomeDir({ XDG_CONFIG_HOME: "" }, "C:\\Users\\Ada"))
      .toBe("C:\\Users\\Ada\\.config\\kilo");
    expect(INTEGRATION_CLIENTS.kilo.detectDir({ XDG_CONFIG_HOME: "" }, "C:\\Users\\Ada"))
      .toBe("C:\\Users\\Ada\\.config\\kilo");
    expect(kiloConfigPath({}, "C:\\Users\\Ada")).toBe("C:\\Users\\Ada\\.config\\kilo\\kilo.jsonc");
    expect(kiloConfigPath({ XDG_CONFIG_HOME: "D:\\settings" }, "C:\\Users\\Ada"))
      .toBe("D:\\settings\\kilo\\kilo.jsonc");
  });

  test("candidate read failures report unparseable, while non-files report their shape", () => {
    const home = "C:\\Users\\Ada";
    const selectedPath = kiloConfigPath({}, home);
    const base = fileIO();
    const inspect = (statKind: ReturnType<typeof base.statKind>) => inspectKiloCandidates({
      io: { ...base, statKind: () => statKind }, selectedPath, home, env: {},
    });
    expect(inspect("failed")).toEqual({ kind: "unsafe", path: selectedPath, why: "unparseable" });
    expect(inspect("directory")).toEqual({ kind: "unsafe", path: selectedPath, why: "not-regular-file" });
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

  function writeInput() {
    return { clientId: "kilo" as const, models: context().models, config: LOOPBACK,
      port: 10100, env: {} as NodeJS.ProcessEnv, home, store };
  }

  test("absent Kilo install refuses apply without creating its config", () => {
    const result = applyIntegration(writeInput());
    expect(result.ok).toBe(false);
    expect(readIntegrationState(writeInput()).installed).toBe(false);
    expect(INTEGRATION_CLIENTS.kilo.configPath({}, home)).toBe(join(home, ".config", "kilo", "kilo.jsonc"));
  });

  test("status, preview and apply refuse two candidate files with distinct provider blocks", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "kilo.jsonc");
    const later = join(dir, "opencode.jsonc");
    const firstText = '{"provider":{"opencodex":{"name":"first"}}}\n';
    const laterText = '{"provider":{"opencodex":{"name":"later"}}}\n';
    writeFileSync(first, firstText);
    writeFileSync(later, laterText);
    const input = writeInput();
    expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "candidate-conflict", configPath: first, conflictPaths: [later] });
    const preview = previewIntegration(input, { operation: "apply" });
    expect(preview.canApply).toBe(false);
    expect(preview.refusalReason).toBe("conflict");
    expect(previewIntegration(input, { operation: "overwrite" }).canApply).toBe(false);
    const result = applyIntegration(input);
    expect(result.ok).toBe(false);
    expect(overwriteIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
    if (!result.ok) {
      expect(result.reason).toBe("conflict");
      expect(result.message).toContain(first);
      expect(result.message).toContain(later);
    }
    expect(readFileSync(first, "utf8")).toBe(firstText);
    expect(readFileSync(later, "utf8")).toBe(laterText);
    expect(store.listOperations("kilo")).toHaveLength(0);
  });

  test("status names every competing Kilo candidate", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kilo.jsonc"), "{}\n");
    const paths = [join(dir, "kilo.json"), join(dir, "config.json")];
    for (const path of paths) writeFileSync(path, '{"provider":{"opencodex":{}}}\n');
    expect(readIntegrationState(writeInput()).conflictPaths).toEqual(paths);
  });

  test("an owned block can be disabled despite a later competing candidate", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const ownedPath = join(dir, "kilo.jsonc");
    const competingPath = join(dir, "opencode.jsonc");
    writeFileSync(ownedPath, '{"model":"keep"}\n');
    const input = writeInput();
    expect(applyIntegration(input).ok).toBe(true);
    const ownedText = readFileSync(ownedPath, "utf8");
    const competingText = '{"provider":{"opencodex":{"name":"other"}}}\n';
    writeFileSync(competingPath, competingText);

    expect(readIntegrationState(input)).toMatchObject({
      state: "conflict", reason: "candidate-conflict", configPath: ownedPath,
      conflictPaths: [competingPath], lastOpId: expect.any(String),
    });
    for (const operation of ["apply", "overwrite"] as const) {
      expect(previewIntegration(input, { operation })).toMatchObject({ canApply: false, refusalReason: "conflict" });
    }
    expect(applyIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
    expect(overwriteIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
    expect(readFileSync(ownedPath, "utf8")).toBe(ownedText);

    expect(previewIntegration(input, { operation: "disable" }).canApply).toBe(true);
    expect(disableIntegration(input)).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(ownedPath, "utf8"))).toEqual({ model: "keep" });
    expect(readFileSync(competingPath, "utf8")).toBe(competingText);
    expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "candidate-conflict" });
  });

  test("an unparseable later candidate does not strand an owned block", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const ownedPath = join(dir, "kilo.jsonc");
    const laterPath = join(dir, "opencode.jsonc");
    writeFileSync(ownedPath, "{}\n");
    const input = writeInput();
    expect(applyIntegration(input).ok).toBe(true);
    writeFileSync(laterPath, "{broken");
    expect(readIntegrationState(input)).toMatchObject({
      state: "unsafe", reason: "unparseable", candidateFailurePath: laterPath,
      lastOpId: expect.any(String),
    });
    expect(previewIntegration(input, { operation: "apply" }).canApply).toBe(false);
    expect(previewIntegration(input, { operation: "disable" }).canApply).toBe(true);
    expect(disableIntegration(input)).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(ownedPath, "utf8"))).toEqual({});
    expect(readFileSync(laterPath, "utf8")).toBe("{broken");
  });

  test("a later provider block refuses even when the first candidate has none", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kilo.jsonc"), '{"model":"keep"}\n');
    writeFileSync(join(dir, "config.json"), '{"provider":{"opencodex":{"name":"later"}}}\n');
    expect(readIntegrationState(writeInput()).reason).toBe("candidate-conflict");
    expect(applyIntegration(writeInput()).ok).toBe(false);
  });

  test("a candidate created after observation refuses before snapshot", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "kilo.jsonc");
    const later = join(dir, "opencode.jsonc");
    const firstText = '{"model":"keep"}\n';
    const laterText = '{"provider":{"opencodex":{"name":"late"}}}\n';
    writeFileSync(first, firstText);
    const baseIO = store.io();
    let selectedReads = 0;
    const result = applyIntegration({ ...writeInput(), io: {
      ...baseIO,
      readText(path) {
        const read = baseIO.readText(path);
        if (path === first && ++selectedReads === 2) writeFileSync(later, laterText);
        return read;
      },
    } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(readFileSync(first, "utf8")).toBe(firstText);
    expect(readFileSync(later, "utf8")).toBe(laterText);
    expect(store.listOperations("kilo")).toHaveLength(0);
  });

  test("an unsafe second candidate refuses before touching the selected file", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const first = join(dir, "kilo.jsonc");
    writeFileSync(first, '{"model":"keep"}\n');
    symlinkSync(first, join(dir, "opencode.jsonc"));
    expect(readIntegrationState(writeInput())).toMatchObject({ state: "unsafe", reason: "not-regular-file" });
    expect(applyIntegration(writeInput()).ok).toBe(false);
    expect(readFileSync(first, "utf8")).toBe('{"model":"keep"}\n');
  });

  test("restore returns comment-bearing config bytes exactly", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "kilo.jsonc");
    writeFileSync(path, kitchenSink);
    const input = writeInput();
    expect(applyIntegration(input).ok).toBe(true);
    const op = store.listOperations("kilo").find(row => row.kind === "apply");
    expect(op).toBeDefined();
    expect(restoreIntegration({ ...input, opId: op!.opId }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(kitchenSink);
  });

  test("a foreign edit inside the owned block refuses refresh and disable", () => {
    const dir = INTEGRATION_CLIENTS.kilo.detectDir({}, home);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "kilo.jsonc");
    writeFileSync(path, kitchenSink);
    const input = writeInput();
    expect(applyIntegration(input).ok).toBe(true);
    const edited = readFileSync(path, "utf8").replace('"name": "OpenCodex"', '"name": "Personal"');
    writeFileSync(path, edited);
    expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
    expect(applyIntegration(input).ok).toBe(false);
    expect(disableIntegration(input).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

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

  test("refuses a historical restore once another candidate owns the integration", () => {
    /*
     * apply config.json, then a higher-priority kilo.jsonc appears, disable
     * drops the old record, and a fresh apply owns kilo.jsonc. Restoring the
     * historical disable would put config.json's prior record back into the
     * single slot while kilo.jsonc still holds the live block. Later disable
     * would then drop that record and orphan the newcomer. Both restore paths
     * refuse, and the live file stays the one disable removes.
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

    const newcomer = join(dir, "kilo.jsonc");
    const newcomerText = '{ "model": "keep" }\n';
    writeFileSync(newcomer, newcomerText);
    expect(disableIntegration(write).ok).toBe(true);
    const disableOp = store.listOperations("kilo").find(op => op.kind === "disable" && op.configPath === ownedPath);
    expect(disableOp).toBeDefined();

    expect(applyIntegration(write).ok).toBe(true);
    expect(store.readRecords().kilo?.configPath).toBe(newcomer);
    const live = readFileSync(newcomer, "utf8");
    expect(live).toContain(OPENCODE_PROVIDER_ID);
    const retired = readFileSync(ownedPath, "utf8");
    expect(retired).not.toContain(OPENCODE_PROVIDER_ID);

    const preview = previewIntegration(write, { operation: "restore", opId: disableOp!.opId });
    expect(preview.canApply).toBe(false);
    expect(preview.refusalReason).toBe("conflict");

    const restored = restoreIntegration({ ...write, opId: disableOp!.opId });
    expect(restored.ok).toBe(false);
    if (restored.ok) return;
    expect(restored.reason).toBe("conflict");
    expect(restored.message).toContain(newcomer);
    expect(readFileSync(newcomer, "utf8")).toBe(live);
    expect(readFileSync(ownedPath, "utf8")).toBe(retired);
    expect(store.readRecords().kilo?.configPath).toBe(newcomer);

    const disabled = disableIntegration(write);
    expect(disabled.ok).toBe(true);
    const after = JSON.parse(readFileSync(newcomer, "utf8")) as { provider?: Record<string, unknown> };
    expect(after.provider?.[OPENCODE_PROVIDER_ID]).toBeUndefined();
    expect(readFileSync(ownedPath, "utf8")).toBe(retired);
    expect(store.readRecords().kilo).toBeUndefined();
  });
});
