import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  readConfigDiagnostics,
  saveConfig,
  validateConfigCandidate,
} from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-display-names-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function candidate(modelDisplayNames: unknown) {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        note: "keep me",
        modelDisplayNames,
      },
    },
  };
}

function writeCandidate(modelDisplayNames: unknown, provider = "xai"): void {
  const config = candidate(modelDisplayNames);
  config.defaultProvider = provider;
  config.providers = {
    [provider]: {
      ...config.providers.xai,
      modelDisplayNames,
    },
  };
  writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

function writeAutoReviewConfig(autoReviewModel: unknown, autoReviewModelOverrides: unknown): void {
  const defaults = getDefaultConfig();
  writeFileSync(getConfigPath(), JSON.stringify({
    ...defaults,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        note: "keep me",
        autoReviewModel,
        autoReviewModelOverrides,
      },
    },
  }), "utf8");
}

test("config validation accepts only safe provider model display names", () => {
  const valid = validateConfigCandidate(candidate({
    "grok-4.6": "Grok 4.6",
    "models/grok-vision": "Grok Vision",
  }));
  expect(valid.ok).toBe(true);

  const invalid = validateConfigCandidate(candidate({ "grok-4.6": "Grok/4.6" }));
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error).toContain("modelDisplayNames");
});

test("load keeps a provider and valid labels when one hand edited label is invalid", () => {
  writeCandidate({
    "grok-4.6": "  Grok 4.6  ",
    "future-model": "Future Model",
    unsafe: "Bad/Name",
  });

  const loaded = loadConfig();

  expect(loaded.providers.xai).toMatchObject({
    note: "keep me",
    modelDisplayNames: {
      "grok-4.6": "Grok 4.6",
      "future-model": "Future Model",
    },
  });
  expect(loaded.providers.xai.modelDisplayNames).not.toHaveProperty("unsafe");
});

test("load and save preserve a prototype shaped model id as data", () => {
  writeCandidate(JSON.parse('{"__proto__":"Prototype Model"}'));

  const loaded = loadConfig();

  expect(Object.hasOwn(loaded.providers.xai.modelDisplayNames ?? {}, "__proto__")).toBe(true);
  expect(loaded.providers.xai.modelDisplayNames?.["__proto__"]).toBe("Prototype Model");

  saveConfig(loaded);
  const reloaded = loadConfig();

  expect(Object.hasOwn(reloaded.providers.xai.modelDisplayNames ?? {}, "__proto__")).toBe(true);
  expect(reloaded.providers.xai.modelDisplayNames?.["__proto__"]).toBe("Prototype Model");
});

test("load drops only a malformed display name map", () => {
  writeCandidate("not-an-object");

  const loaded = loadConfig();

  expect(loaded.providers.xai).toMatchObject({ note: "keep me" });
  expect(loaded.providers.xai.modelDisplayNames).toBeUndefined();
});

test("load warnings never reveal display values or secret shaped provider names", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const displaySecret = ["sk", "secret", "display", "value"].join("-");
    const providerSecret = ["sk", "secret", "provider", "name"].join("-");
    writeCandidate({ model: `${displaySecret}/unsafe` }, providerSecret);

    const loaded = loadConfig();

    expect(loaded.providers[providerSecret]).toBeDefined();
    const output = warn.mock.calls.map(call => call.join(" ")).join("\n");
    expect(output).not.toContain(displaySecret);
    expect(output).not.toContain(providerSecret);
    expect(output).toContain("[REDACTED]");
  } finally {
    warn.mockRestore();
  }
});


test("load ignores malformed auto-review selectors without dropping the provider", () => {
  writeAutoReviewConfig("bad selector", { model: "bad selector" });

  const loaded = loadConfig();

  expect(loaded.providers.xai).toMatchObject({ note: "keep me" });
  expect(loaded.providers.xai.autoReviewModel).toBeUndefined();
  expect(loaded.providers.xai.autoReviewModelOverrides).toBeUndefined();
});

test("load preserves valid auto-review selectors and trims boundary whitespace", () => {
  writeAutoReviewConfig("  openai/gpt-test  ", { "glm-5.2": " gpt-test " });

  const loaded = loadConfig();

  expect(loaded.providers.xai.autoReviewModel).toBe("openai/gpt-test");
  expect(loaded.providers.xai.autoReviewModelOverrides).toEqual({ "glm-5.2": "gpt-test" });
});

test("Fast rows default on for fresh and omitted config; explicit false and malformed values disable", () => {
  expect(getDefaultConfig().fastRows).toBe(true);
  for (const [value, expected] of [[undefined, true], [true, true], [false, false], ["invalid", false]] as const) {
    const config = { ...candidate({}), fastRows: value };
    writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
    const loaded = loadConfig();
    expect(loaded.fastRows).toBe(expected);
    expect(loaded.providers.xai.note).toBe("keep me");
  }
});


