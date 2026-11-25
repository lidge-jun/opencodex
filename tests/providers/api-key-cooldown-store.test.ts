import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { saveConfig } from "../../src/config";
import {
  apiKeyCooldownGeneration,
  clearKeyCooldowns,
  getKeyCooldownUntil,
  isKeyInCooldown,
  reconcileApiKeyCooldownGenerations,
  resetLocalApiKeyCooldowns,
  setKeyCooldown,
} from "../../src/providers/api-key-cooldowns";
import {
  API_KEY_COOLDOWN_FILE,
  ApiKeyCooldownStore,
  installApiKeyCooldownPersistence,
  isInlineApiKey,
  uninstallApiKeyCooldownPersistence,
  type ApiKeyCooldownHold,
  type ApiKeyCooldownRow,
} from "../../src/providers/api-key-cooldown-store";
import { rotateKeyOn429 } from "../../src/providers/key-failover";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { acquireServerBackgroundLifecycle } from "../../src/server/background-lifecycle";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previous: string | undefined;
const file = (dir = home) => join(dir, API_KEY_COOLDOWN_FILE);
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as { rows: ApiKeyCooldownRow[]; epochs: Record<string, number>; allEpoch: number };
const hold = (keyId: string, key: string, cooldownUntil: number, provider = "p"): ApiKeyCooldownHold =>
  ({ provider, keyId, generation: apiKeyCooldownGeneration(provider, keyId, key), cooldownUntil });
const row = (keyId: string, key: string, cooldownUntil: number, provider = "p"): ApiKeyCooldownRow =>
  ({ ...hold(keyId, key, cooldownUntil, provider), epoch: 0, allEpoch: 0 });
const writeRows = (rows: ApiKeyCooldownRow[], dir = home) => writeFileSync(file(dir), JSON.stringify({ version: 1, rows }));
const keyIds = (rows: { keyId: string }[]) => rows.map(r => r.keyId).sort();

function config(keys: Record<string, string>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "p",
    providers: {
      p: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: Object.values(keys)[0],
        apiKeyPool: Object.entries(keys).map(([id, key], index) => ({ id, key, addedAt: index + 1 })),
      } as OcxProviderConfig,
    },
  } as OcxConfig;
}

/** A restart: the process memory is gone, the file is not. */
function restart(cfg: OcxConfig): ApiKeyCooldownStore {
  uninstallApiKeyCooldownPersistence();
  resetLocalApiKeyCooldowns();
  return installApiKeyCooldownPersistence(cfg);
}

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  resetLocalApiKeyCooldowns();
});
afterEach(() => {
  uninstallApiKeyCooldownPersistence();
  resetLocalApiKeyCooldowns();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home);
});

test("a key cooled before a restart stays cooled until its expiry", () => {
  const cfg = config({ a: "sk-alpha-0001", b: "sk-beta-0002" });
  const store = installApiKeyCooldownPersistence(cfg);
  const until = Date.now() + 60_000;
  setKeyCooldown("p", "a", until, "sk-alpha-0001");
  expect(store.flush()).toBe(true);
  expect(stored().rows).toEqual([row("a", "sk-alpha-0001", until)]);
  expect(readFileSync(file(), "utf8")).not.toContain("sk-alpha");

  restart(cfg);
  expect(getKeyCooldownUntil("p", "a")).toBe(until);
  expect(isKeyInCooldown("p", "b")).toBe(false);
});

test("a failover rotation records the failed key's row", () => {
  const cfg = config({ k1: "key-alpha-000111222333", k2: "key-beta-444555666777" });
  saveConfig(cfg);
  const store = installApiKeyCooldownPersistence(cfg);
  const now = Date.now();
  expect(rotateKeyOn429(cfg, "p", "120", now)?.apiKey).toBe("key-beta-444555666777");
  expect(store.flush()).toBe(true);
  expect(stored().rows).toEqual([row("k1", "key-alpha-000111222333", now + 120_000)]);
});

test("expired and malformed rows are ignored at load", () => {
  const now = Date.now();
  writeRows([row("a", "sk-alpha-0001", now - 1_000), row("b", "sk-beta-0002", now + 60_000)]);
  installApiKeyCooldownPersistence(config({ a: "sk-alpha-0001", b: "sk-beta-0002" }));
  expect(isKeyInCooldown("p", "a")).toBe(false);
  expect(isKeyInCooldown("p", "b")).toBe(true);

  writeFileSync(file(), "{not json");
  restart(config({ a: "sk-alpha-0001", b: "sk-beta-0002" }));
  expect(isKeyInCooldown("p", "b")).toBe(false);
});

test("a key replaced under the same id does not inherit the old key's hold", () => {
  writeRows([row("a", "sk-old-0001", Date.now() + 60_000)]);
  installApiKeyCooldownPersistence(config({ a: "sk-new-0002" }));
  expect(isKeyInCooldown("p", "a")).toBe(false);

  // While running: a replaced key drops the hold at the next reconcile.
  setKeyCooldown("p", "a", Date.now() + 60_000, "sk-new-0002");
  expect(reconcileApiKeyCooldownGenerations(config({ a: "sk-new-0002" }).providers)).toBe(0);
  expect(reconcileApiKeyCooldownGenerations(config({ a: "sk-newer-0003" }).providers)).toBe(1);
  expect(isKeyInCooldown("p", "a")).toBe(false);
});

