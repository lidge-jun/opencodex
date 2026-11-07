import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../../helpers/remove-tree";
import { getAccountSet, removeAccount, saveCredential, saveAccountCredential, markAccountNeedsReauth } from "../../../src/oauth/store";
import { AnthropicSessionAffinityStore, anthropicAffinityDigest, anthropicAffinityPath,
  AFFINITY_IDLE_TTL_MS, MAX_AFFINITY_FILE_BYTES } from "../../../src/oauth/anthropic-session-affinity-store";
import { atomicWriteFile, atomicWriteFileNoFollow } from "../../../src/config/atomic-write";
import { runOptionalShutdownHooks } from "../../../src/lib/optional-shutdown-hooks";
import { settleBackgroundWork } from "../../../src/lib/background-work";
import * as authStore from "../../../src/oauth/store";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let id: string;
let stores: AnthropicSessionAffinityStore[];
const secret = "never-store-this-session-or-bearer";
const key = anthropicAffinityDigest("anthropic", secret);
const path = () => anthropicAffinityPath(home, "anthropic");
const credential = () => ({ access: "fixture-only-bearer", refresh: "fixture-only-refresh", expires: Date.now() + 3_600_000, accountId: "fixture-account" });
function owner(instance: "anthropic" | "anthropic2" = "anthropic", write?: typeof atomicWriteFile) {
  const store = new AnthropicSessionAffinityStore(instance, write); stores.push(store); return store;
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-affinity-store-")); process.env.OPENCODEX_HOME = home; stores = [];
  await saveCredential("anthropic", credential()); id = getAccountSet("anthropic")!.accounts[0]!.id;
});
afterEach(async () => {
  for (const store of stores) { await store.flush(); store.resetMemory(); }
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});
async function snapshot() {
  const store = owner(); store.set(key, { accountId: id, lastUsedAt: Date.now() }); await store.flush();
  return { store, data: JSON.parse(readFileSync(path(), "utf8")) };
}
test("snapshot contains only digests, opaque account and timestamp", async () => {
  const { store } = await snapshot(); const bytes = readFileSync(path(), "utf8");
  for (const value of [secret, "fixture-only-bearer", "fixture-only-refresh", "fixture-account"]) expect(bytes).not.toContain(value);
  const row = JSON.parse(bytes).entries[0];
  expect(Object.keys(row).sort()).toEqual(["accountId", "lastUsedAt", "loginFence", "sessionDigest"]);
  expect(row.sessionDigest).toBe(key); expect(row.loginFence).toMatch(/^[a-f0-9]{64}$/);
  store.resetMemory(); expect(store.get(key)?.accountId).toBe(id);
});
test("back-to-back structural mutations are both persisted and raw keys are refused", async () => {
  const store = owner(); const other = anthropicAffinityDigest("anthropic", "second");
  store.set(key, { accountId: id, lastUsedAt: Date.now() });
  store.set(other, { accountId: id, lastUsedAt: Date.now() });
  store.set(secret, { accountId: id, lastUsedAt: Date.now() });
  await store.flush(); store.resetMemory();
  expect(store.size).toBe(2); expect(store.get(other)?.accountId).toBe(id);
  expect(readFileSync(path(), "utf8")).not.toContain(secret);
});
test("load rejects expired and future rows and keeps the newest 2000", async () => {
  const { store, data } = await snapshot(); const now = Date.now(); const base = data.entries[0];
  data.entries = Array.from({ length: 2002 }, (_, i) => ({ ...base,
    sessionDigest: i.toString(16).padStart(64, "0"), lastUsedAt: now - i }));
  data.entries.push({ ...base, sessionDigest: "a".repeat(64), lastUsedAt: now - AFFINITY_IDLE_TTL_MS - 1 },
    { ...base, sessionDigest: "b".repeat(64), lastUsedAt: now + 60_000 });
  writeFileSync(path(), JSON.stringify(data)); store.resetMemory();
  expect(store.size).toBe(2000); expect(store.get((2001).toString(16).padStart(64, "0"))).toBeUndefined();
  expect(store.get("a".repeat(64))).toBeUndefined(); expect(store.get("b".repeat(64))).toBeUndefined();
});
test.each(["{bad json", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{}] }), " ".repeat(MAX_AFFINITY_FILE_BYTES + 1)])("invalid or oversized snapshot is ignored (%#)", bytes => {
  writeFileSync(path(), bytes); expect(owner().size).toBe(0);
});
test("provider instance and config home are isolated", async () => {
  const { store } = await snapshot();
  expect(owner("anthropic2").get(key)).toBeUndefined();
  const other = mkdtempSync(join(tmpdir(), "ocx-affinity-other-"));
  try { process.env.OPENCODEX_HOME = other; expect(store.get(key)).toBeUndefined(); }
  finally { store.resetMemory(); process.env.OPENCODEX_HOME = home; removeTreeWithRetry(other); }
  expect(store.get(key)?.accountId).toBe(id);
});
test("token refresh keeps the fence while replacement login invalidates", async () => {
  const { store } = await snapshot();
  await saveAccountCredential("anthropic", id, { ...credential(), access: "fixture-refreshed-token" });
  store.resetMemory(); expect(store.get(key)?.accountId).toBe(id);
  await saveCredential("anthropic", credential());
  store.resetMemory(); expect(store.get(key)).toBeUndefined();
});
test("removal and re-add cannot resurrect the old snapshot", async () => {
  const { store } = await snapshot(); const old = readFileSync(path(), "utf8");
  await removeAccount("anthropic", id); await saveCredential("anthropic", credential());
  writeFileSync(path(), old); store.resetMemory(); expect(store.get(key)).toBeUndefined();
});
test("reauthentication invalidation is persisted before the flag clears", async () => {
  const { store } = await snapshot();
  await markAccountNeedsReauth("anthropic", id, true);
  store.resetMemory(); expect(store.get(key)).toBeUndefined(); await store.flush();
  await markAccountNeedsReauth("anthropic", id, false);
  store.resetMemory(); expect(store.get(key)).toBeUndefined();
  expect(JSON.parse(readFileSync(path(), "utf8")).entries).toEqual([]);
});
test("failed atomic publication retains previous bytes and reports no identifiers", async () => {
  await snapshot(); const before = readFileSync(path(), "utf8");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = owner("anthropic", (p, content) => atomicWriteFile(p, content, undefined, {
      beforeRename: () => { throw new Error("fixture publication failure"); },
    }));
    store.set(anthropicAffinityDigest("anthropic", "second"), { accountId: id, lastUsedAt: Date.now() });
    await store.flush(); expect(readFileSync(path(), "utf8")).toBe(before);
    expect(warning).toHaveBeenCalled(); expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    store.resetMemory();
  } finally { warning.mockRestore(); }
});
test("timestamp touches coalesce and shutdown flushes the latest use", async () => {
  let writes = 0; const store = owner("anthropic", (...args) => { writes++; atomicWriteFile(...args); });
  const now = Date.now(); store.set(key, { accountId: id, lastUsedAt: now - 100 }); await store.flush();
  store.set(key, { accountId: id, lastUsedAt: now - 50 }); store.set(key, { accountId: id, lastUsedAt: now });
  expect(writes).toBe(1); runOptionalShutdownHooks();
  expect((await settleBackgroundWork({ timeoutMs: 5_000 })).settled).toBe(true);
  expect(writes).toBe(2);
  expect(JSON.parse(readFileSync(path(), "utf8")).entries[0].lastUsedAt).toBe(now);
});

