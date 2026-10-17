import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { AccountRefusalStreaks, autoPauseThreshold, classifyPermanentAccountRefusal, permanentAccountRefusal } from "../../src/oauth/account-auto-pause-policy";
import { getValidAccessSnapshotForAccount, OAuthAccountPausedError } from "../../src/oauth";
import { getAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";
import { routedProviderConfig } from "../../src/router";
import { listProviderApiKeys } from "../../src/providers/api-keys";
import { setProviderApiKeyPaused } from "../../src/providers/api-key-pause";
import { rotateKeyOn401 } from "../../src/providers/key-failover";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { setCodexAccountPaused } from "../../src/codex/account-pause";
import { configSchema } from "../../src/config/schema/config-schema";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const orgMessage = "OAuth authentication is currently not allowed for this organization";
const payload = (message = orgMessage, type = "permission_error") => ({ error: { type, message } });
const refusal = (status = 403) => Response.json(payload(), { status });
const oldHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-auto-pause-")); process.env.OPENCODEX_HOME = home; });
afterEach(() => {
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(home);
});
function configFor(name: string, mode: "oauth" | "key" | "forward" = "oauth"): OcxConfig {
  const config = getDefaultConfig();
  config.providers = { [name]: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: mode,
    accountAutoPause: { enabled: true } } };
  config.defaultProvider = name;
  return config;
}
async function oauthFixture(name = "command-code") {
  const config = configFor(name);
  for (let n = 0; n < 2; n++) await saveCredential(name, {
    access: `synthetic-access-${n}`, refresh: `synthetic-refresh-${n}`,
    expires: Date.now() + 3_600_000, accountId: `synthetic-${n}`, source: "oauth",
  });
  const ids = getAccountSet(name)!.accounts.map(a => a.id);
  await setActiveAccount(name, ids[0]!);
  saveConfig(config);
  const snapshot = await getValidAccessSnapshotForAccount(name, ids[0]!);
  const capture = () => captureAccountAutoPauseAttempt(name, config.providers[name]!, { config, oauth: snapshot },
    new Headers({ authorization: `Bearer ${snapshot.accessToken}` }))!;
  return { config, ids, snapshot, capture };
}

describe("permanent account refusal classification", () => {
  for (const [message, expected] of [
    [orgMessage, "oauth_organization_disabled"],
    ["Your subscription has expired.", "subscription_expired"],
    ["Your Claude subscription is inactive", "subscription_inactive"],
    ["Your account does not have an active subscription", "subscription_inactive"],
    ["Your plan was downgraded to free with no credits", "plan_downgraded"],
    ["Your account does not have access to Claude Code", "account_permission_denied"],
  ] as const) {
    test(expected + ": exact 401/403 only", () => {
      expect(classifyPermanentAccountRefusal(403, payload(message))).toBe(expected);
      expect(classifyPermanentAccountRefusal(401, payload(message))).toBe(expected);
      for (const status of [200, 400, 402, 429, 500, 503]) expect(classifyPermanentAccountRefusal(status, payload(message))).toBeUndefined();
    });
  }
  test("model, request, quota, malformed and quoted errors grant no account authority", () => {
    for (const message of ["You do not have access to this model", "Your quota resets tomorrow", "Your access token has expired", `Diagnostic: ${orgMessage}`, `Model says: Your subscription is inactive`]) {
      expect(classifyPermanentAccountRefusal(403, payload(message))).toBeUndefined();
    }
    expect(classifyPermanentAccountRefusal(403, { error: { ...payload().error, code: "model_not_found" } })).toBeUndefined();
    for (const value of [null, [], {}, { error: orgMessage }]) expect(classifyPermanentAccountRefusal(403, value)).toBeUndefined();
  });
  test("bounded reader preserves original and refuses malformed/oversized data", async () => {
    const response = refusal();
    expect(await permanentAccountRefusal(response)).toBe("oauth_organization_disabled");
    expect(await response.json()).toEqual(payload());
    expect(await permanentAccountRefusal(new Response("not json", { status: 403 }))).toBeUndefined();
    expect(await permanentAccountRefusal(new Response("x".repeat(20_000), { status: 403 }))).toBeUndefined();
  });
  test("default off, default threshold two, strict schema", () => {
    expect(autoPauseThreshold(undefined)).toBeUndefined();
    expect(autoPauseThreshold({ enabled: false })).toBeUndefined();
    expect(autoPauseThreshold({ enabled: true })).toBe(2);
    for (const n of [0, -1, 1.5, 101]) expect(autoPauseThreshold({ enabled: true, consecutiveFailures: n })).toBeUndefined();
    const config = configFor("fixture");
    expect(configSchema.safeParse(config).success).toBe(true);
    config.providers.fixture!.accountAutoPause!.consecutiveFailures = 0;
    expect(configSchema.safeParse(config).success).toBe(false);
  });
});

