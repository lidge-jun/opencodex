import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import * as configModule from "../../src/config";
import { configuredAnthropicInstance, type AnthropicInstanceId } from "../../src/providers/anthropic-instance";
import { OAUTH_PROVIDERS, OAuthProviderPublicationError, reconcileOAuthProviders, resolveModelsAuthToken, runLogin, upsertOAuthProvider } from "../../src/oauth";
import { AnthropicOAuthFlow, loginAnthropic } from "../../src/oauth/anthropic";
import { bindAnthropicIdentity } from "../../src/oauth/anthropic-identity";
import { AnthropicCrossInstanceDuplicateError, AnthropicInstanceCollisionError, AnthropicLocalCliImportError } from "../../src/oauth/store-anthropic-instance";
import * as localTokens from "../../src/oauth/local-token-detect";
import { getAccountSet, getAuthStorePath, loadAuthStore, mutateStore, saveAccountCredential, saveCredential, saveCredentialWithReceipt, upsertCredentialByIdentity } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalEnv = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const originalFetch = globalThis.fetch;
let home: string;
let cliFile: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-instance-registration-"));
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CODEX_HOME = join(home, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(process.env.CODEX_HOME);
  mkdirSync(process.env.OPENCODEX_HOME);
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  cliFile = join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  // A valid synthetic file prevents the detector from falling through to the real Keychain.
  writeFileSync(cliFile, JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-cli-access", refreshToken: "synthetic-cli-refresh", expiresAt: Date.now() + 3_600_000,
  } }));
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  saveConfig(baseConfig());
});
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});
function baseConfig(): OcxConfig {
  return { port: 10100, defaultProvider: "anthropic", providers: {
    anthropic: { ...structuredClone(OAUTH_PROVIDERS.anthropic!.providerConfig), defaultModel: "claude-sonnet-4-6", note: "A operator intent" },
  } };
}
function credential(name: string, overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
  return { access: `synthetic-${name}-access`, refresh: `synthetic-${name}-refresh`, expires: Date.now() + 3_600_000,
    accountId: `synthetic-${name}-id`, source: "oauth", ...overrides };
}
const directions: readonly [AnthropicInstanceId, AnthropicInstanceId][] = [["anthropic", "anthropic2"], ["anthropic2", "anthropic"]];

test("first B browser login creates missing defaults without selecting B as the default", async () => {
  await saveCredential("anthropic", credential("preserved-a"));
  const aBefore = structuredClone(getAccountSet("anthropic"));
  unlinkSync(getConfigPath());
  const defaults = getDefaultConfig();
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockImplementation(async () => {
    expect(existsSync(getConfigPath())).toBe(true);
    expect(loadConfig().providers.anthropic2).toBeUndefined();
    return credential("first-b");
  });
  try {
    await runLogin("anthropic2", {});
    expect(loadConfig().defaultProvider).toBe(defaults.defaultProvider);
    expect(loadConfig().providers.anthropic2!.anthropicOAuthInstance).toBe("anthropic2");
    expect(getAccountSet("anthropic")).toEqual(aBefore);
    expect(getAccountSet("anthropic2")!.accounts).toHaveLength(1);
  } finally { login.mockRestore(); }
});

test("a concurrent initial config winner is rechecked before the B browser opens", async () => {
  unlinkSync(getConfigPath());
  const initialize = configModule.initializePersistedConfigIfMissing;
  const winner = baseConfig();
  winner.providers.anthropic2 = { adapter: "openai-chat", authMode: "key",
    baseUrl: "https://custom.example.test/v1", apiKey: "synthetic-custom-key" };
  const hook = spyOn(configModule, "initializePersistedConfigIfMissing").mockImplementation(candidate => {
    saveConfig(winner);
    return initialize(candidate);
  });
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login");
  try {
    await expect(runLogin("anthropic2", {})).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
    expect(login).not.toHaveBeenCalled();
    expect(loadConfig().providers.anthropic2!.apiKey).toBe("synthetic-custom-key");
    expect(getAccountSet("anthropic2")).toBeNull();
  } finally { hook.mockRestore(); login.mockRestore(); }
});

