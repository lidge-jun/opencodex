import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { withLocalCredentialFixture } from "../helpers/local-credentials";

const accountStoreUrl = new URL("../../src/codex/account-store.ts", import.meta.url).href;
const inventoryUrl = new URL("../../src/local-credentials/inventory.ts", import.meta.url).href;
const generationUrl = new URL("../../src/local-credentials/generation.ts", import.meta.url).href;
const fixtureCredential = { accessToken: "fixture-a", refreshToken: "fixture-r", expiresAt: 1, chatgptAccountId: "fixture" };
function child(code: string): string {
  const result = spawnSync(process.execPath, ["-e", code], { env: { ...process.env }, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

test("add then remove returns zero with a different generation through the existing Codex store", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await f.inventory.collectLocalCredentials();
    const store = await import("../../src/codex/account-store");
    store.saveCodexAccountCredential("fixture", fixtureCredential);
    expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
    store.removeCodexAccountCredential("fixture");
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(0);
    expect(after?.generation).not.toBe(before?.generation);
  });
});
test("a provider key added and removed through central config persistence ends at zero with a new generation", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await f.inventory.collectLocalCredentials();
    const { getDefaultConfig, saveConfigPreservingClaudeCode } = await import("../../src/config");
    const config = getDefaultConfig();
    const provider = Object.values(config.providers)[0];
    if (!provider) throw new Error("Default config fixture requires a provider");
    provider.apiKey = "fixture-imported-key";
    saveConfigPreservingClaudeCode(config);
    expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
    delete provider.apiKey;
    saveConfigPreservingClaudeCode(config);
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(0);
    expect(after?.generation).not.toBe(before?.generation);
  });
});
test("a failed private key write remains counted until its compensating deletion is verified", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await f.inventory.collectLocalCredentials();
    const keys = await import("../../src/providers/api-key-resolve");
    let value: string | null = null;
    keys.setProviderKeychainEntryFactoryForTests(() => ({
      getPassword: () => value,
      setPassword: password => { value = password; throw new Error("fixture write failed after storing"); },
      deletePassword: () => { value = null; return true; },
    }));
    try {
      const entry = keys.providerKeychainEntry("fixture-provider/key");
      expect(() => entry.setPassword("fixture-secret")).toThrow("fixture write failed after storing");
      expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
      entry.deletePassword();
      const after = await f.inventory.collectLocalCredentials();
      expect(after?.count).toBe(0);
      expect(after?.generation).not.toBe(before?.generation);
    } finally { keys.setProviderKeychainEntryFactoryForTests(null); }
  });
});
test("another process add and remove invalidates the old generation even when final count is zero", async () => {
  await withLocalCredentialFixture(async f => {
    const owner = f.start();
    const before = await f.inventory.collectLocalCredentials();
    child(`const s = await import(${JSON.stringify(accountStoreUrl)}); s.saveCodexAccountCredential("fixture", ${JSON.stringify(fixtureCredential)}); s.removeCodexAccountCredential("fixture");`);
    owner.reconcile();
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(0);
    expect(after?.generation).not.toBe(before?.generation);
  });
});
test("separate status processes retain the stable token while the runtime observer stays alive", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const read = `const i = await import(${JSON.stringify(inventoryUrl)}); console.log(JSON.stringify(await i.collectLocalCredentials()));`;
    const one = JSON.parse(child(read)); const two = JSON.parse(child(read));
    expect(one.count).toBe(0);
    expect(two).toEqual(one);
  });
});
test("a dead observer cannot attest from surviving coordination metadata", async () => {
  await withLocalCredentialFixture(async f => {
    const previous = JSON.parse(child(`const i = await import(${JSON.stringify(inventoryUrl)}); i.startLocalCredentialObservation(); console.log(JSON.stringify(await i.collectLocalCredentials())); process.exit(0);`));
    expect(previous.count).toBe(0);
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    f.start();
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(0);
    expect(after?.generation).not.toBe(previous.generation);
  });
});
test("a pending crash publication withholds zero and explicit restart changes epoch", async () => {
  await withLocalCredentialFixture(async f => {
    const owner = f.start();
    const before = await f.inventory.collectLocalCredentials();
    child(`const g = await import(${JSON.stringify(generationUrl)}); await g.publishCredentialAsync(async () => { process.exit(0); });`);
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    owner.stop(); f.start();
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(0);
    expect(after?.generation).not.toBe(before?.generation);
  });
});
test("a compensated publication cannot reuse its earlier stable zero token", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await f.inventory.collectLocalCredentials();
    const path = join(f.codex, "auth.json");
    expect(() => f.publication.publishCredentialSync(() => {
      f.put(path, { OPENAI_API_KEY: "fixture" });
      unlinkSync(path);
      throw new Error("fixture publication rolled back");
    })).toThrow("fixture publication rolled back");
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(0);
    expect(after?.generation).not.toBe(before?.generation);
  });
});
test("external source changes and observer loss withhold attestation until explicit reconciliation", async () => {
  await withLocalCredentialFixture(async f => {
    const owner = f.start();
    const before = await f.inventory.collectLocalCredentials();
    f.put(join(f.codex, "auth.json"), { OPENAI_API_KEY: "fixture-external" });
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    owner.reconcile();
    const after = await f.inventory.collectLocalCredentials();
    expect(after?.count).toBe(1);
    expect(after?.generation).not.toBe(before?.generation);
    owner.stop();
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
  });
});