test("model capability writes stay strict while load preserves independent restrictions", () => {
  const raw = { ...candidate(undefined), providers: { xai: {
    ...candidate(undefined).providers.xai,
    apiKey: "fixture-key", modelCapabilities: {
      ModelA: { inputModalities: ["text"] },
      modela: { contextTier: "long_context" },
      broken: { inputModalities: "image", contextTier: "typo" },
    },
  } } };
  expect(validateConfigCandidate(raw).ok).toBe(false);
  writeFileSync(getConfigPath(), JSON.stringify(raw), "utf8");
  const loaded = loadConfig();
  expect(loaded.providers.xai.modelCapabilities).toEqual({
    ModelA: { inputModalities: ["text"] }, modela: { contextTier: "long_context" },
    broken: { inputModalities: ["text"] },
  });
  expect(loaded.providers.xai.apiKey).toBe("fixture-key");
  expect(validateConfigCandidate(loaded).ok).toBe(true);
});

test("model capabilities round-trip all explicit axes without expanding inference", () => {
  const raw = { ...candidate(undefined), providers: { xai: {
    ...candidate(undefined).providers.xai,
    modelCapabilities: { ModelA: { inputModalities: ["text", "image"], contextTier: "long_context", video: { processing: "agentic" } } },
  } } };
  const validated = validateConfigCandidate(raw);
  expect(validated.ok).toBe(true);
  if (!validated.ok) return;
  saveConfig(validated.config);
  expect(loadConfig().providers.xai.modelCapabilities).toEqual(raw.providers.xai.modelCapabilities);
  expect(loadConfig().providers.xai.modelContextWindows).toBeUndefined();
});

test.each([
  { enabled: "true" },
  { enabled: true, port: 70000 },
  "secret-shaped-malformed-listener-value",
])("malformed optional listeners warn without discarding unrelated settings: %j", listener => {
  const config = { ...candidate(undefined),
    apiKeys: [{ id: "preserved", name: "preserved", key: "fixture-key", createdAt: "2026-01-01" }],
    unauthenticatedLoopbackListener: listener,
    hub: { managementIngress: listener },
  };
  const bytes = JSON.stringify(config);
  writeFileSync(getConfigPath(), bytes);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const loaded = loadConfig();
    expect(loaded.providers.xai.note).toBe("keep me");
    expect(loaded.apiKeys?.[0]?.id).toBe("preserved");
    expect(loaded.unauthenticatedLoopbackListener).toBeUndefined();
    expect(loaded.hub?.managementIngress).toBeUndefined();
    const messages = warn.mock.calls.flat().join("\n");
    expect(messages).toContain("unauthenticatedLoopbackListener ignored");
    expect(messages).toContain("hub.managementIngress ignored");
    expect(messages).not.toContain("secret-shaped-malformed-listener-value");
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.warnings?.join("\n")).toContain("unauthenticatedLoopbackListener ignored");
    expect(diagnostics.warnings?.join("\n")).toContain("hub.managementIngress ignored");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  } finally { warn.mockRestore(); }
});

test.each([undefined, { enabled: false }])("absent or disabled listeners do not produce degradation warnings: %j", listener => {
  writeFileSync(getConfigPath(), JSON.stringify({ ...candidate(undefined),
    unauthenticatedLoopbackListener: listener, hub: { managementIngress: listener },
  }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    loadConfig();
    const messages = warn.mock.calls.flat().join("\n");
    expect(messages).not.toContain("Listener ignored");
    expect(messages).not.toContain("managementIngress ignored");
  } finally { warn.mockRestore(); }
});

test("salvaged diagnostics retain listener warnings alongside the routing error", () => {
  const bytes = JSON.stringify({ ...candidate(undefined),
    routingProfiles: { bad: { candidates: [] } },
    unauthenticatedLoopbackListener: { enabled: "true" },
    hub: { managementIngress: { enabled: true, port: 70000 } },
  });
  writeFileSync(getConfigPath(), bytes);
  const diagnostics = readConfigDiagnostics();
  expect(diagnostics.source).toBe("fallback");
  expect(diagnostics.error).toContain("routingProfiles");
  expect(diagnostics.config.providers.xai.note).toBe("keep me");
  expect(diagnostics.warnings?.join("\n")).toContain("unauthenticatedLoopbackListener ignored");
  expect(diagnostics.warnings?.join("\n")).toContain("hub.managementIngress ignored");
  expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
});


test("valid ingress is not blamed when a malformed hub sibling disables the hub block", () => {
  const bytes = JSON.stringify({ ...candidate(undefined), hub: {
    dataPublicOrigin: "not-an-origin", managementIngress: { enabled: true, port: 12345 },
  } });
  writeFileSync(getConfigPath(), bytes);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const loaded = loadConfig();
    expect(loaded.hub).toBeUndefined();
    expect(loaded.providers.xai.note).toBe("keep me");
    const messages = warn.mock.calls.flat().join("\n");
    expect(messages).toContain("hub.dataPublicOrigin");
    expect(messages).not.toContain("hub.managementIngress ignored");
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.warnings?.join("\n")).toContain("hub.dataPublicOrigin");
    expect(diagnostics.warnings?.join("\n")).not.toContain("hub.managementIngress ignored");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  } finally { warn.mockRestore(); }});

