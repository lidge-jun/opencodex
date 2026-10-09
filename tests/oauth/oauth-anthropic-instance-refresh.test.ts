import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import { getValidAccessTokenForAccount, OAUTH_PROVIDERS, OAuthAccountPausedError, OAuthLoginRequiredError, OAuthTokenRefreshStaleError, refreshAnthropicAccountWithLock } from "../../src/oauth";
import { AnthropicTokenError } from "../../src/oauth/anthropic";
import { captureAnthropicCredentialOwner, captureAnthropicCredentialOwnerForInstance, newerClaudeCredentialForInstance } from "../../src/oauth/anthropic-continuity";
import { bindAnthropicIdentity } from "../../src/oauth/anthropic-identity";
import * as localTokens from "../../src/oauth/local-token-detect";
import { AnthropicLocalCliImportError } from "../../src/oauth/store-anthropic-instance";
import { __resetGuardianState, guardianSweep } from "../../src/oauth/token-guardian";
import {
  credentialGeneration, getAccountCredential, getAccountSet, getAuthRefreshIntentLockPath, getAuthRefreshIntentPath,
  mergeAccountCredential, readOAuthRefreshIntent, removeAccount, saveAccountCredential, saveCredential, setAccountPaused, setAnthropicAccountThreshold,
  setAnthropicAccountThresholdForInstance, writeOAuthRefreshIntent,
} from "../../src/oauth/store";
import { subscribeOAuthAccountRoutingPolicyChanges } from "../../src/lib/account-selection-events";
import type { OAuthCredentials } from "../../src/oauth/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalEnv = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const originalFetch = globalThis.fetch;
let home: string;
let cliFile: string;
let validUntil: number;
beforeEach(() => {
  validUntil = Date.now() + 3_600_000;
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-instance-refresh-"));
  process.env.HOME = home;
  process.env.OPENCODEX_HOME = join(home, "ocx");
  process.env.CODEX_HOME = join(home, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  mkdirSync(process.env.CODEX_HOME);
  mkdirSync(process.env.OPENCODEX_HOME);
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  cliFile = join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  writeCli("synthetic-cli-access", "synthetic-cli-refresh");
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  saveConfig({ port: 10100, defaultProvider: "anthropic", providers: {
    anthropic: structuredClone(OAUTH_PROVIDERS.anthropic!.providerConfig),
  } });
  __resetGuardianState();
});
afterEach(() => {
  __resetGuardianState();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  removeTreeWithRetry(home);
});
function credential(instance: AnthropicInstanceId, fresh = false): OAuthCredentials {
  const access = `synthetic-${instance}-${fresh ? "fresh" : "old"}-access`;
  return { access, refresh: `synthetic-${instance}-${fresh ? "fresh" : "old"}-refresh`,
    expires: fresh ? validUntil : 1, accountId: "shared-stored-account-id", source: "oauth",
    anthropicIdentity: bindAnthropicIdentity(access, `synthetic-${instance}-uuid`) };
}
async function seedBoth() {
  await saveCredential("anthropic", credential("anthropic"));
  await saveCredential("anthropic2", credential("anthropic2"));
  const a = getAccountSet("anthropic")!.activeAccountId;
  const b = getAccountSet("anthropic2")!.activeAccountId;
  expect(a).toBe(b);
  return a;
}
function writeCli(access: string, refresh: string) {
  writeFileSync(cliFile, JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3_600_000 } }));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("equal A1/B1 account IDs refresh concurrently with separate intents/locks and one flight per instance", async () => {
  const id = await seedBoth();
  expect(getAuthRefreshIntentLockPath("anthropic", id)).not.toBe(getAuthRefreshIntentLockPath("anthropic2", id));
  expect(getAuthRefreshIntentPath("anthropic", id)).not.toBe(getAuthRefreshIntentPath("anthropic2", id));
  const release = deferred();
  const entered = deferred();
  const sent: string[] = [];
  const refreshFor = (instance: AnthropicInstanceId) => async (refresh: string) => {
    sent.push(refresh);
    expect(readOAuthRefreshIntent(instance, id)).toMatchObject({ provider: instance, accountId: id,
      generation: credentialGeneration(credential(instance)) });
    if (sent.length === 2) entered.resolve();
    await release.promise;
    return credential(instance, true);
  };
  const aRefresh = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockImplementation(refreshFor("anthropic"));
  const bRefresh = spyOn(OAUTH_PROVIDERS.anthropic2!, "refresh").mockImplementation(refreshFor("anthropic2"));
  const first = getValidAccessTokenForAccount("anthropic", id);
  const second = getValidAccessTokenForAccount("anthropic2", id);
  try {
    await Promise.race([entered.promise,
      first.then(() => { throw new Error("A refreshed before the release barrier"); }),
      second.then(() => { throw new Error("B refreshed before the release barrier"); }),
    ]);
    const joinedA = getValidAccessTokenForAccount("anthropic", id);
    const joinedB = getValidAccessTokenForAccount("anthropic2", id);
    expect(sent.sort()).toEqual(["synthetic-anthropic-old-refresh", "synthetic-anthropic2-old-refresh"].sort());
    release.resolve();
    expect(await Promise.all([first, second, joinedA, joinedB])).toEqual([
      "synthetic-anthropic-fresh-access", "synthetic-anthropic2-fresh-access",
      "synthetic-anthropic-fresh-access", "synthetic-anthropic2-fresh-access",
    ]);
    expect(aRefresh).toHaveBeenCalledTimes(1);
    expect(bRefresh).toHaveBeenCalledTimes(1);
    for (const instance of ["anthropic", "anthropic2"] as const) {
      expect(getAccountCredential(instance, id)).toEqual(credential(instance, true));
      expect(readOAuthRefreshIntent(instance, id)).toBeUndefined();
    }
  } finally { release.resolve(); await Promise.allSettled([first, second]); aRefresh.mockRestore(); bRefresh.mockRestore(); }
});

