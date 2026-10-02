import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as oauth from "../../../src/oauth";
import { captureProviderGather } from "../../../src/codex/catalog/gather-capture";
import { fetchProviderModelsWithAuth } from "../../../src/codex/catalog/provider-models";
import { ProviderOutboundSendCancelledError, providerOutboundGet } from "../../../src/lib/provider-outbound";
import { clearAnthropicAccountPoolState } from "../../../src/oauth/anthropic-routing";
import { credentialGeneration, getAccountCredential, getAccountSet, saveAccountCredential, saveCredential, setAccountPaused } from "../../../src/oauth/store";
import { clearAccountQuotaCache, fetchProviderAccountQuotas } from "../../../src/providers/quota";
import * as accountCache from "../../../src/providers/quota/account-cache";
import { fetchAnthropicQuota } from "../../../src/providers/quota/vendor-probes-oauth";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let accountId: string;
let sends: number;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pause-outbound-"));
  process.env.OPENCODEX_HOME = home;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  await saveCredential("anthropic", {
    access: "synthetic-access", refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000, accountId: "outbound-pause",
  });
  accountId = getAccountSet("anthropic")!.activeAccountId;
  sends = 0;
  globalThis.fetch = (async () => { sends++; return new Response("{}", { status: 200 }); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAnthropicAccountPoolState();
  clearAccountQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test("per-account quota does not send when pause commits while token resolution waits", async () => {
  const started = Promise.withResolvers<void>();
  const token = Promise.withResolvers<string>();
  const read = spyOn(accountCache, "getTokenForAccountQuotaProbe").mockImplementation(async () => {
    started.resolve();
    return token.promise;
  });
  try {
    const pending = fetchProviderAccountQuotas("anthropic", true);
    await started.promise;
    await setAccountPaused("anthropic", accountId, true);
    token.resolve("synthetic-access");
    expect((await pending)[0]?.unavailable).toBe(true);
    expect(sends).toBe(0);
  } finally { read.mockRestore(); }
});

test("provider quota does not send when pause commits while token resolution waits", async () => {
  const started = Promise.withResolvers<void>();
  const token = Promise.withResolvers<string>();
  const read = spyOn(oauth, "getValidAccessToken").mockImplementation(async () => {
    started.resolve();
    return token.promise;
  });
  try {
    const pending = fetchAnthropicQuota("anthropic");
    await started.promise;
    await setAccountPaused("anthropic", accountId, true);
    token.resolve("synthetic-access");
    expect(await pending).toBeNull();
    expect(sends).toBe(0);
  } finally { read.mockRestore(); }
});

test("model discovery rejects a bearer captured before pause", async () => {
  const credential = getAccountCredential("anthropic", accountId)!;
  const resolver = { kind: "observed" as const, resolve: () => ({
    apiKey: credential.access, observed: true,
    oauthAccountId: accountId, oauthGeneration: credentialGeneration(credential),
  }) };
  const captured = captureProviderGather("anthropic", {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth",
    liveModels: true, models: ["configured-model"],
  }, resolver);
  await setAccountPaused("anthropic", accountId, true);
  const result = await fetchProviderModelsWithAuth(captured, 0, undefined, resolver);
  expect(result.outcome.state).toBe("degraded");
  expect(sends).toBe(0);
});

test("model discovery rejects a replaced credential generation even when its access token matches", async () => {
  const credential = getAccountCredential("anthropic", accountId)!;
  const resolver = { kind: "observed" as const, resolve: () => ({
    apiKey: credential.access, observed: true,
    oauthAccountId: accountId, oauthGeneration: credentialGeneration(credential),
  }) };
  const captured = captureProviderGather("anthropic", {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth",
    liveModels: true, models: ["configured-model"],
  }, resolver);
  await saveAccountCredential("anthropic", accountId, { ...credential, refresh: "rotated-refresh" });
  const result = await fetchProviderModelsWithAuth(captured, 0, undefined, resolver);
  expect(result.outcome.state).toBe("degraded");
  expect(sends).toBe(0);
});

test("model discovery transport cancels after DNS when pause commits before physical send", async () => {
  const started = Promise.withResolvers<void>();
  const releaseDns = Promise.withResolvers<void>();
  const pending = providerOutboundGet("anthropic", { baseUrl: "https://api.anthropic.com" },
    "https://api.anthropic.com/v1/models", { headers: { Authorization: "Bearer synthetic-access" } }, {
      resolveAddresses: async () => {
        started.resolve();
        await releaseDns.promise;
        return { hostname: "api.anthropic.com", addresses: [{ address: "93.184.216.34", family: 4 }], privateNetwork: false };
      },
      pinnedGet: async () => { sends++; return new Response("{}"); },
      beforeSend: () => getAccountSet("anthropic")?.accounts.find(row => row.id === accountId)?.paused !== true,
    });
  await started.promise;
  await setAccountPaused("anthropic", accountId, true);
  releaseDns.resolve();
  await expect(pending).rejects.toBeInstanceOf(ProviderOutboundSendCancelledError);
  expect(sends).toBe(0);
});