const DESKTOP_PROFILE = {
  version: 1,
  assignments: {
    "opencode-go/deepseek-flash": { family: "opus", alias: "claude-opus-4-8-20260731" },
  },
  defaults: { opus: "opencode-go/deepseek-flash", fable: null, sonnet: null, haiku: null },
};

function writeClaudeDesktopConfig(desktopProfile: unknown): string {
  const bytes = JSON.stringify({
    ...candidate(undefined),
    claudeCode: { enabled: true, authMode: "proxy", desktopProfile },
  });
  writeFileSync(getConfigPath(), bytes);
  return bytes;
}

test("null desktopProfile applied markers do not replace the operator config (#4430)", () => {
  const bytes = writeClaudeDesktopConfig({
    ...DESKTOP_PROFILE,
    appliedFingerprint: null,
    appliedAt: null,
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const loaded = loadConfig();
    expect(loaded.providers.xai.note).toBe("keep me");
    expect(loaded.claudeCode?.desktopProfile).toMatchObject(DESKTOP_PROFILE);
    expect(loaded.claudeCode?.desktopProfile).not.toHaveProperty("appliedFingerprint");
    expect(loaded.claudeCode?.desktopProfile).not.toHaveProperty("appliedAt");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    expect(error.mock.calls.join("\n")).not.toContain("Using default config");
  } finally { error.mockRestore(); }
});

test("an invalid desktopProfile is dropped without resetting providers (#4430)", () => {
  const bytes = writeClaudeDesktopConfig({ ...DESKTOP_PROFILE, version: 2 });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const loaded = loadConfig();
    expect(loaded.providers.xai.note).toBe("keep me");
    expect(loaded.claudeCode?.desktopProfile).toBeUndefined();
    expect(loaded.claudeCode?.enabled).toBe(true);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    expect(error.mock.calls.join("\n")).toContain("claudeCode.desktopProfile");
    expect(error.mock.calls.join("\n")).toContain("preserved");
    expect(error.mock.calls.join("\n")).not.toContain("Using default config");
  } finally { error.mockRestore(); }
});

function writePoolConfig(credentialGroups: unknown): string {
  const bytes = JSON.stringify({
    ...candidate(undefined),
    pool: { kernel: true, cacheAffinity: false, credentialGroups },
  });
  writeFileSync(getConfigPath(), bytes);
  return bytes;
}

test("a malformed credentialGroups entry costs the list, not the rest of pool (#4546)", () => {
  const bytes = writePoolConfig([
    { id: "team", credentials: ["openai:key-a"] },
    { id: "", credentials: [] },
  ]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const loaded = loadConfig();
    expect(loaded.pool?.credentialGroups).toBeUndefined();
    // The two siblings are live routing settings: an outer catch used to take them both
    // because one group failed the nested object.
    expect(loaded.pool?.kernel).toBe(true);
    expect(loaded.pool?.cacheAffinity).toBe(false);
    expect(loaded.providers.xai.note).toBe("keep me");
    expect(warn.mock.calls.flat().join("\n")).toContain("pool.credentialGroups");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
  } finally { warn.mockRestore(); }
});

test("an ambiguous credentialGroups declaration is rejected on write, never ordered away (#4546)", () => {
  const base = candidate(undefined);
  const withGroups = (credentialGroups: unknown) => ({ ...base, pool: { kernel: true, credentialGroups } });

  const twoGroups = validateConfigCandidate(withGroups([
    { id: "left", credentials: ["openai:key-a"] },
    { id: "right", credentials: ["openai:key-a"] },
  ]));
  expect(twoGroups.ok).toBe(false);
  expect(twoGroups.ok === false && twoGroups.error).toContain("pool.credentialGroups");

  const duplicateId = validateConfigCandidate(withGroups([
    { id: "team", credentials: ["openai:key-a"] },
    { id: "team", credentials: ["openai:key-b"] },
  ]));
  expect(duplicateId.ok).toBe(false);
  expect(duplicateId.ok === false && duplicateId.error).toContain("duplicate group id");

  const bareId = validateConfigCandidate(withGroups([{ id: "team", credentials: ["key-a"] }]));
  expect(bareId.ok).toBe(false);
  expect(bareId.ok === false && bareId.error).toContain("provider-qualified");

  const empty = validateConfigCandidate(withGroups([{ id: "team", credentials: [] }]));
  expect(empty.ok).toBe(false);

  const valid = validateConfigCandidate(withGroups([
    { id: "team", credentials: ["openai:key-a", "azure:key-a"], note: "one billed org" },
  ]));
  expect(valid.ok).toBe(true);
  expect(valid.ok === true && valid.config.pool?.credentialGroups).toHaveLength(1);
});
