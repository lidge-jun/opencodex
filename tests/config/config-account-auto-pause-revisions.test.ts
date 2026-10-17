import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, initializePersistedConfigIfMissing, loadConfig, saveConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { captureAccountAutoPauseFence, accountAutoPauseFenceIsLocal, observeAccountAutoPauseRevisions } from "../../src/config/account-auto-pause-revisions";
import { armClaudeCodeBaseline, reconcileLiveConfigFromDisk, saveConfigPreservingClaudeCode } from "../../src/config/live-reconcile";
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

test("caller epochs are ignored, unrelated edits preserve UUIDs and removed policies retain entries", () => {
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
  delete config.providers.fixture;
  saveConfig(config);
  expect(revision()).not.toBe(removedPolicy);
  expect(revision()).toBeDefined();
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