test("2000 bindings use one auth snapshot per hydration, touch and invalidation", async () => {
  const { store, data } = await snapshot();
  data.entries = Array.from({ length: 2000 }, (_, i) => ({ ...data.entries[0],
    sessionDigest: i.toString(16).padStart(64, "0") }));
  writeFileSync(path(), JSON.stringify(data)); store.resetMemory();
  const accounts = getAccountSet("anthropic");
  const reads = spyOn(authStore, "getAccountSet").mockImplementation(() => accounts);
  try {
    expect(store.size).toBe(2000); const hydrationReads = reads.mock.calls.length;
    reads.mockClear();
    const touched = "0".repeat(64);
    store.set(touched, { accountId: id, lastUsedAt: Date.now() });
    const setReads = reads.mock.calls.length;
    reads.mockClear(); expect(store.get(touched)?.accountId).toBe(id);
    const getReads = reads.mock.calls.length;
    reads.mockClear(); await store.flush();
    expect([hydrationReads, setReads, getReads, reads.mock.calls.length]).toEqual([1, 1, 1, 0]);
    accounts!.accounts[0]!.paused = true;
    reads.mockClear(); store.invalidate(accounts);
    expect(reads).not.toHaveBeenCalled(); expect(store.size).toBe(0);
    reads.mockClear(); store.invalidate(); expect(reads).toHaveBeenCalledTimes(1);
  } finally { reads.mockRestore(); }
});