test("continuity owners read their own instance despite equal local account IDs", async () => {
  const id = await seedBoth();
  const a = getAccountSet("anthropic")!;
  const b = getAccountSet("anthropic2")!;
  const ownsA = captureAnthropicCredentialOwner(a, id);
  const ownsB = captureAnthropicCredentialOwnerForInstance("anthropic2", b, id);
  expect(ownsA({ anthropic: a, anthropic2: b })).toBe(true);
  expect(ownsB({ anthropic: a, anthropic2: b })).toBe(true);
  expect(ownsA({ anthropic2: b })).toBe(false);
  expect(ownsB({ anthropic: a })).toBe(false);
  const changed = structuredClone(b); changed.accounts[0]!.credential.email = "changed@example.test";
  expect(ownsA({ anthropic: a, anthropic2: changed })).toBe(true);
  expect(ownsB({ anthropic: a, anthropic2: changed })).toBe(false);
});

test("B CLI continuity returns absent before detector entry, even for legacy local-cli provenance", async () => {
  const detect = spyOn(localTokens, "detectClaudeCodeToken").mockImplementation(() => { throw new Error("detector must not run"); });
  try {
    expect(await newerClaudeCredentialForInstance("anthropic2", { ...credential("anthropic2"), source: "local-cli" }, Date.now())).toEqual({ kind: "absent" });
    const id = await seedBoth();
    expect(captureAnthropicCredentialOwnerForInstance("anthropic2", getAccountSet("anthropic2")!, id)(
      { anthropic2: getAccountSet("anthropic2")! }, "synthetic-disk-generation")).toBe(false);
    expect(detect).not.toHaveBeenCalled();
  } finally { detect.mockRestore(); }
});