test("deleting first-login defaults while the browser runs does not recreate the config", async () => {
  unlinkSync(getConfigPath());
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockImplementation(async () => {
    expect(existsSync(getConfigPath())).toBe(true);
    unlinkSync(getConfigPath());
    return credential("orphan-b");
  });
  try {
    const error = await runLogin("anthropic2", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthProviderPublicationError);
    expect((error as Error).message).toContain("credential was saved as an orphan auth row");
    expect(existsSync(getConfigPath())).toBe(false);
    // The caller receives publication failure; the orphan is retained for explicit cleanup.
    expect(getAccountSet("anthropic2")!.accounts).toHaveLength(1);
  } finally { login.mockRestore(); }
});

test("an existing config deleted during preflight load is not republished from the stale snapshot", async () => {
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login");
  const initialize = spyOn(configModule, "initializePersistedConfigIfMissing");
  try {
    const error = await runLogin("anthropic2", {}, undefined, { loadConfig: () => {
      const old = loadConfig();
      unlinkSync(getConfigPath());
      return old;
    } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthProviderPublicationError);
    // Refused before the browser flow: the message must not claim an orphan credential exists.
    expect((error as Error).message).toContain("no credential was saved");
    expect((error as Error).message).not.toContain("orphan");
    expect(existsSync(getConfigPath())).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(getAccountSet("anthropic2")).toBeNull();
  } finally { initialize.mockRestore(); login.mockRestore(); }
});

const writers = ["save", "account", "upsert"] as const;
async function register(writer: typeof writers[number], instance: AnthropicInstanceId, value: OAuthCredentials) {
  if (writer === "save") return saveCredentialWithReceipt(instance, value);
  if (writer === "upsert") return upsertCredentialByIdentity(instance, value);
  return saveAccountCredential(instance, getAccountSet(instance)!.activeAccountId, value);
}

for (const [first, second] of directions) {
  for (const writer of writers) {
    for (const duplicate of ["access", "refresh", "uuid"] as const) {
      test(`${writer}: ${second} rejects duplicate ${duplicate} in paused/orphan ${first} atomically`, async () => {
        const existing = credential("existing");
        existing.anthropicIdentity = bindAnthropicIdentity(existing.access, "synthetic-verified-uuid");
        await saveCredential(first, existing);
        if (writer === "account") await saveCredential(second, credential("target"));
        await mutateStore(store => { store[first]!.accounts[0]!.paused = true; });
        const incoming = credential("incoming");
        if (duplicate === "uuid") incoming.anthropicIdentity = bindAnthropicIdentity(incoming.access, "synthetic-verified-uuid");
        else incoming[duplicate] = existing[duplicate];
        const before = readFileSync(getAuthStorePath(), "utf8");
        let failure: unknown;
        try { await register(writer, second, incoming); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(AnthropicCrossInstanceDuplicateError);
        expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
        const message = String(failure);
        for (const secret of [existing.access, existing.refresh, incoming.access, incoming.refresh, "synthetic-verified-uuid"]) {
          expect(message).not.toContain(secret);
        }
      });
    }
  }

  test(`${first}/${second}: matching email, alias and unverified account IDs do not establish cross-pool ownership`, async () => {
    await saveCredential(first, credential("first", { accountId: "shared-display-id", email: "same@example.test" }));
    await mutateStore(store => { store[first]!.accounts[0]!.alias = "same@example.test"; });
    await saveCredential(second, credential("second", { accountId: "shared-display-id", email: "same@example.test" }));
    expect(getAccountSet(first)!.accounts).toHaveLength(1);
    expect(getAccountSet(second)!.accounts).toHaveLength(1);
    expect(getAccountSet(first)!.activeAccountId).toBe(getAccountSet(second)!.activeAccountId);
    await saveCredential(second, credential("email-only", { accountId: undefined, email: "same@example.test" }), { preserveIdentityless: true });
    expect(getAccountSet(second)!.accounts).toHaveLength(2);
  });

  test(`${first}/${second}: UUID matches require two proofs bound to their own access tokens`, async () => {
    const old = credential("old");
    old.anthropicIdentity = bindAnthropicIdentity(old.access, "synthetic-uuid");
    await saveCredential(first, old);
    const incoming = credential("new", { anthropicIdentity: old.anthropicIdentity });
    await saveCredential(second, incoming);
    expect(getAccountSet(second)!.accounts[0]!.credential.anthropicIdentity).toBeUndefined();
  });

  test(`${first}/${second}: concurrent duplicate registration admits exactly one writer`, async () => {
    const value = credential("concurrent");
    const outcomes = await Promise.allSettled([saveCredential(first, value), saveCredential(second, value)]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find(outcome => outcome.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : undefined).toBeInstanceOf(AnthropicCrossInstanceDuplicateError);
    expect(Object.values(loadAuthStore()).flatMap(set => set.accounts)).toHaveLength(1);
  });
}

test("empty tokens do not prove a duplicate", async () => {
  await saveCredential("anthropic", credential("empty-a", { access: "", refresh: "" }));
  await saveCredential("anthropic2", credential("empty-b", { access: "", refresh: "" }));
  expect(getAccountSet("anthropic2")!.accounts).toHaveLength(1);
});

test("B rejects every local import request before detector/flow entry and leaves the CLI fixture unchanged", async () => {
  const before = readFileSync(cliFile, "utf8");
  const detect = spyOn(localTokens, "detectClaudeCodeToken").mockImplementation(() => { throw new Error("detector must not run"); });
  const flow = spyOn(AnthropicOAuthFlow.prototype, "login").mockResolvedValue(credential("browser"));
  try {
    for (const importLocal of ["fallback", "only"] as const) {
      await expect(loginAnthropic({}, { instance: "anthropic2", importLocal })).rejects.toBeInstanceOf(AnthropicLocalCliImportError);
    }
    expect(flow).not.toHaveBeenCalled();
    for (const forceLogin of [false, true]) await OAUTH_PROVIDERS.anthropic2!.login({}, { forceLogin });
    expect(flow).toHaveBeenCalledTimes(2);
    expect(detect).not.toHaveBeenCalled();
    expect(readFileSync(cliFile, "utf8")).toBe(before);
  } finally { detect.mockRestore(); flow.mockRestore(); }
});

for (const writer of writers) {
  test(`${writer}: B rejects local-cli provenance without touching either store row`, async () => {
    await saveCredential("anthropic", credential("a"));
    await saveCredential("anthropic2", credential("b"));
    const before = readFileSync(getAuthStorePath(), "utf8");
    await expect(register(writer, "anthropic2", credential("cli", { source: "local-cli" }))).rejects.toBeInstanceOf(AnthropicLocalCliImportError);
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
  });
}

const customRows: OcxProviderConfig[] = [
  { adapter: "openai-chat", baseUrl: "https://custom.example.test/v1", authMode: "key", apiKey: "synthetic-key", models: ["custom-model"] },
  { adapter: "anthropic", baseUrl: "https://gateway.example.test", authMode: "oauth", models: ["gateway-model"] },
  { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", models: ["canonical-custom-model"] },
  { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "synthetic-canonical-key" },
];
for (const custom of customRows) {
  test(`custom ${custom.authMode} anthropic2 row refuses login/upsert and survives catalog reconciliation`, async () => {
    const config = loadConfig();
    config.providers.anthropic2 = structuredClone(custom);
    saveConfig(config);
    const rowBefore = structuredClone(loadConfig().providers.anthropic2);
    const bytes = readFileSync(getConfigPath(), "utf8");
    const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential("b"));
    try {
      await expect(runLogin("anthropic2", {})).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
      expect(login).not.toHaveBeenCalled();
      expect(() => upsertOAuthProvider(config, "anthropic2")).toThrow(AnthropicInstanceCollisionError);
      await expect(upsertCredentialByIdentity("anthropic2", credential("b"))).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
      expect(getAccountSet("anthropic2")).toBeNull();
      expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
      reconcileOAuthProviders(config);
      expect(loadConfig().providers.anthropic2).toEqual(rowBefore);
      expect(configuredAnthropicInstance(loadConfig(), "anthropic2")).toBeUndefined();
    } finally { login.mockRestore(); }
  });
}

test("B pre-persistence recheck catches a custom provider claimed during browser login", async () => {
  await saveCredential("anthropic", credential("a"));
  const before = readFileSync(getAuthStorePath(), "utf8");
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockImplementation(async () => {
    const config = loadConfig(); config.providers.anthropic2 = structuredClone(customRows[0]!); saveConfig(config);
    return credential("b");
  });
  try {
    await expect(runLogin("anthropic2", {})).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
    expect(loadConfig().providers.anthropic2!.apiKey).toBe("synthetic-key");
  } finally { login.mockRestore(); }
});

test("B store persist rechecks config after the mutation callback and refuses a new custom row", async () => {
  await saveCredential("anthropic", credential("a"));
  const before = readFileSync(getAuthStorePath(), "utf8");
  await expect(saveCredential("anthropic2", credential("b"), { assertBeforePersist: () => {
    const config = loadConfig(); config.providers.anthropic2 = structuredClone(customRows[0]!); saveConfig(config);
  } })).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
  expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
  expect(loadConfig().providers.anthropic2!.apiKey).toBe("synthetic-key");
});

test("a publication-time competing custom-row write wins; B credential stays orphaned and A/defaults survive", async () => {
  await saveCredential("anthropic", credential("a"));
  const aBefore = getAccountSet("anthropic");
  const configBefore = loadConfig();
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential("b"));
  setPersistedConfigMutationBeforeCommitForTests(() => {
    const competing = loadConfig(); competing.providers.anthropic2 = structuredClone(customRows[0]!);
    writeFileSync(getConfigPath(), JSON.stringify(competing, null, 2) + "\n");
  });
  try {
    await expect(runLogin("anthropic2", {})).rejects.toThrow("orphan auth row");
    const after = loadConfig();
    expect(after.providers.anthropic2!.apiKey).toBe("synthetic-key");
    expect(after.providers.anthropic).toEqual(configBefore.providers.anthropic);
    expect(after.defaultProvider).toBe(configBefore.defaultProvider);
    expect(getAccountSet("anthropic")).toEqual(aBefore);
    expect(getAccountSet("anthropic2")!.accounts[0]!.credential.access).toBe("synthetic-b-access");
    expect(configuredAnthropicInstance(after, "anthropic2")).toBeUndefined();
  } finally { login.mockRestore(); }
});

test("successful B login publishes only B and preserves A's provider model and global default", async () => {
  await saveCredential("anthropic", credential("a"));
  const aBefore = getAccountSet("anthropic");
  const before = loadConfig();
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential("b"));
  try {
    await runLogin("anthropic2", {});
    const after = loadConfig();
    expect(after.providers.anthropic).toEqual(before.providers.anthropic);
    expect(after.defaultProvider).toBe(before.defaultProvider);
    expect(after.providers.anthropic2!.adapter).toBe("anthropic");
    expect(after.providers.anthropic2!.authMode).toBe("oauth");
    expect(after.providers.anthropic2!.anthropicOAuthInstance).toBe("anthropic2");
    expect(getAccountSet("anthropic")).toEqual(aBefore);
  } finally { login.mockRestore(); }
});

test("unmarked OAuth row without baseUrl refuses B before browser login", async () => {
  const loaded = loadConfig();
  loaded.providers.anthropic2 = { adapter: "anthropic", authMode: "oauth" } as OcxProviderConfig;
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential("b"));
  try {
    await expect(runLogin("anthropic2", {}, undefined, { loadConfig: () => loaded })).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
    expect(login).not.toHaveBeenCalled();
    expect(loaded.providers.anthropic2.anthropicOAuthInstance).toBeUndefined();
    expect(getAccountSet("anthropic2")).toBeNull();
  } finally { login.mockRestore(); }
});

