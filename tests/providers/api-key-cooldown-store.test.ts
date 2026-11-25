import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { configPathOwnership } from "../../src/lib/config-ownership";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { getConfigPath, saveConfig } from "../../src/config";
import {
  apiKeyCooldownGeneration,
  clearKeyCooldowns,
  getKeyCooldownUntil,
  isKeyInCooldown,
  isKeyQuotaSpent,
  reconcileApiKeyCooldownGenerations,
  resetLocalApiKeyCooldowns,
  restoreApiKeyCooldowns,
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
  setKeyCooldown("p", "a", until, false, "sk-alpha-0001");
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

test.skipIf(process.platform === "win32")("the cooldown file is private like config.json and holds no key or fingerprint source", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  saveConfig(cfg);
  const store = installApiKeyCooldownPersistence(cfg);
  setKeyCooldown("p", "a", Date.now() + 60_000, false, "sk-alpha-0001");
  expect(store.flush()).toBe(true);
  expect(statSync(file()).mode & 0o777).toBe(0o600);
  expect(statSync(file()).mode & 0o777).toBe(statSync(getConfigPath()).mode & 0o777);
  expect(readFileSync(file(), "utf8")).not.toContain("sk-alpha-0001");
});

test("a provider named like an Object.prototype member keeps its holds across a restart", () => {
  for (const name of ["valueOf", "toString"]) {
    const cfg = config({ a: "sk-alpha-0001" });
    cfg.providers = { [name]: cfg.providers.p! };
    cfg.defaultProvider = name;
    const store = restart(cfg);
    const until = Date.now() + 60_000;
    setKeyCooldown(name, "a", until, false, "sk-alpha-0001");
    expect(store.flush()).toBe(true);
    restart(cfg);
    expect(getKeyCooldownUntil(name, "a")).toBe(until);
  }
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
  setKeyCooldown("p", "a", Date.now() + 60_000, false, "sk-new-0002");
  expect(reconcileApiKeyCooldownGenerations(config({ a: "sk-new-0002" }).providers)).toBe(0);
  expect(reconcileApiKeyCooldownGenerations(config({ a: "sk-newer-0003" }).providers)).toBe(1);
  expect(isKeyInCooldown("p", "a")).toBe(false);
});

test("a cooldown for a new key replaces a longer hold of the old key", () => {
  const now = Date.now();
  setKeyCooldown("p", "a", now + 600_000, false, "sk-old-0001");
  setKeyCooldown("p", "a", now + 60_000, false, "sk-new-0002");
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
  setKeyCooldown("p", "a", now + 30_000, false, "sk-new-0002");
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
});

test("a manual clear is persisted, so a restart does not revive the hold", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const store = installApiKeyCooldownPersistence(cfg);
  setKeyCooldown("p", "a", Date.now() + 60_000, false, "sk-alpha-0001");
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
  setKeyCooldown("p", "a", now + 600_000, false, "sk-alpha-0001");
  // No time passes between these: ordering comes from the clear counter, not the clock.
  clearKeyCooldowns("p");
  setKeyCooldown("p", "a", now + 60_000, false, "sk-alpha-0001");
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
  for (const entry of cfg.providers.p!.apiKeyPool!) setKeyCooldown("p", entry.id, until, false, entry.key);
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
  setKeyCooldown("p", "a", now + 600_000, false, "sk-one");
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
  expect(isKeyInCooldown("p", "a")).toBe(false);

  // After the last server stops, a cooldown and a clear stay in memory and leave the file alone.
  const before = readFileSync(file(), "utf8");
  setKeyCooldown("p", "a", until + 60_000, false, "sk-alpha-0001");
  clearKeyCooldowns("p");
  await wait(400);
  expect(readFileSync(file(), "utf8")).toBe(before);
});