const linkProbe = mkdtempSync(join(tmpdir(), "ocx-affinity-link-probe-"));
let linkUnavailable = false;
try { symlinkSync(join(linkProbe, "absent"), join(linkProbe, "link"), "file"); }
catch (error) {
  if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  linkUnavailable = true;
  console.warn("[affinity test] skipping file symlinks: Windows EPERM (symlink privilege unavailable)");
} finally { removeTreeWithRetry(linkProbe); }
for (const dangling of [false, true]) test.skipIf(linkUnavailable)(`final ${dangling ? "dangling" : "external-target"} symlink is neither loaded nor followed on publication`, async () => {
  const { store, data } = await snapshot(); store.resetMemory();
  const external = mkdtempSync(join(tmpdir(), "ocx-affinity-external-"));
  const target = join(external, "snapshot.json");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // Replace the fixture's own snapshot with a link to a target outside the config home.
    unlinkSync(path());
    if (!dangling) writeFileSync(target, JSON.stringify(data));
    symlinkSync(target, path(), "file");
    expect(store.size).toBe(0); expect(warning).toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(home);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(id);
    store.set(key, { accountId: id, lastUsedAt: Date.now() }); await store.flush();
    expect(lstatSync(path()).isSymbolicLink()).toBe(false);
    if (dangling) expect(existsSync(target)).toBe(false);
    else expect(readFileSync(target, "utf8")).toBe(JSON.stringify(data));
  } finally { warning.mockRestore(); store.resetMemory(); removeTreeWithRetry(external); }
});

test("pending writes and shutdown cannot publish a previous home's rows", async () => {
  // Every publication is recorded: the invariant is that rows bound to `home` are only ever
  // written under `home`. Whether the first write settles before the switch is platform
  // timing (Windows waits for ACL settlement, POSIX writes at once), so it is not asserted.
  const targets: string[] = [];
  const store = owner("anthropic", ((target: string, ...rest: unknown[]) => {
    targets.push(target);
    return (atomicWriteFileNoFollow as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof atomicWriteFile);
  const other = mkdtempSync(join(tmpdir(), "ocx-affinity-switched-"));
  try {
    store.set(key, { accountId: id, lastUsedAt: Date.now() });
    process.env.OPENCODEX_HOME = other;
    await store.flush();
    expect(existsSync(anthropicAffinityPath(other, "anthropic"))).toBe(false);
    runOptionalShutdownHooks(); await settleBackgroundWork({ timeoutMs: 5_000 });
    expect(existsSync(anthropicAffinityPath(other, "anthropic"))).toBe(false);
    expect(targets.every(target => target === path())).toBe(true);
    process.env.OPENCODEX_HOME = home;
    // Back in its own home the store never serves a row written for another one.
    const restored = store.get(key);
    expect(restored === undefined || restored.accountId === id).toBe(true);
    expect(existsSync(anthropicAffinityPath(other, "anthropic"))).toBe(false);
  } finally { store.resetMemory(); process.env.OPENCODEX_HOME = home; removeTreeWithRetry(other); }
});

test("a config-home directory alias preserves hydration and no-follow publication", async () => {
  const { store } = await snapshot(); store.resetMemory();
  const other = mkdtempSync(join(tmpdir(), "ocx-affinity-alias-"));
  const alias = join(other, "home");
  try {
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    process.env.OPENCODEX_HOME = alias;
    expect(store.get(key)?.accountId).toBe(id);
    const otherKey = anthropicAffinityDigest("anthropic", "aliased-session");
    store.set(otherKey, { accountId: id, lastUsedAt: Date.now() }); await store.flush();
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    process.env.OPENCODEX_HOME = home;
    expect(store.get(otherKey)?.accountId).toBe(id);
  } finally { store.resetMemory(); process.env.OPENCODEX_HOME = home; removeTreeWithRetry(other); }
});