for (const instance of ["anthropic", "anthropic2"] as const) {
  for (const change of ["paused", "removed", "replaced", "reauthenticated", "reauthenticated-before-terminal-error"] as const) {
    test(`${instance}: ${change} while awaiting the token response preserves ownership and the equal-ID sibling`, async () => {
      const id = await seedBoth();
      const other = instance === "anthropic" ? "anthropic2" : "anthropic";
      const otherBefore = structuredClone(getAccountSet(other));
      const otherIntent = writeOAuthRefreshIntent(other, id, credentialGeneration(getAccountCredential(other, id)!));
      const stored = getAccountCredential(instance, id)!;
      const loginId = getAccountSet(instance)!.accounts[0]!.loginId;
      const fresh = credential(instance, true);
      const reauthenticated = { ...fresh, access: `synthetic-${instance}-reauth-access`, refresh: `synthetic-${instance}-reauth-refresh`,
        anthropicIdentity: bindAnthropicIdentity(`synthetic-${instance}-reauth-access`, `synthetic-${instance}-uuid`) };
      const entered = deferred();
      const release = deferred();
      const sent: string[] = [];
      const refresh = spyOn(OAUTH_PROVIDERS[instance]!, "refresh").mockImplementation(async token => {
        sent.push(token);
        entered.resolve();
        await release.promise;
        if (change === "reauthenticated-before-terminal-error") throw new AnthropicTokenError("synthetic late rejection", 400, "invalid_grant");
        return fresh;
      });
      const pending = getValidAccessTokenForAccount(instance, id);
      try {
        await Promise.race([entered.promise,
          pending.then(() => { throw new Error("Refresh settled before the token response barrier"); }),
        ]);
        expect(sent).toEqual([stored.refresh]);
        expect(readOAuthRefreshIntent(instance, id)).toMatchObject({ provider: instance, accountId: id,
          generation: credentialGeneration(stored) });
        if (change === "paused") {
          expect((await setAccountPaused(instance, id, true)).status).toBe("updated");
        } else if (change === "removed") {
          expect(await removeAccount(instance, id)).toBe(true);
        } else if (change === "replaced") {
          // Identical tokens isolate the login-owner fence from the token-generation CAS.
          await saveAccountCredential(instance, id, stored, { rotateLoginId: true });
          expect(getAccountSet(instance)!.accounts[0]!.loginId).not.toBe(loginId);
          expect(credentialGeneration(getAccountCredential(instance, id)!)).toBe(credentialGeneration(stored));
        } else {
          await saveAccountCredential(instance, id, reauthenticated, { rotateLoginId: true });
          expect(credentialGeneration(getAccountCredential(instance, id)!)).not.toBe(credentialGeneration(stored));
        }
        const changedBefore = structuredClone(getAccountSet(instance));
        release.resolve();
        if (change === "paused") {
          await expect(pending).rejects.toBeInstanceOf(OAuthAccountPausedError);
          expect(getAccountCredential(instance, id)).toEqual(fresh);
          expect(getAccountSet(instance)!.accounts[0]!).toMatchObject({ paused: true });
          expect(getAccountSet(instance)!.accounts[0]!.needsReauth).toBeUndefined();
          expect(readOAuthRefreshIntent(instance, id)).toBeUndefined();
        } else if (change === "removed") {
          await expect(pending).rejects.toThrow();
          expect(getAccountCredential(instance, id)).toBeNull();
          expect(getAccountSet(instance)).toEqual(changedBefore);
        } else if (change === "replaced") {
          await expect(pending).rejects.toBeInstanceOf(OAuthTokenRefreshStaleError);
          expect(getAccountSet(instance)).toEqual(changedBefore);
        } else {
          if (change === "reauthenticated-before-terminal-error") {
            await expect(pending).rejects.toBeInstanceOf(OAuthLoginRequiredError);
          } else {
            await expect(pending).resolves.toBe(reauthenticated.access);
          }
          expect(getAccountSet(instance)).toEqual(changedBefore);
          expect(getAccountCredential(instance, id)).toEqual(reauthenticated);
          expect(getAccountSet(instance)!.accounts[0]!.needsReauth).toBeUndefined();
          expect(readOAuthRefreshIntent(instance, id)).toBeUndefined();
        }
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(getAccountSet(other)).toEqual(otherBefore);
        expect(readOAuthRefreshIntent(other, id)).toEqual(otherIntent);
      } finally { release.resolve(); await Promise.allSettled([pending]); refresh.mockRestore(); }
    });
  }

  test(`${instance}: the shared refresh definition exchanges only its supplied token at Anthropic`, async () => {
    const sends: Array<{ url: string; token: unknown }> = [];
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { refresh_token?: unknown };
      sends.push({ url: String(url), token: body.refresh_token });
      return Response.json({ access_token: `synthetic-${instance}-exchanged-access`,
        refresh_token: `synthetic-${instance}-exchanged-refresh`, expires_in: 3600,
        account: { uuid: `synthetic-${instance}-uuid` } });
    }) as typeof fetch;
    const result = await OAUTH_PROVIDERS[instance]!.refresh(`synthetic-${instance}-supplied-refresh`);
    expect(sends).toEqual([{ url: "https://api.anthropic.com/v1/oauth/token", token: `synthetic-${instance}-supplied-refresh` }]);
    expect(result.access).toBe(`synthetic-${instance}-exchanged-access`);
    expect(result.refresh).toBe(`synthetic-${instance}-exchanged-refresh`);
    expect(result.accountId).toBe(`synthetic-${instance}-uuid`);
    expect(result.anthropicIdentity?.accountUuid).toBe(`synthetic-${instance}-uuid`);
  });

  test(`${instance}: definitive rejection clears only its intent and permits a later refresh`, async () => {
    const id = await seedBoth();
    const other = instance === "anthropic" ? "anthropic2" : "anthropic";
    const otherBefore = getAccountSet(other);
    const stored = getAccountCredential(instance, id)!;
    const otherIntent = writeOAuthRefreshIntent(other, id, credentialGeneration(getAccountCredential(other, id)!));
    const rejected = { ...OAUTH_PROVIDERS[instance]!, refresh: async () => { throw new AnthropicTokenError("synthetic rejection", 503, undefined); } };
    await expect(refreshAnthropicAccountWithLock(instance, id, rejected, stored)).rejects.toThrow("synthetic rejection");
    expect(readOAuthRefreshIntent(instance, id)).toBeUndefined();
    expect(readOAuthRefreshIntent(other, id)).toEqual(otherIntent);
    expect(getAccountSet(other)).toEqual(otherBefore);
    expect(getAccountCredential(instance, id)).toEqual(stored);
    expect(getAccountSet(instance)!.accounts[0]!.needsReauth).toBeUndefined();
    await expect(refreshAnthropicAccountWithLock(instance, id, {
      ...OAUTH_PROVIDERS[instance]!, refresh: async () => credential(instance, true),
    }, stored)).resolves.toBe(credential(instance, true).access);
    expect(getAccountSet(other)).toEqual(otherBefore);
  });

  test(`${instance}: unknown token outcome retains a scoped intent and refuses replay`, async () => {
    const id = await seedBoth();
    const stored = getAccountCredential(instance, id)!;
    let sends = 0;
    const definition = { ...OAUTH_PROVIDERS[instance]!, refresh: async () => { sends++; throw new Error("synthetic transport failure"); } };
    await expect(refreshAnthropicAccountWithLock(instance, id, definition, stored)).rejects.toThrow("synthetic transport failure");
    const intent = readOAuthRefreshIntent(instance, id);
    expect(intent?.provider).toBe(instance);
    await expect(refreshAnthropicAccountWithLock(instance, id, definition, stored)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(sends).toBe(1);
    expect(readOAuthRefreshIntent(instance, id)).toEqual(intent);
    expect(getAccountCredential(instance, id)).toEqual(stored);
  });
}

