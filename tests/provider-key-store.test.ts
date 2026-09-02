import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { maskApiKey } from "../src/providers/api-keys";
import {
  PROVIDER_KEYCHAIN_SERVICE,
  probeProviderKeychain,
  providerKeyStoreKind,
  resolveProviderApiKey,
  restoreProviderKeyFromKeychain,
  setProviderKeychainEntryFactoryForTests,
  storeProviderKeyInKeychain,
  type ProviderKeychainEntry,
} from "../src/providers/key-store";
import { routedProviderConfig } from "../src/router";
import { managementFetch as fetch } from "./helpers/management-auth";
import { startServer } from "../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/** In-memory keychain: service/account → secret, with optional fault injection. */
function fakeKeychain(options: { unavailable?: boolean; readBackMismatch?: boolean } = {}) {
  const store = new Map<string, string>();
  const factory = (service: string, account: string): ProviderKeychainEntry => {
    if (options.unavailable) throw new Error("Secret Service not reachable");
    const key = `${service}\u0000${account}`;
    return {
      getPassword: () => (options.readBackMismatch ? "different" : store.get(key) ?? null),
      setPassword: value => { store.set(key, value); },
      deletePassword: () => store.delete(key),
    };
  };
  return { store, factory };
}

let testDir = "";
let previousHome: string | undefined;
let isolated: IsolatedCodexHome | null = null;
const SECRET = "plain-key-material-first-entry";
const POOL_SECRET = "plain-key-material-second-entry";

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "relay",
    providers: {
      relay: { adapter: "openai-chat", baseUrl: "https://relay.example/v1", apiKey: SECRET },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolated = installIsolatedCodexHome("ocx-keychain-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-keychain-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  setProviderKeychainEntryFactoryForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolated?.restore();
  isolated = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("provider key resolver (#1221)", () => {
  test("plain and env values resolve exactly as before", () => {
    process.env.OCX_TEST_KEY_REF = "from-env";
    try {
      expect(resolveProviderApiKey(SECRET)).toBe(SECRET);
      expect(resolveProviderApiKey("${OCX_TEST_KEY_REF}")).toBe("from-env");
      expect(resolveProviderApiKey(undefined)).toBeUndefined();
    } finally {
      delete process.env.OCX_TEST_KEY_REF;
    }
  });

  test("keychain references resolve through the OS entry and fail closed when unreadable", () => {
    const { store, factory } = fakeKeychain();
    store.set(`${PROVIDER_KEYCHAIN_SERVICE}\u0000relay`, SECRET);
    setProviderKeychainEntryFactoryForTests(factory);
    expect(resolveProviderApiKey("keychain:relay")).toBe(SECRET);
    // routing clone carries the resolved secret so adapters keep working unchanged
    expect(routedProviderConfig("relay", { adapter: "openai-chat", baseUrl: "https://relay.example/v1", apiKey: "keychain:relay" }).apiKey).toBe(SECRET);

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      setProviderKeychainEntryFactoryForTests(fakeKeychain({ unavailable: true }).factory);
      expect(resolveProviderApiKey("keychain:relay")).toBeUndefined();
      expect(resolveProviderApiKey("keychain:relay")).toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no plaintext fallback");
    expect(warnings[0]).not.toContain(SECRET);
  });

  test("references are non-secret for masking and store-kind reporting", () => {
    expect(maskApiKey("keychain:relay")).toBe("keychain:relay");
    expect(providerKeyStoreKind({ apiKey: "keychain:relay" })).toBe("keychain");
    expect(providerKeyStoreKind({ apiKey: "${X}" })).toBe("env");
    expect(providerKeyStoreKind({ apiKey: SECRET })).toBe("file");
    expect(providerKeyStoreKind({})).toBe("none");
  });
});

describe("store / restore", () => {
  test("store moves the active key and pool into the keychain, config keeps references only", () => {
    const { store, factory } = fakeKeychain();
    setProviderKeychainEntryFactoryForTests(factory);
    const config = loadConfig();
    config.providers.relay!.apiKeyPool = [
      { id: "a1", key: SECRET },
      { id: "b2", key: POOL_SECRET },
    ];
    const result = storeProviderKeyInKeychain(config, "relay");
    expect(result).toEqual({ ok: true, moved: 2 });
    expect(config.providers.relay!.apiKey).toBe("keychain:relay/a1");
    expect(config.providers.relay!.apiKeyPool!.map(e => e.key)).toEqual(["keychain:relay/a1", "keychain:relay/b2"]);
    const onDisk = readFileSync(join(testDir, "config.json"), "utf8");
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain(POOL_SECRET);
    expect(onDisk).toContain("keychain:relay/a1");
    expect(store.size).toBe(2);
    // resolves back to the plaintext at request time
    expect(resolveProviderApiKey(config.providers.relay!.apiKey)).toBe(SECRET);

    const restored = restoreProviderKeyFromKeychain(config, "relay");
    expect(restored).toEqual({ ok: true, restored: 2 });
    expect(config.providers.relay!.apiKey).toBe(SECRET);
    expect(config.providers.relay!.apiKeyPool!.map(e => e.key)).toEqual([SECRET, POOL_SECRET]);
    expect(store.size).toBe(0);
  });

  test("store refuses and leaves config untouched when the keychain is unavailable or lies", () => {
    for (const faulty of [fakeKeychain({ unavailable: true }), fakeKeychain({ readBackMismatch: true })]) {
      setProviderKeychainEntryFactoryForTests(faulty.factory);
      const config = loadConfig();
      const result = storeProviderKeyInKeychain(config, "relay");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(503);
      expect(config.providers.relay!.apiKey).toBe(SECRET);
      expect(readFileSync(join(testDir, "config.json"), "utf8")).toContain(SECRET);
      expect(faulty.store.size).toBe(0);
    }
    expect(probeProviderKeychain().available).toBe(false);
  });

  test("management route: GET reports store kind, POST store/restore round-trips", async () => {
    const { factory } = fakeKeychain();
    setProviderKeychainEntryFactoryForTests(factory);
    const server = startServer(0);
    try {
      const before = await fetch(new URL("/api/providers/keychain?name=relay", server.url)).then(r => r.json()) as Record<string, unknown>;
      expect(before).toMatchObject({ name: "relay", store: "file", keychainAvailable: true });

      const stored = await fetch(new URL("/api/providers/keychain", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "relay", action: "store" }),
      });
      expect(stored.status).toBe(200);
      expect(await stored.json()).toMatchObject({ ok: true, store: "keychain", moved: 1 });
      expect(readFileSync(join(testDir, "config.json"), "utf8")).not.toContain(SECRET);

      const list = await fetch(new URL("/api/providers/keys?name=relay", server.url)).then(r => r.json()) as { keys: Array<{ masked: string }> };
      expect(list.keys[0]!.masked).toBe("keychain:relay");

      const bad = await fetch(new URL("/api/providers/keychain", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "relay", action: "explode" }),
      });
      expect(bad.status).toBe(400);

      const restored = await fetch(new URL("/api/providers/keychain", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "relay", action: "restore" }),
      });
      expect(restored.status).toBe(200);
      expect(readFileSync(join(testDir, "config.json"), "utf8")).toContain(SECRET);
    } finally {
      await server.stop(true);
    }
  });
});