test("concurrent refusals pause once; response-arrival order serializes slow verdicts and success", async () => {
  const tracker = new AccountRefusalStreaks();
  let pauses = 0;
  const pause = async () => { pauses++; return true; };
  let resolve!: (value: "subscription_expired") => void;
  const first = tracker.observe("fixture", "login", 2, new Promise(r => { resolve = r; }), false, () => true, pause);
  const success = tracker.observe("fixture", "login", 2, Promise.resolve(undefined), true, () => true, pause);
  const third = tracker.observe("fixture", "login", 2, Promise.resolve("subscription_expired"), false, () => true, pause);
  resolve("subscription_expired");
  await Promise.all([first, success, third]);
  expect(pauses).toBe(0);
  await Promise.all(Array.from({ length: 8 }, () => tracker.observe("fixture", "login", 2, Promise.resolve("subscription_expired"), false, () => true, pause)));
  expect(pauses).toBe(1);
});

test("OAuth threshold, transient neutrality, stored reason, skip and manual resume", async () => {
  const f = await oauthFixture();
  await f.capture()(refusal());
  expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
  await f.capture()(refusal(429));
  const stale = f.capture();
  const response = await f.capture()(refusal());
  expect(wasAccountAutoPaused(response)).toBe(true);
  const set = getAccountSet("command-code")!;
  expect(set.accounts[0]!.pauseDetails?.reason).toBe("oauth_organization_disabled");
  expect(set.accounts[0]!.pauseDetails?.pausedAt).toBeGreaterThan(0);
  expect(set.activeAccountId).toBe(f.ids[1]!);
  await expect(getValidAccessSnapshotForAccount("command-code", f.ids[0]!)).rejects.toBeInstanceOf(OAuthAccountPausedError);
  await setAccountPaused("command-code", f.ids[0]!, false);
  expect(getAccountSet("command-code")!.accounts[0]!.pauseDetails).toBeUndefined();
  await stale(refusal()); // old pre-resume capture is fenced out
  expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
});

test("success resets, default-off and wrong credential headers do nothing", async () => {
  const f = await oauthFixture();
  await f.capture()(refusal());
  await f.capture()(new Response("ok"));
  await f.capture()(refusal());
  expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
  f.config.providers["command-code"]!.accountAutoPause = undefined;
  expect(f.capture()).toBeUndefined();
  f.config.providers["command-code"]!.accountAutoPause = { enabled: true };
  expect(captureAccountAutoPauseAttempt("command-code", f.config.providers["command-code"]!, { config: f.config, oauth: f.snapshot }, new Headers({ authorization: "Bearer synthetic-other" }))).toBeUndefined();
});