test("a cooldown for a new key replaces a longer hold of the old key", () => {
  const now = Date.now();
  setKeyCooldown("p", "a", now + 600_000, "sk-old-0001");
  setKeyCooldown("p", "a", now + 60_000, "sk-new-0002");
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
  setKeyCooldown("p", "a", now + 30_000, "sk-new-0002");
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
});

test("a manual clear is persisted, so a restart does not revive the hold", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const store = installApiKeyCooldownPersistence(cfg);
  setKeyCooldown("p", "a", Date.now() + 60_000, "sk-alpha-0001");
  expect(store.flush()).toBe(true);
  clearKeyCooldowns("p");
  expect(store.flush()).toBe(true);
  expect(stored().rows).toEqual([]);

  restart(cfg);
  expect(isKeyInCooldown("p", "a")).toBe(false);
});

test("a hold recorded right after a clear in the same process survives it", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const store = installApiKeyCooldownPersistence(cfg);
  const now = Date.now();
  setKeyCooldown("p", "a", now + 600_000, "sk-alpha-0001");
  // No time passes between these: ordering comes from the clear counter, not the clock.
  clearKeyCooldowns("p");
  setKeyCooldown("p", "a", now + 60_000, "sk-alpha-0001");
  expect(store.flush(now)).toBe(true);
  expect(stored().rows.map(r => r.cooldownUntil)).toEqual([now + 60_000]);
  restart(cfg);
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
});

test("a provider clear removes peer rows for that provider, and a global clear removes every row", () => {
  const now = Date.now();
  writeRows([row("a", "sk-a", now + 60_000), row("x", "sk-x", now + 60_000, "q")]);
  const store = new ApiKeyCooldownStore(home);
  store.load(now);
  store.clear("p");
  store.record(hold("b", "sk-b", now + 30_000));
  expect(store.flush(now)).toBe(true);
  expect(keyIds(stored().rows)).toEqual(["b", "x"]);
  store.clear();
  expect(store.flush(now)).toBe(true);
  expect(stored().rows).toEqual([]);
  expect(new ApiKeyCooldownStore(home).load(now)).toEqual([]);
});

test("a peer's pending holds from before a clear never come back, however late it flushes", () => {
  const now = Date.now();
  const slow = new ApiKeyCooldownStore(home);
  slow.load(now);
  slow.record(hold("a", "sk-a", now + 600_000));
  const clearing = new ApiKeyCooldownStore(home);
  clearing.load(now);
  clearing.clear("p");
  expect(clearing.flush(now)).toBe(true);
  // The slow peer has not seen the clear: a shorter hold it records now is still pre-clear evidence.
  slow.record(hold("a", "sk-a", now + 60_000));
  expect(slow.flush(now)).toBe(true);
  expect(stored().rows).toEqual([]);
  // Having flushed, it knows the clear; its next hold persists.
  slow.record(hold("a", "sk-a", now + 30_000));
  expect(slow.flush(now)).toBe(true);
  expect(stored().rows.map(r => r.cooldownUntil)).toEqual([now + 30_000]);
});

test("two processes sharing a home merge their rows and never shorten a peer's hold", () => {
  const now = Date.now();
  const first = new ApiKeyCooldownStore(home);
  const second = new ApiKeyCooldownStore(home);
  first.record(hold("a", "sk-a", now + 60_000));
  expect(first.flush(now)).toBe(true);
  second.record(hold("b", "sk-b", now + 60_000));
  second.record(hold("a", "sk-a", now + 30_000));
  expect(second.flush(now)).toBe(true);
  expect(stored().rows.sort((x, y) => x.keyId.localeCompare(y.keyId)))
    .toEqual([row("a", "sk-a", now + 60_000), row("b", "sk-b", now + 60_000)]);
});

test("a peer flushing an old key's row last cannot displace the current key's row", () => {
  const now = Date.now();
  const stale = new ApiKeyCooldownStore(home);
  const current = new ApiKeyCooldownStore(home);
  stale.record(hold("a", "sk-old", now + 600_000));
  current.record(hold("a", "sk-new", now + 60_000));
  expect(current.flush(now)).toBe(true);
  expect(stale.flush(now)).toBe(true);
  expect(stored().rows).toHaveLength(2);

  installApiKeyCooldownPersistence(config({ a: "sk-new" }), now);
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
});