test("a peer's clear also drops this process's in-memory hold, so a later refusal is not extended by it", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const store = installApiKeyCooldownPersistence(cfg);
  const now = Date.now();
  setKeyCooldown("p", "a", now + 600_000, false, "sk-alpha-0001");
  expect(store.flush(now)).toBe(true);
  const peer = new ApiKeyCooldownStore(home);
  peer.load(now);
  peer.clear("p");
  expect(peer.flush(now)).toBe(true);

  // Recorded before this process learned of the clear: neither persisted nor kept as the old maximum.
  setKeyCooldown("p", "a", now + 30_000, false, "sk-alpha-0001");
  expect(store.flush(now)).toBe(true);
  expect(stored().rows).toEqual([]);
  expect(isKeyInCooldown("p", "a", now)).toBe(false);

  setKeyCooldown("p", "a", now + 30_000, false, "sk-alpha-0001");
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 30_000);
  expect(store.flush(now)).toBe(true);
  expect(stored().rows.map(r => r.cooldownUntil)).toEqual([now + 30_000]);
});

for (const scope of ["provider", "global"] as const) {
  test(`a ${scope} clear rebased above a peer's keeps the hold recorded after it`, () => {
    const cfg = config({ a: "sk-alpha-0001" });
    const store = installApiKeyCooldownPersistence(cfg);
    const now = Date.now();
    const peer = new ApiKeyCooldownStore(home);
    peer.load(now);
    if (scope === "provider") peer.clear("p"); else peer.clear();
    expect(peer.flush(now)).toBe(true);

    // This process clears without having seen the peer's clear, then records a fresh refusal.
    clearKeyCooldowns(scope === "provider" ? "p" : undefined);
    setKeyCooldown("p", "a", now + 60_000, false, "sk-alpha-0001");
    expect(store.flush(now)).toBe(true);
    expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
    expect(stored().rows.map(r => r.cooldownUntil)).toEqual([now + 60_000]);
    restart(cfg);
    expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 60_000);
  });
}

test("a server for another home started after the last one stopped inherits no holds", () => {
  const now = Date.now();
  installApiKeyCooldownPersistence(config({ a: "sk-one" }), now);
  setKeyCooldown("p", "a", now + 600_000, false, "sk-one");
  // The final server release.
  uninstallApiKeyCooldownPersistence({ dropLocalHolds: true });
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

test("a spent-quota hold stays spent across a restart, so a quota-only Combo can leave a spent pool", () => {
  const cfg = config({ a: "sk-alpha-0001", b: "sk-beta-0002" });
  const store = installApiKeyCooldownPersistence(cfg);
  const until = Date.now() + 600_000;
  setKeyCooldown("p", "a", until, true, "sk-alpha-0001");
  setKeyCooldown("p", "b", until, true, "sk-beta-0002");
  expect(store.flush()).toBe(true);
  restart(cfg);
  // The predicate core-combo-failure uses: every enabled key refused with a spent quota.
  expect(["a", "b"].every(id => isKeyQuotaSpent("p", id))).toBe(true);
  expect(isKeyInCooldown("p", "a")).toBe(true);
});

test("a longer ordinary hold keeps the shorter spent-quota evidence, on restore and across peers", () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const now = Date.now();
  const generation = apiKeyCooldownGeneration("p", "a", "sk-alpha-0001");
  setKeyCooldown("p", "a", now + 60_000, true, "sk-alpha-0001");
  restoreApiKeyCooldowns([{ provider: "p", keyId: "a", generation, cooldownUntil: now + 600_000 }], now);
  expect(getKeyCooldownUntil("p", "a", now)).toBe(now + 600_000);
  expect(isKeyQuotaSpent("p", "a", now)).toBe(true);

  resetLocalApiKeyCooldowns();
  const spentPeer = new ApiKeyCooldownStore(home);
  const ordinaryPeer = new ApiKeyCooldownStore(home);
  spentPeer.record({ ...hold("a", "sk-alpha-0001", now + 60_000), quotaSpentUntil: now + 60_000 });
  ordinaryPeer.record(hold("a", "sk-alpha-0001", now + 600_000));
  expect(spentPeer.flush()).toBe(true);
  expect(ordinaryPeer.flush()).toBe(true);
  expect(stored().rows).toEqual([{ ...row("a", "sk-alpha-0001", now + 600_000), quotaSpentUntil: now + 60_000 }]);
  restart(cfg);
  expect(getKeyCooldownUntil("p", "a")).toBe(now + 600_000);
  expect(isKeyQuotaSpent("p", "a")).toBe(true);
});

test("when a newer server for another home stops, the surviving server's home gets its cooldowns back", async () => {
  const cfg = config({ a: "sk-alpha-0001" });
  const until = Date.now() + 60_000;
  writeRows([row("a", "sk-alpha-0001", until)]);
  const first = acquireServerBackgroundLifecycle(() => {}, cfg);
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-other-"));
  try {
    expect(getKeyCooldownUntil("p", "a")).toBe(until);
    process.env.OPENCODEX_HOME = otherHome;
    const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
    expect(isKeyInCooldown("p", "a")).toBe(false); // the other home's server starts with that home's holds
    await second.release();
    process.env.OPENCODEX_HOME = home;
    expect(getKeyCooldownUntil("p", "a")).toBe(until); // the surviving server's holds and file are back
    setKeyCooldown("p", "a", until + 60_000, false, "sk-alpha-0001");
    await wait(400);
    expect(stored().rows.map(r => r.cooldownUntil)).toEqual([until + 60_000]);
    expect(existsSync(file(otherHome))).toBe(false);
  } finally {
    process.env.OPENCODEX_HOME = home;
    await first.release();
    removeTreeWithRetry(otherHome);
  }
});

test("a home whose lock is busy when another home takes over keeps its pending holds and writes them later", async () => {
  const cfg = config({ a: "sk-alpha-0001" });
  saveConfig(cfg);
  const first = acquireServerBackgroundLifecycle(() => {}, cfg);
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-busy-"));
  const blocker = new Database(join(home, "config-mutation.sqlite"));
  try {
    const until = Date.now() + 60_000;
    setKeyCooldown("p", "a", until, false, "sk-alpha-0001");
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    process.env.OPENCODEX_HOME = otherHome;
    const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
    blocker.exec("ROLLBACK");
    await waitUntil(() => existsSync(file()) && stored().rows.some(r => r.cooldownUntil === until), 9_000);
    await second.release();
    expect(getKeyCooldownUntil("p", "a")).toBe(until);
    // Written while another home is current: still registered under this home's ownership.
    expect(configPathOwnership(home, join(home, "config.json"))).toBe("listed");
    expect(configPathOwnership(home, file())).toBe("listed");
  } finally {
    blocker.close();
    process.env.OPENCODEX_HOME = home;
    await first.release();
    removeTreeWithRetry(otherHome);
  }
}, 15_000);

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await wait(100);
  }
}

