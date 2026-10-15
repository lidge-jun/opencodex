import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitGenericSessionAccount, bindGenericSessionAccount, clearGenericSessionAffinity,
  genericSessionAccount, genericSessionAffinityEnabled, preferredGenericSessionAccount } from "../../src/oauth/generic-session-affinity";
import { clearGenericFailoverHealth, rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import { getValidAccessSnapshotForAccount } from "../../src/oauth";
import { captureOAuthAccountSelection, getAccountSet, getAuthStorePath, markAccountNeedsReauth,
  saveAccountCredential, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { acquireAccountLease } from "../../src/oauth/kiro-account-load";
import { awaitKiroModelRefreshForTests, clearKiroAccountModels, refreshKiroAccountModelsDetached } from "../../src/providers/kiro-model-catalog";
import { oauthSessionKeyFromParts } from "../../src/oauth/session-affinity-key";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let priorHome: string | undefined;
let cfg: OcxConfig;
let ids: string[];
const now = () => Date.now();
beforeEach(async () => {
  priorHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-affinity-unit-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericSessionAffinity();
  clearGenericFailoverHealth();
  for (const slot of ["a", "b", "c"]) await saveCredential("xai", {
    access: `synthetic-${slot}`, refresh: `synthetic-refresh-${slot}`, expires: now() + 3_600_000,
    accountId: `synthetic-${slot}`,
  });
  ids = getAccountSet("xai")!.accounts.map(row => row.id);
  await setActiveAccount("xai", ids[0]!);
  cfg = { providers: { xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth",
    oauthAccountFailover: { enabled: true, sessionAffinity: "conversation" } } } } as OcxConfig;
});
afterEach(() => {
  clearGenericSessionAffinity();
  clearGenericFailoverHealth();
  clearAccountQuotaCache("xai");
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(home);
});

test("requires explicit conversation mode and narrow-over-broad proactive permission", () => {
  expect(genericSessionAffinityEnabled(cfg, "xai")).toBe(true);
  cfg.oauthAccountFailover = { enabled: true };
  cfg.providers.xai!.oauthAccountFailover!.enabled = false;
  expect(genericSessionAffinityEnabled(cfg, "xai")).toBe(false);
  delete cfg.providers.xai!.oauthAccountFailover!.enabled;
  expect(genericSessionAffinityEnabled(cfg, "xai")).toBe(true);
  delete cfg.oauthAccountFailover;
  expect(genericSessionAffinityEnabled(cfg, "xai")).toBe(false);
});

test("disabled mode discards bindings and Codex/Anthropic pools remain excluded", () => {
  bindGenericSessionAccount(cfg, "xai", "session", ids[1]!);
  cfg.providers.xai!.oauthAccountFailover!.sessionAffinity = "none";
  expect(genericSessionAccount(cfg, "xai", "session")).toBeNull();
  cfg.providers.xai!.oauthAccountFailover!.sessionAffinity = "conversation";
  expect(genericSessionAccount(cfg, "xai", "session")).toBeNull();
  for (const provider of ["openai", "anthropic", "anthropic2"]) {
    cfg.providers[provider] = { ...cfg.providers.xai! };
    expect(genericSessionAffinityEnabled(cfg, provider)).toBe(false);
  }
});

test("ineligible reauth and family cooldown release bindings without an event", async () => {
  bindGenericSessionAccount(cfg, "xai", "session", ids[1]!);
  await markAccountNeedsReauth("xai", ids[1]!, true);
  expect(genericSessionAccount(cfg, "xai", "session")).toBeNull();
  bindGenericSessionAccount(cfg, "xai", "session", ids[0]!);
  rotateGenericOAuthAccountOn429(cfg, "xai", ids[0]!, "60");
  expect(genericSessionAccount(cfg, "xai", "session")).toBeNull();
});

test("cross-process manual selection revokes affinity without a local publication", () => {
  bindGenericSessionAccount(cfg, "xai", "session", ids[1]!);
  const path = getAuthStorePath();
  const store = JSON.parse(readFileSync(path, "utf8"));
  store.xai.activeAccountId = ids[2];
  store.xai.selectionRevision = "synthetic-external-revision";
  writeFileSync(path, JSON.stringify(store));
  expect(genericSessionAccount(cfg, "xai", "session")).toBeNull();
  expect(preferredGenericSessionAccount(cfg, "xai", "session")).toBe(ids[2]);
});

test("admission preserves the manual receipt and rejects stale credentials and A→B→A", async () => {
  const expected = captureOAuthAccountSelection("xai")!;
  const snapshot = await getValidAccessSnapshotForAccount("xai", ids[1]!);
  expect(admitGenericSessionAccount(cfg, "xai", expected, snapshot)).toEqual(expected);
  expect(getAccountSet("xai")!.activeAccountId).toBe(ids[0]);
  const row = getAccountSet("xai")!.accounts.find(row => row.id === ids[1])!;
  await saveAccountCredential("xai", ids[1]!, { ...row.credential, access: "synthetic-renewed" });
  expect(admitGenericSessionAccount(cfg, "xai", expected, snapshot)).toBeNull();
  const fresh = await getValidAccessSnapshotForAccount("xai", ids[1]!);
  expect(admitGenericSessionAccount(cfg, "xai", expected, fresh)).toEqual(expected);
  await setActiveAccount("xai", ids[2]!);
  await setActiveAccount("xai", ids[0]!);
  expect(admitGenericSessionAccount(cfg, "xai", expected, fresh)).toBeNull();
});

test("TTL, total entry limit and config-home/provider scope are bounded", () => {
  const clock = now();
  bindGenericSessionAccount(cfg, "xai", "old", ids[1]!, undefined, clock);
  expect(genericSessionAccount(cfg, "xai", "old", undefined, clock + 24 * 60 * 60_000)).toBeNull();
  for (let i = 0; i < 2001; i++) bindGenericSessionAccount(cfg, "xai", `session-${i}`, ids[1]!, undefined, clock);
  expect(genericSessionAccount(cfg, "xai", "session-0", undefined, clock)).toBeNull();
  expect(genericSessionAccount(cfg, "xai", "session-2000", undefined, clock)).toBe(ids[1]);
  cfg.providers.kimi = { ...cfg.providers.xai! };
  expect(genericSessionAccount(cfg, "kimi", "session-2000", undefined, clock)).toBeNull();
  process.env.OPENCODEX_HOME = join(home, "other");
  expect(genericSessionAccount(cfg, "xai", "session-2000", undefined, clock)).toBeNull();
});

test("fill-first advances through three accounts without persisting an automatic active account", () => {
  cfg.pool = { kernel: true };
  cfg.providers.xai!.oauthAccountFailover!.strategy = "fill-first";
  cfg.providers.xai!.oauthAccountFailover!.autoSwitchThreshold = 80;
  setCachedProviderAccountQuotaForTests("xai", ids[0]!, { weeklyPercent: 90, updatedAt: now() });
  const second = preferredGenericSessionAccount(cfg, "xai", "session-b")!;
  bindGenericSessionAccount(cfg, "xai", "session-b", second);
  setCachedProviderAccountQuotaForTests("xai", second, { weeklyPercent: 90, updatedAt: now() });
  const third = preferredGenericSessionAccount(cfg, "xai", "session-c");
  expect(third).not.toBe(second);
  expect(third).not.toBe(ids[0]);
  expect(getAccountSet("xai")!.activeAccountId).toBe(ids[0]);
});

test("shared cohort keys do not establish conversation identity", () => {
  expect(oauthSessionKeyFromParts({ promptCacheKey: "shared", promptCacheKeyIsSharedCohort: true })).toBeNull();
  expect(oauthSessionKeyFromParts({ sessionIdHeader: "distinct", promptCacheKey: "shared", promptCacheKeyIsSharedCohort: true })).toBe("distinct");
  expect(oauthSessionKeyFromParts({ clientThreadId: "a".repeat(200) })).toHaveLength(64);
});


test("all-cooled accounts retain the ordinary active attempt without a false selection conflict", async () => {
  for (const id of ids) rotateGenericOAuthAccountOn429(cfg, "xai", id, "60");
  expect(preferredGenericSessionAccount(cfg, "xai", "session")).toBe(ids[0]);
  const selection = captureOAuthAccountSelection("xai")!;
  const snapshot = await getValidAccessSnapshotForAccount("xai", ids[0]!);
  expect(admitGenericSessionAccount(cfg, "xai", selection, snapshot)).toEqual(selection);
  bindGenericSessionAccount(cfg, "xai", "session", ids[0]!);
  expect(genericSessionAccount(cfg, "xai", "session")).toBeNull();
});


test("a held Kiro capacity lease cannot invalidate its own affinity or dispatch admission", async () => {
  const priorDiscovery = process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
  process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = "1";
  cfg.providers.kiro = { adapter: "kiro", authMode: "oauth", baseUrl: "https://runtime.us-east-1.kiro.dev",
    oauthAccountFailover: { enabled: true, sessionAffinity: "conversation", maxConcurrentPerAccount: 1 } };
  let releaseLease: (() => void) | undefined;
  try {
    for (const slot of ["a", "b"]) await saveCredential("kiro", {
      access: `synthetic-${slot}`, refresh: `synthetic-refresh-${slot}`, expires: now() + 3_600_000,
      accountId: `synthetic-${slot}`, kiro: { apiRegion: "us-east-1",
        profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/synthetic-${slot}` },
    });
    const rows = getAccountSet("kiro")!.accounts;
    const dependencies = {
      resolveAddresses: async () => ({ hostname: "runtime.us-east-1.kiro.dev",
        addresses: [{ address: "1.1.1.1", family: 4 }], privateNetwork: false }),
      pinnedPost: async () => Response.json({ models: [{ modelId: "model-one" }] }),
    } as never;
    for (const row of rows) refreshKiroAccountModelsDetached(row, cfg.providers.kiro, dependencies);
    await Promise.all(rows.map(row => awaitKiroModelRefreshForTests(row.id)));
    const bound = rows[0]!.id;
    bindGenericSessionAccount(cfg, "kiro", "session", bound, "model-one");
    const lease = await acquireAccountLease("kiro", bound, { maxConcurrentPerAccount: 1 });
    expect(lease).not.toBeNull();
    releaseLease = lease!.release;
    expect(genericSessionAccount(cfg, "kiro", "session", "model-one")).toBe(bound);
    const receipt = captureOAuthAccountSelection("kiro")!;
    const snapshot = await getValidAccessSnapshotForAccount("kiro", bound);
    expect(admitGenericSessionAccount(cfg, "kiro", receipt, snapshot, "model-one")).toEqual(receipt);
    expect(await acquireAccountLease("kiro", bound, { maxConcurrentPerAccount: 1, waitMs: 1 })).toBeNull();
  } finally {
    releaseLease?.();
    clearKiroAccountModels();
    if (priorDiscovery === undefined) delete process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
    else process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = priorDiscovery;
  }
});
