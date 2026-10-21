import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, initializePersistedConfigIfMissing, loadConfig, saveConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { captureAccountAutoPauseFence, accountAutoPauseFenceIsLocal, observeAccountAutoPauseRevisions, accountAutoPauseObservedSizeForTests } from "../../src/config/account-auto-pause-revisions";
import { armClaudeCodeBaseline, reconcileLiveConfigFromDisk, saveConfigPreservingClaudeCode } from "../../src/config/live-reconcile";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { routedProviderConfig } from "../../src/router";
import { setPreservedDiskOnlyProviders } from "../../src/usage/user-cost-overlays";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-policy-config-")); process.env.OPENCODEX_HOME = home; });
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function fixture(tracked = true) {
  const config = getDefaultConfig();
  config.providers = { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "synthetic",
    ...(tracked ? { accountAutoPause: { enabled: true } } : {}) } };
  config.defaultProvider = "fixture";
  return config;
}
const bytes = () => readFileSync(join(home, "config.json"), "utf8");
const raw = () => JSON.parse(bytes());
const revision = () => raw().accountAutoPausePolicyRevisions?.fixture;

test("never-configured provider create, edit, initialize and unrelated writes omit the map", () => {
  const config = fixture(false);
  config.accountAutoPausePolicyRevisions = { injected: randomUUID() };
  expect(initializePersistedConfigIfMissing(config)).toBe("created");
  expect(bytes()).not.toContain("accountAutoPausePolicyRevisions");
  config.providers.fixture!.baseUrl = "https://other.test/v1";
  saveConfig(config);
  expect(bytes()).not.toContain("accountAutoPausePolicyRevisions");
  config.port++;
  saveConfig(config);
  expect(bytes()).not.toContain("accountAutoPausePolicyRevisions");
  const stable = bytes();
  saveConfig(config);
  expect(bytes()).toBe(stable);
  saveConfig(loadConfig());
  expect(bytes()).not.toContain("accountAutoPausePolicyRevisions");
});

test("invalid-map recovery does not enroll never-configured providers", () => {
  const config = fixture(false);
  saveConfig(config);
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...raw(), accountAutoPausePolicyRevisions: { fixture: 12 } }));
  const loaded = loadConfig();
  expect(loaded.providers.fixture).toBeDefined();
  expect(loaded.accountAutoPausePolicyRevisions).toBeNull();
  saveConfig(loaded);
  expect(bytes()).not.toContain("accountAutoPausePolicyRevisions");
});

test("caller epochs are ignored; removed policies retain revisions only while the provider exists", () => {
  const config = fixture();
  saveConfig(config);
  const first = revision();
  expect(first).toMatch(/^[a-f0-9-]{36}$/);
  config.accountAutoPausePolicyRevisions = { fixture: randomUUID(), injected: randomUUID() };
  config.port++;
  saveConfig(config);
  expect(revision()).toBe(first);
  expect(raw().accountAutoPausePolicyRevisions.injected).toBeUndefined();
  config.providers.fixture!.accountAutoPause = undefined;
  saveConfig(config);
  expect(revision()).not.toBe(first);
  const removedPolicy = revision();
  expect(removedPolicy).toMatch(/^[a-f0-9-]{36}$/);
  config.port++;
  saveConfig(config);
  expect(revision()).toBe(removedPolicy);
  delete config.providers.fixture;
  saveConfig(config);
  expect(revision()).toBeUndefined();
  expect(bytes()).not.toContain("accountAutoPausePolicyRevisions");
  expect(accountAutoPauseObservedSizeForTests()).toBe(0);
});

test("all full-fingerprint fields rotate policy epochs and wall-clock rollback cannot restore one", () => {
  const config = fixture();
  saveConfig(config);
  const row = config.providers.fixture!;
  const edits = [() => { row.accountAutoPause!.enabled = false; }, () => { row.accountAutoPause!.enabled = true; },
    () => { row.accountAutoPause!.consecutiveFailures = 3; }, () => { row.disabled = true; },
    () => { row.disabled = false; }, () => { row.baseUrl = "https://other.test/v1"; },
    () => { row.adapter = "anthropic"; }, () => { row.authMode = "oauth"; }];
  const seen = new Set([revision()]);
  const oldNow = Date.now;
  try {
    Date.now = () => 1;
    for (const edit of edits) { edit(); saveConfig(config); expect(seen.has(revision())).toBe(false); seen.add(revision()); }
  } finally { Date.now = oldNow; }
});