test("status never attests a snapshot that raced an OAuth publication, even while another process holds the config lock", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await f.inventory.collectLocalCredentials();
    expect(before?.count).toBe(0);
    // The config mutation lock held elsewhere once made the publication ticket silently disappear.
    const holder = Bun.spawn([process.execPath, "-e", `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(join(f.home, "config-mutation.sqlite"))}, { create: true }); db.exec("BEGIN IMMEDIATE"); console.log("held"); await Bun.stdin.text();`],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    try {
      const reader = holder.stdout.getReader();
      let seen = "";
      while (!seen.includes("held")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("config lock holder exited early");
        seen += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      const { saveCredential } = await import("../../src/oauth/store");
      let racing: ReturnType<typeof f.inventory.collectLocalCredentials> | undefined;
      // Start a status read in the middle of the publication, before the OAuth store is written.
      await f.publication.publishCredentialAsync(async () => {
        racing = f.inventory.collectLocalCredentials();
        await saveCredential("fixture-oauth", { access: "fixture-access", refresh: "fixture-refresh", expires: 1 });
      });
      const result = await racing;
      expect(result?.count).toBe(1);
      expect(result?.generation).not.toBe(before?.generation);
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
  });
});

for (const reference of ["keychain:openai", "gcp-sa:openai/fixture-sa"] as const) {
  for (const observedFirst of [true, false]) {
    test(`an upgraded ${reference.split(":")[0]} reference stays counted after its provider loses it and deletion fails (${observedFirst ? "observer running" : "removed before any observer"})`, async () => {
      await withLocalCredentialFixture(async f => {
        const { getDefaultConfig, saveConfigPreservingClaudeCode } = await import("../../src/config");
        const config = getDefaultConfig();
        const provider = config.providers.openai;
        if (!provider) throw new Error("Default config fixture requires the openai provider");
        provider.apiKey = reference;
        // Written before this release: no credential metadata knows the account yet.
        f.put(join(f.home, "config.json"), config);
        if (observedFirst) {
          f.start();
          expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
        }
        const keys = await import("../../src/providers/api-key-resolve");
        keys.setProviderKeychainEntryFactoryForTests(() => ({
          getPassword: () => "fixture-secret",
          setPassword: () => {},
          deletePassword: () => { throw new Error("fixture store refused deletion"); },
        }));
        try {
          delete provider.apiKey;
          saveConfigPreservingClaudeCode(config);
          const account = reference.slice(reference.indexOf(":") + 1);
          expect(() => keys.providerKeychainEntry(account).deletePassword()).toThrow("fixture store refused deletion");
          if (!observedFirst) f.start();
          const after = await f.inventory.collectLocalCredentials();
          expect(after?.count).toBeGreaterThanOrEqual(1);
        } finally { keys.setProviderKeychainEntryFactoryForTests(null); }
      });
    });
  }
}

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a publication whose ticket cannot be persisted aborts before it changes any credential bytes", async () => {
  await withLocalCredentialFixture(async f => {
    // Leave coordination metadata behind without a live watcher, then make it unreplaceable.
    f.start().stop();
    const metadata = join(f.home, "local-credentials.json");
    const before = readFileSync(metadata);
    const auth = join(f.codex, "auth.json");
    let wrote = false;
    chmodSync(f.home, 0o500);
    try {
      expect(() => f.publication.publishCredentialSync(() => {
        wrote = true;
        f.put(auth, { OPENAI_API_KEY: "fixture-transient" });
        unlinkSync(auth);
      })).toThrow();
    } finally { chmodSync(f.home, 0o700); }
    expect(wrote).toBe(false);
    expect(existsSync(auth)).toBe(false);
    expect(readFileSync(metadata).equals(before)).toBe(true);
  });
});