test("a home rebound while its write is still blocked gets its pending hold back at once", async () => {
  const cfg = config({ a: "sk-alpha-0001" });
  saveConfig(cfg);
  const first = acquireServerBackgroundLifecycle(() => {}, cfg);
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-rebind-"));
  const blocker = new Database(join(home, "config-mutation.sqlite"));
  try {
    const until = Date.now() + 60_000;
    setKeyCooldown("p", "a", until, false, "sk-alpha-0001");
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    process.env.OPENCODEX_HOME = otherHome;
    const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
    expect(isKeyInCooldown("p", "a")).toBe(false);
    await second.release(); // the lock is still held: the hold is only pending
    expect(getKeyCooldownUntil("p", "a")).toBe(until);
    blocker.exec("ROLLBACK");
    await waitUntil(() => existsSync(file()) && stored().rows.some(r => r.cooldownUntil === until), 9_000);
    expect(getKeyCooldownUntil("p", "a")).toBe(until);
  } finally {
    blocker.close();
    process.env.OPENCODEX_HOME = home;
    await first.release();
    removeTreeWithRetry(otherHome);
  }
}, 15_000);

test("a detached home's late write never clears the current home's holds", async () => {
  const cfg = config({ a: "sk-alpha-0001" });
  saveConfig(cfg);
  const first = acquireServerBackgroundLifecycle(() => {}, cfg);
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-detached-"));
  const blocker = new Database(join(home, "config-mutation.sqlite"));
  try {
    setKeyCooldown("p", "a", Date.now() + 60_000, false, "sk-alpha-0001");
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    process.env.OPENCODEX_HOME = otherHome;
    const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
    const otherUntil = Date.now() + 120_000;
    setKeyCooldown("p", "a", otherUntil, false, "sk-alpha-0001"); // the current (other) home's hold
    // A peer process cleared provider p in the first home meanwhile.
    writeFileSync(file(home), JSON.stringify({ version: 1, rows: [], epochs: { p: 5 }, allEpoch: 0 }));
    blocker.exec("ROLLBACK");
    await waitUntil(() => JSON.parse(readFileSync(file(home), "utf8")).epochs?.p === 5 && stored().rows.length === 0, 9_000);
    await wait(4_500); // past the detached store's retry
    expect(getKeyCooldownUntil("p", "a")).toBe(otherUntil);
    await second.release();
  } finally {
    blocker.close();
    process.env.OPENCODEX_HOME = home;
    await first.release();
    removeTreeWithRetry(otherHome);
  }
}, 20_000);