test("refresh merges can persist a rotation already present in the other instance; registration guard is not replayed", async () => {
  const id = await seedBoth();
  const aBefore = getAccountSet("anthropic");
  await mergeAccountCredential("anthropic2", id, { ...credential("anthropic2", true), access: credential("anthropic").access });
  expect(getAccountCredential("anthropic2", id)!.access).toBe(credential("anthropic").access);
  expect(getAccountSet("anthropic")).toEqual(aBefore);
  await expect(mergeAccountCredential("anthropic2", id, { ...credential("anthropic2"), source: "local-cli" })).rejects.toBeInstanceOf(AnthropicLocalCliImportError);
});

test("A CLI adoption retains the old wrapper behavior and never touches B or the synthetic CLI file", async () => {
  const id = await seedBoth();
  const stored = { ...credential("anthropic"), source: "local-cli" as const };
  await saveCredential("anthropic", stored);
  const bBefore = getAccountSet("anthropic2");
  writeCli("synthetic-a-adopted-access", stored.refresh);
  const cliBefore = readFileSync(cliFile, "utf8");
  const refresh = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockImplementation(async () => { throw new Error("shared refresh must adopt"); });
  try {
    expect(await getValidAccessTokenForAccount("anthropic", id)).toBe("synthetic-a-adopted-access");
    expect(refresh).not.toHaveBeenCalled();
    expect(getAccountSet("anthropic2")).toEqual(bBefore);
    expect(getAccountCredential("anthropic", id)!.source).toBe("local-cli");
    expect(readFileSync(cliFile, "utf8")).toBe(cliBefore);
  } finally { refresh.mockRestore(); }
});

