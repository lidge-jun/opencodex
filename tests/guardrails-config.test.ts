import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armClaudeCodeBaseline,
  deleteConfigTopLevelKey,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfig,
  saveConfigPreservingClaudeCode,
  setPersistedConfigMutationBeforeCommitForTests,
  validateConfigCandidate,
} from "../src/config";
import {
  GuardrailsConfigRevisionConflictError,
  mutateAndAdoptGuardrailsConfig,
} from "../src/guardrails/config-coordinator";
import {
  MAX_GUARDRAILS_PROVIDER_IDS,
  applyGuardrailsSettingsPatch,
  guardrailsApiSettings,
  guardrailsConfigEqual,
  parseGuardrailsConfig,
  parseGuardrailsSettingsPatch,
} from "../src/guardrails/config-schema";
import { guardrailsPolicyRevision } from "../src/guardrails/runtime";

let testHome = "";
const previousHome = process.env.OPENCODEX_HOME;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-guardrails-config-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

test("malformed persisted Guardrails config degrades to disabled without losing providers", () => {
  const raw = { ...getDefaultConfig(), guardrails: { enabled: "yes" } };
  writeFileSync(getConfigPath(), JSON.stringify(raw));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const loaded = loadConfig();
    expect(loaded.guardrails).toBeUndefined();
    expect(loaded.providers.openai).toBeDefined();
    expect(warnings.join("\n")).toContain("guardrails");
  } finally {
    console.warn = originalWarn;
  }
});

test("strict config validation rejects an invalid Guardrails write candidate", () => {
  const result = validateConfigCandidate({ ...getDefaultConfig(), guardrails: { enabled: "yes" } });
  expect(result.ok).toBe(false);
});

test("strict config validation accepts a complete enforce policy with a declarative custom rule", () => {
  const result = validateConfigCandidate({
    ...getDefaultConfig(),
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "block",
      enabledDataTypes: [1, 6],
      customRules: [{
        ruleId: "custom.secret",
        name: "Custom secret",
        dataType: 6,
        group: "CUSTOM",
        groupPriority: 0,
        displayName: "Custom",
        description: "Test-only declarative rule",
        regex: "(custom_[A-Za-z0-9]{8})",
        keywords: [],
        banlist: [],
        validators: [],
        masking: { captureGroups: [1], placeholderType: "CUSTOM_SECRET" },
      }],
    },
  });
  expect(result.ok).toBe(true);
});

test("provider scope defaults to all and explicit all normalizes to absence", () => {
  const absent = parseGuardrailsConfig({ enabled: true });
  const explicit = parseGuardrailsConfig({
    enabled: true,
    providerScope: { mode: "all" },
  });

  expect(absent).toEqual({ ok: true, config: { enabled: true } });
  expect(explicit).toEqual({ ok: true, config: { enabled: true } });
  expect(guardrailsApiSettings(absent.ok ? absent.config : undefined).providerScope)
    .toEqual({ mode: "all" });
  expect(guardrailsConfigEqual(
    { enabled: true },
    { enabled: true, providerScope: { mode: "all" } },
  )).toBe(true);
});

test("selected provider scope accepts unique valid IDs and normalizes their order", () => {
  const parsed = parseGuardrailsConfig({
    enabled: true,
    providerScope: {
      mode: "selected",
      providerIds: ["zeta", "anthropic-native", "alpha"],
    },
  });

  expect(parsed).toEqual({
    ok: true,
    config: {
      enabled: true,
      providerScope: {
        mode: "selected",
        providerIds: ["alpha", "anthropic-native", "zeta"],
      },
    },
  });
});

test("selected provider scope rejects empty, duplicate, invalid, and over-limit IDs", () => {
  const invalidScopes = [
    { mode: "selected", providerIds: [] },
    { mode: "selected", providerIds: ["alpha", "alpha"] },
    { mode: "selected", providerIds: ["provider/model"] },
    {
      mode: "selected",
      providerIds: Array.from(
        { length: MAX_GUARDRAILS_PROVIDER_IDS + 1 },
        (_value, index) => `provider-${index}`,
      ),
    },
  ];

  for (const providerScope of invalidScopes) {
    expect(parseGuardrailsConfig({ providerScope }).ok).toBe(false);
  }
});