for (const scope of ["provider", "global"] as const) {
  test(`a ${scope} clear made while the lock was busy still applies when the home is rebound`, async () => {
    const cfg = config({ a: "sk-alpha-0001" });
    saveConfig(cfg);
    const until = Date.now() + 60_000;
    writeRows([row("a", "sk-alpha-0001", until)]);
    const first = acquireServerBackgroundLifecycle(() => {}, cfg);
    const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-clear-"));
    const blocker = new Database(join(home, "config-mutation.sqlite"));
    try {
      expect(getKeyCooldownUntil("p", "a")).toBe(until);
      blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      if (scope === "provider") clearKeyCooldowns("p"); else clearKeyCooldowns();
      process.env.OPENCODEX_HOME = otherHome;
      const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
      await second.release(); // rebind while the clear is still unwritten
      expect(isKeyInCooldown("p", "a")).toBe(false);
      blocker.exec("ROLLBACK");
      await waitUntil(() => stored().rows.length === 0, 9_000);
      expect(isKeyInCooldown("p", "a")).toBe(false);
    } finally {
      blocker.close();
      process.env.OPENCODEX_HOME = home;
      await first.release();
      removeTreeWithRetry(otherHome);
    }
  }, 15_000);
}

test("a pending hold is restored on rebind even when the file cannot be read", async () => {
  const cfg = config({ a: "sk-alpha-0001" });
  saveConfig(cfg);
  const first = acquireServerBackgroundLifecycle(() => {}, cfg);
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-unreadable-"));
  const blocker = new Database(join(home, "config-mutation.sqlite"));
  try {
    const until = Date.now() + 60_000;
    setKeyCooldown("p", "a", until, false, "sk-alpha-0001");
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    process.env.OPENCODEX_HOME = otherHome;
    const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
    mkdirSync(file(home)); // the cooldown file path is now unreadable
    await second.release();
    expect(getKeyCooldownUntil("p", "a")).toBe(until);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    try { rmdirSync(file(home)); } catch { /* removed already */ }
    process.env.OPENCODEX_HOME = home;
    await first.release();
    removeTreeWithRetry(otherHome);
  }
}, 15_000);

for (const scope of ["provider", "global"] as const) {
  test(`a pending ${scope} clear hides a peer's row at the same counter on rebind`, async () => {
    const cfg = config({ a: "sk-alpha-0001" });
    saveConfig(cfg);
    const first = acquireServerBackgroundLifecycle(() => {}, cfg);
    const otherHome = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-collide-"));
    const blocker = new Database(join(home, "config-mutation.sqlite"));
    try {
      blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      // A peer cleared and then recorded a hold at counter 1, which this process has not read.
      const peerUntil = Date.now() + 600_000;
      writeFileSync(file(), JSON.stringify(scope === "provider"
        ? { version: 1, rows: [{ ...row("a", "sk-alpha-0001", peerUntil), epoch: 1 }], epochs: { p: 1 }, allEpoch: 0 }
        : { version: 1, rows: [{ ...row("a", "sk-alpha-0001", peerUntil), allEpoch: 1 }], epochs: {}, allEpoch: 1 }));
      if (scope === "provider") clearKeyCooldowns("p"); else clearKeyCooldowns(); // also reaches counter 1 locally
      process.env.OPENCODEX_HOME = otherHome;
      const second = acquireServerBackgroundLifecycle(() => {}, config({ a: "sk-alpha-0001" }));
      await second.release();
      expect(isKeyInCooldown("p", "a")).toBe(false);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
      process.env.OPENCODEX_HOME = home;
      await first.release();
      removeTreeWithRetry(otherHome);
    }
  }, 15_000);
}