test("only inline keys are persisted; every value the resolver reads elsewhere stays in memory", () => {
  for (const reference of ["${OCX_TEST_KEY}", "$OCX_TEST_KEY", "$KEY-NAME", "keychain:p/chain", "gcp-sa:p/acct"]) {
    expect(isInlineApiKey(reference)).toBe(false);
  }
  expect(isInlineApiKey("sk-inline")).toBe(true);
  const cfg = config({ env: "${OCX_TEST_KEY}", dash: "$KEY-NAME", chain: "keychain:p/chain", inline: "sk-inline" });
  const store = installApiKeyCooldownPersistence(cfg);
  const until = Date.now() + 60_000;
  for (const entry of cfg.providers.p!.apiKeyPool!) setKeyCooldown("p", entry.id, until, entry.key);
  expect(store.flush()).toBe(true);
  expect(keyIds(stored().rows)).toEqual(["inline"]);
  expect(isKeyInCooldown("p", "dash")).toBe(true);

  // A row written for a referenced entry is never restored either.
  writeRows([row("dash", "$KEY-NAME", until)]);
  restart(cfg);
  expect(isKeyInCooldown("p", "dash")).toBe(false);
});

test("switching homes drops the previous home's holds before restoring", () => {
  const now = Date.now();
  installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
  setKeyCooldown("p", "a", now + 600_000, "sk-one");
  const other = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-other-"));
  try {
    process.env.OPENCODEX_HOME = other;
    installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
    expect(isKeyInCooldown("p", "a", now)).toBe(false);
    uninstallApiKeyCooldownPersistence();

    writeRows([row("a", "sk-one", now + 60_000)], other);
    process.env.OPENCODEX_HOME = home;
    installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
    process.env.OPENCODEX_HOME = other;
    installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
    expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
  } finally {
    uninstallApiKeyCooldownPersistence();
    process.env.OPENCODEX_HOME = home;
    removeTreeWithRetry(other);
  }
});

test("only a live server binds the file, and its final release detaches it", async () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const until = Date.now() + 60_000;
  writeRows([row("a", "sk-alpha-0001", until)]);
  setLiveStateStoreConfig(cfg);
  expect(isKeyInCooldown("p", "a")).toBe(false);

  const lease = acquireServerBackgroundLifecycle(() => {}, cfg);
  expect(getKeyCooldownUntil("p", "a")).toBe(until);
  await lease.release();

  // After the last server stops, a cooldown and a clear stay in memory and leave the file alone.
  const before = readFileSync(file(), "utf8");
  setKeyCooldown("p", "a", until + 60_000, "sk-alpha-0001");
  clearKeyCooldowns("p");
  await wait(400);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("a peer's clear also drops this process's in-memory hold, so a later refusal is not extended by it", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const store = installApiKeyCooldownPersistence(cfg);
  const now = Date.now();
  setKeyCooldown("p", "a", now + 600_000, "sk-alpha-0001");
  expect(store.flush(now)).toBe(true);
  const peer = new ApiKeyCooldownStore(home);
  peer.load(now);
  peer.clear("p");
  expect(peer.flush(now)).toBe(true);

  // Recorded before this process learned of the clear: neither persisted nor kept as the old maximum.
  setKeyCooldown("p", "a", now + 30_000, "sk-alpha-0001");
  expect(store.flush(now)).toBe(true);
  expect(stored().rows).toEqual([]);
  expect(isKeyInCooldown("p", "a", now)).toBe(false);

  setKeyCooldown("p", "a", now + 30_000, "sk-alpha-0001");
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 30_000);
  expect(store.flush(now)).toBe(true);
  expect(stored().rows.map(r => r.cooldownUntil)).toEqual([now + 30_000]);
});

test("a server for another home started after the last one stopped inherits no holds", () => {
  const now = Date.now();
  installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
  setKeyCooldown("p", "a", now + 600_000, "sk-one");
  uninstallApiKeyCooldownPersistence();
  const other = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-other-"));
  try {
    process.env.OPENCODEX_HOME = other;
    installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
    expect(isKeyInCooldown("p", "a", now)).toBe(false);
  } finally {
    uninstallApiKeyCooldownPersistence();
    process.env.OPENCODEX_HOME = home;
    removeTreeWithRetry(other);
  }
});

test("pending holds coalesce while writes keep failing", () => {
  const now = Date.now();
  const store = new ApiKeyCooldownStore(home);
  // A directory where the file belongs makes every write fail.
  mkdirSync(file());
  for (let i = 1; i <= 500; i += 1) store.record(hold("a", "sk-a", now + i * 1_000));
  store.record(hold("b", "sk-b", now + 5_000));
  expect(store.flush(now)).toBe(false);
  expect(store.flush(now)).toBe(false);
  expect(store.pendingHolds).toBe(2);
  rmdirSync(file());
  expect(store.flush(now)).toBe(true);
  expect(stored().rows.map(r => [r.keyId, r.cooldownUntil]).sort()).toEqual([["a", now + 500_000], ["b", now + 5_000]]);
});

test("a store whose home was removed drops its pending rows", () => {
  const gone = join(home, "gone");
  const store = new ApiKeyCooldownStore(gone);
  store.record(hold("a", "sk-a", Date.now() + 60_000));
  expect(store.flush()).toBe(true);
  expect(existsSync(gone)).toBe(false);
});