test("raw no-baseUrl B row blocks onboarding even when typed config loading falls back", async () => {
  const raw = { ...baseConfig(), providers: { ...baseConfig().providers, anthropic2: { adapter: "anthropic", authMode: "oauth" } } };
  const configBytes = JSON.stringify(raw);
  writeFileSync(getConfigPath(), configBytes);
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential("b"));
  try {
    await expect(runLogin("anthropic2", {})).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
    expect(login).not.toHaveBeenCalled();
    expect(readFileSync(getConfigPath(), "utf8")).toBe(configBytes);
    expect(getAccountSet("anthropic2")).toBeNull();
    await expect(saveCredential("anthropic2", credential("b"))).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(configBytes);
  } finally { login.mockRestore(); }
});

test("owned B update keeps explicit provenance and operator settings without changing A", async () => {
  const config = loadConfig();
  upsertOAuthProvider(config, "anthropic2");
  config.providers.anthropic2!.note = "owned operator note";
  config.providers.anthropic2!.anthropicAccountPool = { enabled: true, nativeMessages: false, stickyLimit: 5 };
  saveConfig(config);
  const a = structuredClone(config.providers.anthropic);
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockResolvedValue(credential("b"));
  try {
    await runLogin("anthropic2", {});
    const after = loadConfig();
    expect(after.providers.anthropic2!.anthropicOAuthInstance).toBe("anthropic2");
    expect(after.providers.anthropic2!.note).toBe("owned operator note");
    expect(after.providers.anthropic2!.anthropicAccountPool).toEqual(config.providers.anthropic2!.anthropicAccountPool);
    expect(after.providers.anthropic).toEqual(a);
    delete after.providers.anthropic2!.anthropicOAuthInstance;
    saveConfig(after);
    const bytes = readFileSync(getAuthStorePath(), "utf8");
    await expect(runLogin("anthropic2", {})).rejects.toBeInstanceOf(AnthropicInstanceCollisionError);
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(bytes);
    expect(login).toHaveBeenCalledTimes(1);
  } finally { login.mockRestore(); }
});