test("key pool pause persists disabled, rotates and resumes; later failover skips disabled entries", async () => {
  const config = configFor("fixture", "key");
  const provider = config.providers.fixture!;
  provider.apiKey = "synthetic-A";
  provider.apiKeyPool = ["A", "B", "C"].map(id => ({ id, key: `synthetic-${id}` }));
  saveConfig(config);
  const routed = routedProviderConfig("fixture", provider);
  const capture = () => captureAccountAutoPauseAttempt("fixture", routed, { config }, new Headers({ authorization: `Bearer ${routed.apiKey}` }))!;
  await capture()(refusal());
  await capture()(refusal());
  expect(config.providers.fixture!.apiKeyPool![0]!.disabled).toBe(true);
  expect(loadConfig().providers.fixture!.apiKeyPool![0]!.pauseDetails?.reason).toBe("oauth_organization_disabled");
  expect(config.providers.fixture!.apiKey).toBe("synthetic-B");
  expect(rotateKeyOn401(config, "fixture", Date.now(), "synthetic-B")?.apiKey).toBe("synthetic-C");
  expect(rotateKeyOn401(config, "fixture", Date.now(), "synthetic-C")).toBeNull();
  expect(setProviderApiKeyPaused(config, "fixture", "A", false)).toBe(true);
  expect(listProviderApiKeys(config, "fixture").keys[0]!.pauseDetails).toBeUndefined();
});

test("Codex pool uses persistent pause ids, generation fence and resume metadata", async () => {
  const config = configFor("openai", "forward");
  config.codexAccounts = [{ id: "fixture", email: "", isMain: false }];
  const generation = saveCodexAccountCredential("fixture", { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "synthetic" });
  saveConfig(config);
  const codex = { kind: "pool" as const, accountId: "fixture", generation, writerGeneration: 0, accessToken: "synthetic-access", chatgptAccountId: "synthetic" };
  const capture = () => captureAccountAutoPauseAttempt("openai", config.providers.openai!, { config, codex }, new Headers({ authorization: "Bearer synthetic-access", "chatgpt-account-id": "synthetic" }))!;
  await capture()(refusal());
  await capture()(refusal());
  expect(config.pausedCodexAccountIds).toContain("fixture");
  expect(loadConfig().pausedCodexAccountIds).toContain("fixture");
  expect(config.codexAccountPauseState?.fixture?.details?.reason).toBe("oauth_organization_disabled");
  setCodexAccountPaused(config, "fixture", false);
  expect(config.codexAccountPauseState?.fixture?.details).toBeUndefined();
});

test("single scalar key materializes a resumable paused pool row", async () => {
  const config = configFor("fixture", "key");
  config.providers.fixture!.apiKey = "synthetic-single";
  config.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
  saveConfig(config);
  const provider = routedProviderConfig("fixture", config.providers.fixture!);
  const observe = captureAccountAutoPauseAttempt("fixture", provider, { config }, new Headers({ authorization: `Bearer ${provider.apiKey}` }))!;
  await observe(refusal());
  const entry = config.providers.fixture!.apiKeyPool![0]!;
  expect(entry.disabled).toBe(true);
  expect(config.providers.fixture!.apiKey).toBeUndefined();
  expect(setProviderApiKeyPaused(config, "fixture", entry.id, false)).toBe(true);
  expect(config.providers.fixture!.apiKey).toBe("synthetic-single");
});

test("replacing an environment-backed secret fences the old response", async () => {
  const previous = process.env.OCX_AUTO_PAUSE_FIXTURE_KEY;
  try {
    process.env.OCX_AUTO_PAUSE_FIXTURE_KEY = "synthetic-old";
    const config = configFor("fixture", "key");
    config.providers.fixture!.apiKey = "$OCX_AUTO_PAUSE_FIXTURE_KEY";
    config.providers.fixture!.apiKeyPool = [{ id: "fixture", key: "$OCX_AUTO_PAUSE_FIXTURE_KEY" }];
    config.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
    saveConfig(config);
    const provider = routedProviderConfig("fixture", config.providers.fixture!);
    const observe = captureAccountAutoPauseAttempt("fixture", provider, { config }, new Headers({ authorization: `Bearer ${provider.apiKey}` }))!;
    process.env.OCX_AUTO_PAUSE_FIXTURE_KEY = "synthetic-new";
    await observe(refusal());
    expect(config.providers.fixture!.apiKeyPool![0]!.disabled).not.toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OCX_AUTO_PAUSE_FIXTURE_KEY; else process.env.OCX_AUTO_PAUSE_FIXTURE_KEY = previous;
  }
});