test("provider scope participates in settings patching, equality, and API projection", () => {
  const previous = {
    enabled: true,
    providerScope: {
      mode: "selected" as const,
      providerIds: ["zeta", "alpha"],
    },
  };
  const clear = parseGuardrailsSettingsPatch({
    providerScope: { mode: "all" },
  });

  expect(clear).toEqual({
    ok: true,
    patch: { providerScope: { mode: "all" } },
  });
  const next = clear.ok
    ? applyGuardrailsSettingsPatch(previous, clear.patch)
    : previous;
  expect(next).toEqual({ enabled: true });
  expect(guardrailsConfigEqual(
    previous,
    {
      enabled: true,
      providerScope: {
        mode: "selected",
        providerIds: ["alpha", "zeta"],
      },
    },
  )).toBe(true);

  const projected = guardrailsApiSettings(previous).providerScope;
  expect(projected).toEqual({
    mode: "selected",
    providerIds: ["zeta", "alpha"],
  });
  if (projected.mode === "selected") projected.providerIds.push("mutated");
  expect(previous.providerScope.providerIds).toEqual(["zeta", "alpha"]);
});

test("strict config validation rejects no-op entropy and banlist validators", () => {
  const baseRule = {
    ruleId: "custom.validator",
    name: "Custom validator",
    dataType: 6,
    group: "CUSTOM",
    groupPriority: 0,
    displayName: "Custom validator",
    description: "Test-only declarative rule",
    regex: "(custom_[A-Za-z0-9]{8})",
    minLength: 8,
    keywords: [],
    masking: { captureGroups: [1], placeholderType: "CUSTOM_VALIDATOR" },
  };
  const missingEntropy = validateConfigCandidate({
    ...getDefaultConfig(),
    guardrails: {
      customRules: [{
        ...baseRule,
        banlist: [],
        validators: ["entropy"],
      }],
    },
  });
  const emptyBanlist = validateConfigCandidate({
    ...getDefaultConfig(),
    guardrails: {
      customRules: [{
        ...baseRule,
        banlist: [],
        validators: ["banlist"],
      }],
    },
  });

  expect(missingEntropy.ok).toBe(false);
  expect(emptyBanlist.ok).toBe(false);
});

test("field-scoped coordinator commits and adopts Guardrails without rewriting the live config", () => {
  saveConfig(getDefaultConfig());
  const liveConfig = loadConfig();
  armClaudeCodeBaseline(liveConfig);

  const outcome = mutateAndAdoptGuardrailsConfig(liveConfig, {
    disabledBuiltinRuleIds: ["api_keys.stripe-key"],
    keywordPrefilterEnabled: true,
  }, guardrailsPolicyRevision(liveConfig.guardrails ?? {}));

  expect(outcome).toMatchObject({ status: "committed" });
  expect(liveConfig.guardrails).toEqual({
    disabledBuiltinRuleIds: ["api_keys.stripe-key"],
    keywordPrefilterEnabled: true,
  });
  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { guardrails?: unknown };
  expect(persisted.guardrails).toEqual(liveConfig.guardrails);
});

test("first Guardrails save materializes a missing config from the live defaults", () => {
  const liveConfig = loadConfig();
  expect(existsSync(getConfigPath())).toBe(false);

  const outcome = mutateAndAdoptGuardrailsConfig(
    liveConfig,
    { enabled: true },
    guardrailsPolicyRevision(liveConfig.guardrails ?? {}),
  );

  expect(outcome).toMatchObject({ status: "committed", value: { enabled: true } });
  expect(liveConfig.guardrails).toEqual({ enabled: true });
  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { guardrails?: unknown };
  expect(persisted.guardrails).toEqual({ enabled: true });
});

test("first-run initialization never recreates a config that existed during the mutation", () => {
  saveConfig(getDefaultConfig());
  const liveConfig = loadConfig();
  setPersistedConfigMutationBeforeCommitForTests(() => rmSync(getConfigPath()));

  const outcome = mutateAndAdoptGuardrailsConfig(
    liveConfig,
    { enabled: true },
    guardrailsPolicyRevision(liveConfig.guardrails ?? {}),
  );

  expect(outcome).toEqual({ status: "unavailable", reason: "missing" });
  expect(existsSync(getConfigPath())).toBe(false);
  expect(liveConfig.guardrails).toBeUndefined();
});

test("explicit disable normalizes an empty hand-edited Guardrails object to canonical absence", () => {
  writeFileSync(getConfigPath(), JSON.stringify({ ...getDefaultConfig(), guardrails: {} }));
  const liveConfig = loadConfig();
  const outcome = mutateAndAdoptGuardrailsConfig(
    liveConfig,
    { enabled: false },
    guardrailsPolicyRevision(liveConfig.guardrails ?? {}),
  );

  expect(outcome).toMatchObject({ status: "committed", value: undefined });
  expect(liveConfig.guardrails).toBeUndefined();
  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as {
    configRebaseProvenance?: unknown;
    guardrails?: unknown;
  };
  expect(persisted).not.toHaveProperty("guardrails");
  expect(persisted.configRebaseProvenance).toEqual({
    version: 1,
    deletedTopLevelKeys: ["guardrails"],
  });
});

