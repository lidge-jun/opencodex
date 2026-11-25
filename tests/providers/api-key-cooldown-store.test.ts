import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import {
  apiKeyCooldownGeneration,
  clearKeyCooldowns,
  getKeyCooldownUntil,
  isKeyInCooldown,
  reconcileApiKeyCooldownGenerations,
  setKeyCooldown,
  sweepExpiredApiKeyCooldowns,
} from "../../src/providers/api-key-cooldowns";
import {
  API_KEY_COOLDOWN_FILE,
  ApiKeyCooldownStore,
  installApiKeyCooldownPersistence,
  uninstallApiKeyCooldownPersistence,
  type ApiKeyCooldownRow,
} from "../../src/providers/api-key-cooldown-store";
import { rotateKeyOn429 } from "../../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previous: string | undefined;
const file = () => join(home, API_KEY_COOLDOWN_FILE);
const storedRows = () => (JSON.parse(readFileSync(file(), "utf8")) as { rows: ApiKeyCooldownRow[] }).rows;
const row = (keyId: string, key: string, cooldownUntil: number, provider = "p"): ApiKeyCooldownRow =>
  ({ provider, keyId, generation: apiKeyCooldownGeneration(provider, keyId, key), cooldownUntil });
const writeRows = (rows: ApiKeyCooldownRow[]) => writeFileSync(file(), JSON.stringify({ version: 1, rows }));

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
  sweepExpiredApiKeyCooldowns(Number.MAX_SAFE_INTEGER);
  return installApiKeyCooldownPersistence(cfg);
}

beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-key-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  clearKeyCooldowns();
});
afterEach(() => {
  uninstallApiKeyCooldownPersistence();
  clearKeyCooldowns();
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(home);
});

test("a key cooled before a restart stays cooled until its expiry", () => {
  const cfg = config({ a: "sk-alpha-0001", b: "sk-beta-0002" });
  const store = installApiKeyCooldownPersistence(cfg);
  const until = Date.now() + 60_000;
  setKeyCooldown("p", "a", until, "sk-alpha-0001");
  expect(store.flush()).toBe(true);
  expect(storedRows()).toEqual([row("a", "sk-alpha-0001", until)]);
  expect(JSON.stringify(storedRows())).not.toContain("sk-alpha");

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
  expect(storedRows()).toEqual([row("k1", "key-alpha-000111222333", now + 120_000)]);
});

test("expired and malformed rows are ignored at load", () => {
  const now = Date.now();
  writeRows([row("a", "sk-alpha-0001", now - 1_000), row("b", "sk-beta-0002", now + 60_000)]);
  installApiKeyCooldownPersistence(config({ a: "sk-alpha-0001", b: "sk-beta-0002" }));
  expect(isKeyInCooldown("p", "a")).toBe(false);
  expect(isKeyInCooldown("p", "b")).toBe(true);

  uninstallApiKeyCooldownPersistence();
  sweepExpiredApiKeyCooldowns(Number.MAX_SAFE_INTEGER);
  writeFileSync(file(), "{not json");
  installApiKeyCooldownPersistence(config({ a: "sk-alpha-0001", b: "sk-beta-0002" }));
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
  expect(storedRows()).toEqual([]);

  restart(cfg);
  expect(isKeyInCooldown("p", "a")).toBe(false);
});

test("a provider clear removes peer rows for that provider and keeps a later cooldown", () => {
  const now = Date.now();
  writeRows([row("a", "sk-a", now + 60_000), row("x", "sk-x", now + 60_000, "q")]);
  const store = new ApiKeyCooldownStore(home);
  store.clear("p");
  store.record(row("b", "sk-b", now + 30_000));
  expect(store.flush(now)).toBe(true);
  expect(storedRows().map(r => r.keyId).sort()).toEqual(["b", "x"]);
  store.clear();
  expect(store.flush(now)).toBe(true);
  expect(storedRows()).toEqual([]);
});

test("two processes sharing a home merge their rows and never shorten a peer's hold", () => {
  const now = Date.now();
  const first = new ApiKeyCooldownStore(home);
  const second = new ApiKeyCooldownStore(home);
  first.record(row("a", "sk-a", now + 60_000));
  expect(first.flush(now)).toBe(true);
  second.record(row("b", "sk-b", now + 60_000));
  second.record(row("a", "sk-a", now + 30_000));
  expect(second.flush(now)).toBe(true);
  const rows = storedRows().sort((x, y) => x.keyId.localeCompare(y.keyId));
  expect(rows).toEqual([row("a", "sk-a", now + 60_000), row("b", "sk-b", now + 60_000)]);

  // A newer key's row replaces the old key's row even when it expires sooner.
  first.record(row("a", "sk-a2", now + 10_000));
  expect(first.flush(now)).toBe(true);
  expect(storedRows().find(r => r.keyId === "a")).toEqual(row("a", "sk-a2", now + 10_000));
});

test("a store whose home was removed drops its pending rows", () => {
  const store = new ApiKeyCooldownStore(join(home, "gone"));
  store.record(row("a", "sk-a", Date.now() + 60_000));
  expect(store.flush()).toBe(true);
});