test("invalid epochs load as unknown and the recovery write mints only configured providers", () => {
  const config = fixture();
  config.providers.untracked = { adapter: "openai-chat", baseUrl: "https://untracked.test/v1", authMode: "key" };
  saveConfig(config);
  const first = revision();
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...raw(), accountAutoPausePolicyRevisions: [first] }));
  const loaded = loadConfig();
  expect(loaded.providers.fixture).toBeDefined();
  expect(captureAccountAutoPauseFence(loaded, "fixture")).toBeUndefined();
  saveConfig(loaded);
  expect(revision()).not.toBe(first);
  expect(Object.keys(raw().accountAutoPausePolicyRevisions)).toEqual(["fixture"]);
  expect(captureAccountAutoPauseFence(loaded, "fixture")).toBeDefined();
});

test("malformed Codex display details degrade per entry while revisions and paused ids survive", () => {
  const config = fixture();
  config.pausedCodexAccountIds = ["a", "b"];
  const parsed = configSchema.parse({ ...config, codexAccountPauseState: {
    a: { revision: "revision-a", details: { reason: "wrong", pausedAt: -1 } },
    b: { revision: "revision-b", details: { reason: "subscription_expired", pausedAt: 42 } },
    broken: null,
  } });
  expect(parsed.codexAccountPauseState?.a).toEqual({ revision: "revision-a" });
  expect(parsed.codexAccountPauseState?.b?.details?.pausedAt).toBe(42);
  expect(parsed.pausedCodexAccountIds).toEqual(["a", "b"]);
  expect(configSchema.parse({ ...config, codexAccountPauseState: "invalid" }).pausedCodexAccountIds).toEqual(["a", "b"]);
});

test("save-time reconciliation and full reload observe fingerprint changes before replacement", () => {
  const config = fixture();
  saveConfig(config);
  armClaudeCodeBaseline(config);
  const fence = captureAccountAutoPauseFence(config, "fixture")!;
  const disk = raw();
  disk.providers.fixture.accountAutoPause.consecutiveFailures = 3;
  writeFileSync(join(home, "config.json"), JSON.stringify(disk));
  config.port++;
  saveConfigPreservingClaudeCode(config);
  expect(config.providers.fixture!.accountAutoPause!.consecutiveFailures).toBe(3);
  expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
  const newer = captureAccountAutoPauseFence(config, "fixture")!;
  const baseline = structuredClone(config);
  disk.providers.fixture.accountAutoPause.consecutiveFailures = 2;
  writeFileSync(join(home, "config.json"), JSON.stringify(disk));
  reconcileLiveConfigFromDisk(config, baseline);
  expect(accountAutoPauseFenceIsLocal("fixture", newer)).toBe(false);
});


test("initial publication normalizes caller epochs for configured providers", () => {
  const config = fixture();
  const caller = randomUUID();
  config.accountAutoPausePolicyRevisions = { fixture: caller };
  expect(initializePersistedConfigIfMissing(config)).toBe("created");
  expect(revision()).not.toBe(caller);
  expect(captureAccountAutoPauseFence(config, "fixture")?.diskRevision).toBe(revision());
});

test("post-publication bookkeeping failure still adopts the new policy epoch", async () => {
  const config = fixture();
  saveConfig(config);
  const fence = captureAccountAutoPauseFence(config, "fixture")!;
  const registries = await import("../../src/config/derived-registries");
  const { ConfigWritePublishedError } = await import("../../src/config/persist-unlocked");
  const fail = spyOn(registries, "refreshConfigDerivedRegistries").mockImplementation(() => { throw new Error("synthetic bookkeeping failure"); });
  try {
    config.providers.fixture!.accountAutoPause!.enabled = false;
    expect(() => saveConfig(config)).toThrow(ConfigWritePublishedError);
    expect(revision()).not.toBe(fence.diskRevision);
    expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
  } finally { fail.mockRestore(); }
});

test("a detached loadConfig snapshot adopts the disk epoch without invalidating an in-flight fence", () => {
  saveConfig(fixture());
  const live = structuredClone(loadConfig());
  // The live object differs from disk in memory only; its own observation advances the generation.
  live.providers.fixture!.accountAutoPause = { enabled: true, consecutiveFailures: 3 };
  observeAccountAutoPauseRevisions(live, raw());
  const fence = captureAccountAutoPauseFence(live, "fixture");
  expect(fence).toBeDefined();
  loadConfig();
  loadConfig();
  expect(accountAutoPauseFenceIsLocal("fixture", fence!)).toBe(true);
});


test("an observed external policy change and restore invalidates an older attempt", () => {
  saveConfig(fixture());
  const live = loadConfig();
  const fence = captureAccountAutoPauseFence(live, "fixture");
  expect(fence).toBeDefined();
  const original = bytes();
  const edited = raw();
  edited.providers.fixture.accountAutoPause = { enabled: true, consecutiveFailures: 3 };
  writeFileSync(join(home, "config.json"), JSON.stringify(edited));
  loadConfig();
  writeFileSync(join(home, "config.json"), original);
  loadConfig();
  expect(raw().accountAutoPausePolicyRevisions.fixture).toBe(fence!.diskRevision);
  expect(accountAutoPauseFenceIsLocal("fixture", fence!)).toBe(false);
});