test("model discovery cannot use an orphan B bearer for a colliding custom OAuth row", async () => {
  await saveCredential("anthropic2", credential("orphan-b"));
  const config = loadConfig(); config.providers.anthropic2 = structuredClone(customRows[1]!); saveConfig(config);
  const before = readFileSync(getAuthStorePath(), "utf8");
  expect(await resolveModelsAuthToken("anthropic2", loadConfig().providers.anthropic2!)).toBeUndefined();
  expect(readFileSync(getAuthStorePath(), "utf8")).toBe(before);
});

test("B browser failure preserves A and config byte for byte", async () => {
  await saveCredential("anthropic", credential("a"));
  const authBefore = readFileSync(getAuthStorePath(), "utf8");
  const configBefore = readFileSync(getConfigPath(), "utf8");
  const login = spyOn(OAUTH_PROVIDERS.anthropic2!, "login").mockRejectedValue(new Error("synthetic browser failure"));
  try {
    await expect(runLogin("anthropic2", {})).rejects.toThrow("synthetic browser failure");
    expect(readFileSync(getAuthStorePath(), "utf8")).toBe(authBefore);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(configBefore);
  } finally { login.mockRestore(); }
});

test("A's factory still imports the valid local CLI fixture without rewriting it", async () => {
  const before = readFileSync(cliFile, "utf8");
  const imported = await OAUTH_PROVIDERS.anthropic!.login({});
  expect(imported).toMatchObject({ access: "synthetic-cli-access", refresh: "synthetic-cli-refresh", source: "local-cli" });
  expect(readFileSync(cliFile, "utf8")).toBe(before);
});

test("A force-login still bypasses CLI import and starts the browser flow", async () => {
  const detect = spyOn(localTokens, "detectClaudeCodeToken").mockImplementation(() => { throw new Error("force-login must not detect"); });
  const flow = spyOn(AnthropicOAuthFlow.prototype, "login").mockResolvedValue(credential("a-browser"));
  try {
    expect((await OAUTH_PROVIDERS.anthropic!.login({}, { forceLogin: true })).access).toBe("synthetic-a-browser-access");
    expect(flow).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();
  } finally { detect.mockRestore(); flow.mockRestore(); }
});