function memoryKeychain(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    factory: (_service: string, account: string) => ({
      getPassword: () => store.get(account) ?? null,
      setPassword: (value: string) => { store.set(account, value); },
      deletePassword: () => store.delete(account),
    }),
  };
}

test("restoring a keychain key to plaintext and then removing the plaintext returns the count to zero", async () => {
  await withLocalCredentialFixture(async f => {
    const keys = await import("../../src/providers/api-key-resolve");
    const { restoreProviderKeyFromKeychain } = await import("../../src/providers/key-store");
    const { getDefaultConfig, saveConfigPreservingClaudeCode } = await import("../../src/config");
    const keychain = memoryKeychain({ openai: "fixture-restored-secret" });
    keys.setProviderKeychainEntryFactoryForTests(keychain.factory);
    try {
      const config = getDefaultConfig();
      const provider = config.providers.openai;
      if (!provider) throw new Error("Default config fixture requires the openai provider");
      provider.apiKey = "keychain:openai";
      f.put(join(f.home, "config.json"), config);
      f.start();
      expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
      expect(restoreProviderKeyFromKeychain(config, "openai")).toEqual({ ok: true, restored: 1 });
      expect(keychain.store.size).toBe(0);
      expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
      delete provider.apiKey;
      saveConfigPreservingClaudeCode(config);
      expect((await f.inventory.collectLocalCredentials())?.count).toBe(0);
    } finally { keys.setProviderKeychainEntryFactoryForTests(null); }
  });
});

for (const observedFirst of [true, false]) {
  test(`a keychain secret deleted while its reference is still saved stops counting once the reference goes (${observedFirst ? "observer running" : "no observer yet"})`, async () => {
    await withLocalCredentialFixture(async f => {
      const keys = await import("../../src/providers/api-key-resolve");
      const { getDefaultConfig, saveConfigPreservingClaudeCode } = await import("../../src/config");
      const keychain = memoryKeychain({ openai: "fixture-secret" });
      keys.setProviderKeychainEntryFactoryForTests(keychain.factory);
      try {
        const config = getDefaultConfig();
        const provider = config.providers.openai;
        if (!provider) throw new Error("Default config fixture requires the openai provider");
        provider.apiKey = "keychain:openai";
        f.put(join(f.home, "config.json"), config);
        if (observedFirst) f.start();
        expect(keys.providerKeychainEntry("openai").deletePassword()).toBe(true);
        expect(keychain.store.size).toBe(0);
        // The saved reference still occupies a slot until it is removed.
        if (observedFirst) expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
        delete provider.apiKey;
        saveConfigPreservingClaudeCode(config);
        if (!observedFirst) f.start();
        expect((await f.inventory.collectLocalCredentials())?.count).toBe(0);
      } finally { keys.setProviderKeychainEntryFactoryForTests(null); }
    });
  });
}