test("50 provider create/delete cycles retain only live disk revisions and observed entries", () => {
  const config = fixture();
  saveConfig(config);
  const survivor = revision();
  for (let cycle = 0; cycle < 50; cycle++) {
    const name = `temporary-${cycle}`;
    config.providers[name] = structuredClone(config.providers.fixture!);
    saveConfig(config);
    expect(Object.keys(raw().accountAutoPausePolicyRevisions).sort()).toEqual(["fixture", name]);
    expect(accountAutoPauseObservedSizeForTests()).toBe(2);
    delete config.providers[name];
    saveConfig(config);
    expect(Object.keys(raw().providers)).toEqual(["fixture"]);
    expect(Object.keys(raw().accountAutoPausePolicyRevisions)).toEqual(["fixture"]);
    expect(bytes()).not.toContain(`"${name}"`);
    expect(accountAutoPauseObservedSizeForTests()).toBe(1);
    expect(revision()).toBe(survivor);
  }
});

test("an unrelated save preserves every live provider UUID", () => {
  const config = fixture();
  config.providers.other = structuredClone(config.providers.fixture!);
  saveConfig(config);
  const first = raw().accountAutoPausePolicyRevisions;
  expect(Object.keys(first).sort()).toEqual(["fixture", "other"]);
  expect(first.fixture).not.toBe(first.other);
  config.port++;
  saveConfig(config);
  expect(raw().accountAutoPausePolicyRevisions).toEqual(first);
  saveConfig(loadConfig());
  expect(raw().accountAutoPausePolicyRevisions).toEqual(first);
});

test("a disk-only preserved provider retains its policy revision on an unrelated live save", () => {
  const config = fixture();
  saveConfig(config);
  const first = revision();
  const disk = raw();
  const diskOnlyRevision = randomUUID();
  disk.providers.external = structuredClone(disk.providers.fixture);
  disk.accountAutoPausePolicyRevisions.external = diskOnlyRevision;
  writeFileSync(join(home, "config.json"), JSON.stringify(disk));
  expect(config.providers.external).toBeUndefined();
  // The overlay reconciler publishes disk-only rows into this serialization registry.
  setPreservedDiskOnlyProviders({ external: disk.providers.external });
  try {
    config.port++;
    saveConfig(config);
    expect(config.providers.external).toBeUndefined();
    expect(raw().providers.external).toEqual(disk.providers.external);
    expect(raw().accountAutoPausePolicyRevisions).toEqual({ fixture: first, external: diskOnlyRevision });
    expect(accountAutoPauseObservedSizeForTests()).toBe(2);
  } finally { setPreservedDiskOnlyProviders(null); }
});

function captureKeyAttempt(config: ReturnType<typeof fixture>) {
  const route = routedProviderConfig("fixture", config.providers.fixture!);
  const observer = captureAccountAutoPauseAttempt("fixture", route, { config }, new Headers({ authorization: `Bearer ${route.apiKey}` }));
  expect(observer).toBeDefined();
  return observer!;
}
const refusal = () => Response.json({ error: { type: "permission_error", message: "Your subscription has expired." } }, { status: 403 });
async function expectStaleAttemptRejected(config: ReturnType<typeof fixture>, attempt: ReturnType<typeof captureKeyAttempt>) {
  const response = refusal();
  expect(await attempt(response)).toBe(response);
  expect(wasAccountAutoPaused(response)).toBe(false);
  expect(config.providers.fixture!.apiKeyPool?.some(row => row.disabled === true) ?? false).toBe(false);
  expect(loadConfig().providers.fixture!.apiKeyPool?.some(row => row.disabled === true) ?? false).toBe(false);
  // A fresh attempt must still be able to pause the same credential after recreation.
  const current = refusal();
  await captureKeyAttempt(config)(current);
  expect(wasAccountAutoPaused(current)).toBe(true);
  expect(config.providers.fixture!.apiKeyPool?.[0]?.disabled).toBe(true);
  expect(loadConfig().providers.fixture!.apiKeyPool?.[0]?.disabled).toBe(true);
}

test("saveConfig delete/recreate mints a new UUID and rejects the pre-deletion attempt", async () => {
  const config = fixture();
  config.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
  saveConfig(config);
  const fence = captureAccountAutoPauseFence(config, "fixture")!;
  expect(fence).toBeDefined();
  const attempt = captureKeyAttempt(config);
  const row = structuredClone(config.providers.fixture!);
  delete config.providers.fixture;
  saveConfig(config);
  expect(raw().accountAutoPausePolicyRevisions).toBeUndefined();
  expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
  expect(accountAutoPauseObservedSizeForTests()).toBe(0);
  config.providers.fixture = row;
  saveConfig(config);
  expect(revision()).toMatch(/^[a-f0-9-]{36}$/);
  expect(revision()).not.toBe(fence.diskRevision);
  expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
  expect(accountAutoPauseObservedSizeForTests()).toBe(1);
  await expectStaleAttemptRejected(config, attempt);
});