test("same-identity main credential replacement fences a delayed refusal", async () => {
  const { observeMainQuotaCredential, observeMainQuotaIdentity } = await import("../../src/codex/main-account-cache");
  const { captureConfigGeneration } = await import("../../src/lib/state-store-sweeper");
  const config = configFor("openai", "forward");
  config.providers.openai!.accountAutoPause!.consecutiveFailures = 1;
  observeMainQuotaIdentity("synthetic-main");
  const writer = observeMainQuotaCredential("synthetic-old", "synthetic-main")!;
  saveConfig(config);
  const observe = captureAccountAutoPauseAttempt("openai", config.providers.openai!, { config,
    codex: { kind: "main-pool", accountId: "__main__", writerGeneration: captureConfigGeneration(), mainQuotaWriter: writer, accessToken: "synthetic-old", chatgptAccountId: "synthetic-main" },
  }, new Headers({ authorization: "Bearer synthetic-old", "chatgpt-account-id": "synthetic-main" }))!;
  observeMainQuotaCredential("synthetic-new", "synthetic-main");
  await observe(refusal());
  expect(config.pausedCodexAccountIds).toBeUndefined();
});

test("an async OAuth pause cannot commit after policy opt-out", async () => {
  const f = await oauthFixture();
  let enabled = true;
  const row = getAccountSet("command-code")!.accounts[0]!;
  const pending = setAccountPaused("command-code", row.id, true, { generation: f.snapshot.generation, pauseRevision: row.pauseRevision,
    details: { reason: "subscription_expired", pausedAt: Date.now() }, isCurrent: () => enabled });
  enabled = false;
  await expect(pending).rejects.toThrow("policy changed");
  expect(getAccountSet("command-code")!.accounts[0]!.paused).not.toBe(true);
});

test("removing an active key skips paused survivors, which remain deletable", async () => {
  const { removeProviderApiKey } = await import("../../src/providers/api-keys");
  const config = configFor("fixture", "key");
  config.providers.fixture!.apiKey = "synthetic-B";
  config.providers.fixture!.apiKeyPool = [{ id: "A", key: "synthetic-A", disabled: true }, { id: "B", key: "synthetic-B" }, { id: "C", key: "synthetic-C" }];
  saveConfig(config);
  expect(removeProviderApiKey(config, "fixture", "B")).toBe(true);
  expect(config.providers.fixture!.apiKey).toBe("synthetic-C");
  expect(removeProviderApiKey(config, "fixture", "A")).toBe(true);
});

test("Google structured account refusals classify without accepting model permission errors", () => {
  expect(classifyPermanentAccountRefusal(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "Your subscription is inactive" } })).toBe("subscription_inactive");
  expect(classifyPermanentAccountRefusal(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "This model is not available in this project" } })).toBeUndefined();
});

test("Antigravity normalization retains permanent refusal and auto-pause ownership", async () => {
  const { fetchGoogleWithRetry } = await import("../../src/adapters/google-http");
  const { wasPermanentAccountRefusal } = await import("../../src/oauth/account-auto-pause");
  const config = configFor("fixture", "key");
  config.providers.fixture!.apiKey = "synthetic-A";
  config.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
  saveConfig(config);
  const provider = routedProviderConfig("fixture", config.providers.fixture!);
  const headers = { authorization: `Bearer ${provider.apiKey}` };
  const observe = captureAccountAutoPauseAttempt("fixture", provider, { config }, new Headers(headers))!;
  const response = await fetchGoogleWithRetry("Antigravity", { url: "https://example.test", method: "POST", headers, body: "{}" }, {
    executor: (async () => observe(refusal())) as typeof fetch,
  });
  expect(response.status).toBe(403);
  expect(wasAccountAutoPaused(response)).toBe(true);
  expect(wasPermanentAccountRefusal(response)).toBe(true);
});

test("a stale pre-resume response cannot erase the resumed account's refusal streak", async () => {
  const f = await oauthFixture();
  const stale = f.capture();
  await setAccountPaused("command-code", f.ids[0]!, true);
  await setAccountPaused("command-code", f.ids[0]!, false);
  await f.capture()(refusal());
  await stale(refusal());
  await f.capture()(refusal());
  expect(getAccountSet("command-code")!.accounts[0]!.paused).toBe(true);
});