test("coordinator rejects an invalid custom RE2 rule before changing disk or live config", () => {
  saveConfig(getDefaultConfig());
  const liveConfig = loadConfig();

  expect(() => mutateAndAdoptGuardrailsConfig(liveConfig, {
    customRules: [{
      ruleId: "custom.invalid",
      name: "Invalid rule",
      dataType: 6,
      group: "CUSTOM",
      groupPriority: 0,
      displayName: "Invalid",
      description: "Must not commit",
      regex: "(",
      keywords: [],
      banlist: [],
      validators: [],
      masking: { captureGroups: [1], placeholderType: "CUSTOM_INVALID" },
    }],
  }, guardrailsPolicyRevision(liveConfig.guardrails ?? {}))).toThrow("not RE2 compatible");

  expect(liveConfig.guardrails).toBeUndefined();
  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as { guardrails?: unknown };
  expect(persisted.guardrails).toBeUndefined();
});

test("coordinator checks the expected revision against disk after lock acquisition", () => {
  saveConfig(getDefaultConfig());
  const liveConfig = loadConfig();
  const expectedRevision = guardrailsPolicyRevision(liveConfig.guardrails ?? {});
  const externallyEdited = {
    ...getDefaultConfig(),
    guardrails: { mode: "detect" as const },
  };
  writeFileSync(getConfigPath(), `${JSON.stringify(externallyEdited, null, 2)}\n`);

  expect(() => mutateAndAdoptGuardrailsConfig(
    liveConfig,
    { enabled: true },
    expectedRevision,
  )).toThrow(GuardrailsConfigRevisionConflictError);

  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as {
    guardrails?: { enabled?: boolean; mode?: string };
  };
  expect(persisted.guardrails).toEqual({ mode: "detect" });
  expect(liveConfig.guardrails).toBeUndefined();
});

test("coordinator rejects a stale revision after an external disk edit during rebase", () => {
  saveConfig(getDefaultConfig());
  const liveConfig = loadConfig();
  const expectedRevision = guardrailsPolicyRevision(liveConfig.guardrails ?? {});
  const externallyEdited = {
    ...getDefaultConfig(),
    guardrails: { mode: "detect" as const },
  };
  setPersistedConfigMutationBeforeCommitForTests(() => {
    writeFileSync(getConfigPath(), `${JSON.stringify(externallyEdited, null, 2)}\n`);
  });

  expect(() => mutateAndAdoptGuardrailsConfig(
    liveConfig,
    { enabled: true },
    expectedRevision,
  )).toThrow(GuardrailsConfigRevisionConflictError);

  const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as {
    guardrails?: { enabled?: boolean; mode?: string };
  };
  expect(persisted.guardrails).toEqual({ mode: "detect" });
  expect(liveConfig.guardrails).toBeUndefined();
});

test("stale Guardrails writes preserve top-level deletion provenance without resurrection", () => {
  const initial = getDefaultConfig();
  initial.injectionPrompt = "delete-me";
  saveConfig(initial);
  const staleLiveConfig = loadConfig();
  armClaudeCodeBaseline(staleLiveConfig);

  const deletingWriter = loadConfig();
  deleteConfigTopLevelKey(deletingWriter, "injectionPrompt");
  saveConfig(deletingWriter);

  const outcome = mutateAndAdoptGuardrailsConfig(
    staleLiveConfig,
    { enabled: true },
    guardrailsPolicyRevision(staleLiveConfig.guardrails ?? {}),
  );

  expect(outcome).toMatchObject({ status: "committed", value: { enabled: true } });
  let persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as {
    configRebaseProvenance?: unknown;
    guardrails?: unknown;
    injectionPrompt?: unknown;
  };
  expect(persisted.injectionPrompt).toBeUndefined();
  expect(persisted.guardrails).toEqual({ enabled: true });
  expect(persisted.configRebaseProvenance).toEqual({
    version: 1,
    deletedTopLevelKeys: ["injectionPrompt"],
  });

  saveConfigPreservingClaudeCode(staleLiveConfig);
  persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
  expect(persisted.injectionPrompt).toBeUndefined();
});