test("legacy no-map observations delete/recreate without reviving a pre-deletion attempt", async () => {
  const config = fixture();
  config.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  observeAccountAutoPauseRevisions(config);
  const fence = captureAccountAutoPauseFence(config, "fixture")!;
  expect(fence.diskRevision).toBe("legacy");
  const attempt = captureKeyAttempt(config);
  const original = bytes();
  const row = structuredClone(config.providers.fixture!);
  delete config.providers.fixture;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  observeAccountAutoPauseRevisions(config);
  expect(accountAutoPauseObservedSizeForTests()).toBe(0);
  config.providers.fixture = row;
  writeFileSync(join(home, "config.json"), original);
  observeAccountAutoPauseRevisions(config);
  const recreated = captureAccountAutoPauseFence(config, "fixture")!;
  expect(recreated.diskRevision).toBe("legacy");
  expect(recreated.localGen).not.toBe(fence.localGen);
  expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
  expect(accountAutoPauseObservedSizeForTests()).toBe(1);
  await expectStaleAttemptRejected(config, attempt);
});

for (const epoch of ["persisted UUID", "legacy no-map"] as const) {
  test(`load-only ${epoch}: identical raw restore after observed deletion rejects the old fence and attempt`, async () => {
    const initial = fixture();
    initial.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
    initial.providers.keeper = { adapter: "openai-chat", baseUrl: "https://keeper.test/v1", authMode: "key" };
    initial.defaultProvider = "keeper";
    saveConfig(initial);
    if (epoch === "legacy no-map") {
      const disk = raw();
      delete disk.accountAutoPausePolicyRevisions;
      writeFileSync(join(home, "config.json"), JSON.stringify(disk));
    }
    const config = loadConfig();
    const original = bytes();
    const fence = captureAccountAutoPauseFence(config, "fixture")!;
    expect(fence).toBeDefined();
    expect(fence.diskRevision).toBe(epoch === "legacy no-map" ? "legacy" : revision());
    const attempt = captureKeyAttempt(config);
    const deleted = raw();
    delete deleted.providers.fixture;
    // A raw editor may leave the old UUID behind; absent providers must still be reclaimed.
    writeFileSync(join(home, "config.json"), JSON.stringify(deleted));
    expect(loadConfig().providers.fixture).toBeUndefined();
    expect(accountAutoPauseObservedSizeForTests()).toBe(1);
    expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
    writeFileSync(join(home, "config.json"), original);
    const restored = loadConfig();
    expect(bytes()).toBe(original);
    const recreated = captureAccountAutoPauseFence(restored, "fixture")!;
    expect(recreated.diskRevision).toBe(fence.diskRevision);
    expect(recreated.localGen).not.toBe(fence.localGen);
    expect(accountAutoPauseFenceIsLocal("fixture", fence)).toBe(false);
    expect(accountAutoPauseObservedSizeForTests()).toBe(2);
    await expectStaleAttemptRejected(config, attempt);
  });
}

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy no-map" : "persisted UUID"}: a stale live config cannot re-enroll a provider observed as deleted`, async () => {
    const config = fixture();
    config.providers.fixture!.accountAutoPause!.consecutiveFailures = 1;
    config.providers.other = { adapter: "openai-chat", baseUrl: "https://other.test/v1", authMode: "key", apiKey: "synthetic-other" };
    if (legacy) writeFileSync(join(home, "config.json"), JSON.stringify(config)); else saveConfig(config);
    loadConfig();
    const original = bytes();
    const deleted = raw();
    delete deleted.providers.fixture;
    deleted.defaultProvider = "other";
    writeFileSync(join(home, "config.json"), JSON.stringify(deleted));
    loadConfig();
    expect(accountAutoPauseObservedSizeForTests()).toBe(1);
    // The live object still holds the provider; capturing from it while it is deleted must not
    // re-enroll an observation or produce a fence that survives an identical restore.
    const route = routedProviderConfig("fixture", config.providers.fixture!);
    expect(captureAccountAutoPauseFence(config, "fixture")).toBeUndefined();
    expect(captureAccountAutoPauseAttempt("fixture", route, { config }, new Headers({ authorization: `Bearer ${route.apiKey}` }))).toBeUndefined();
    expect(accountAutoPauseObservedSizeForTests()).toBe(1);
    writeFileSync(join(home, "config.json"), original);
    loadConfig();
    expect(accountAutoPauseObservedSizeForTests()).toBe(2);
    const current = refusal();
    await captureKeyAttempt(config)(current);
    expect(wasAccountAutoPaused(current)).toBe(true);
  });
}