test("threshold events and row updates use the actual instance; old setter still means A", async () => {
  const id = await seedBoth();
  const providers: string[] = [];
  const unsubscribe = subscribeOAuthAccountRoutingPolicyChanges(event => { providers.push(event.provider); });
  try {
    await setAnthropicAccountThresholdForInstance("anthropic2", id, 35);
    expect(getAccountSet("anthropic2")!.accounts[0]!.autoSwitchThresholdOverride).toBe(35);
    expect(getAccountSet("anthropic")!.accounts[0]!.autoSwitchThresholdOverride).toBeUndefined();
    await setAnthropicAccountThreshold(id, 70);
    expect(getAccountSet("anthropic")!.accounts[0]!.autoSwitchThresholdOverride).toBe(70);
    expect(getAccountSet("anthropic2")!.accounts[0]!.autoSwitchThresholdOverride).toBe(35);
    expect(providers).toEqual(["anthropic2", "anthropic"]);
  } finally { unsubscribe(); }
});

test("guardian includes B only when its builtin row is configured and enabled", async () => {
  const id = await seedBoth();
  const config = loadConfig();
  config.tokenGuardian = { enabled: true };
  const a = spyOn(OAUTH_PROVIDERS.anthropic!, "refresh").mockResolvedValue(credential("anthropic", true));
  const b = spyOn(OAUTH_PROVIDERS.anthropic2!, "refresh").mockResolvedValue(credential("anthropic2", true));
  try {
    saveConfig(config);
    expect((await guardianSweep()).refreshed).toEqual([]);
    config.providers.anthropic2 = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://custom.example.test", refreshPolicy: "proactive" };
    saveConfig(config);
    expect((await guardianSweep()).refreshed).toEqual([]);
    config.providers.anthropic2 = { ...structuredClone(OAUTH_PROVIDERS.anthropic2!.providerConfig), disabled: true, refreshPolicy: "proactive" };
    saveConfig(config);
    expect((await guardianSweep()).refreshed).toEqual([]);
    config.providers.anthropic2.disabled = false;
    saveConfig(config);
    expect((await guardianSweep()).refreshed).toEqual([`oauth:anthropic2:${id}`]);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  } finally { a.mockRestore(); b.mockRestore(); }
});
