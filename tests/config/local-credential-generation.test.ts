import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

async function generationOf(inventory: typeof import("../../src/local-credentials/inventory")): Promise<string | undefined> {
  return (await inventory.collectLocalCredentials())?.generation;
}
async function waitForNewGeneration(
  inventory: typeof import("../../src/local-credentials/inventory"),
  previous: string | undefined,
  timeoutMs = 4000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let next: string | undefined;
  do {
    next = await generationOf(inventory);
    if (next !== undefined && next !== previous) return next;
    if (Date.now() >= deadline) return next;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (true);
}
async function expectStableGeneration(
  inventory: typeof import("../../src/local-credentials/inventory"),
  previous: string | undefined,
  windowMs = 1500,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(await generationOf(inventory)).toBe(previous);
  }
}

// Waits until the generation stays constant over one quiet window, tolerating
// residual notifications from the mutation that produced it. Throws rather than
// return an unsettled token, so a caller can never start the ABA on a baseline
// that was still racing events.
async function settleGeneration(
  inventory: typeof import("../../src/local-credentials/inventory"),
  quietMs = 500,
  timeoutMs = 4000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last = await generationOf(inventory);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const next = await generationOf(inventory);
    if (next !== last) { last = next; quietSince = Date.now(); continue; }
    if (Date.now() - quietSince >= quietMs) return last;
  }
  throw new Error("credential generation never settled: notifications still arriving at timeout");
}

test("the watch seam classifies direct, ancestor, identity, and failure cases deterministically", async () => {
  const inventory = await import("../../src/local-credentials/inventory");
  const dir = mkdtempSync(join(tmpdir(), "ocx-watch-seam-"));
  try {
    const ancestor = join(dir, "ancestor");
    const direct = join(dir, "direct");
    const foreign = join(dir, "foreign");
    mkdirSync(ancestor); mkdirSync(direct); mkdirSync(foreign);
    const shortLooking = join(dir, "ocx~1");
    mkdirSync(shortLooking);
    const residueLooking = join(dir, "config.json.ocx.home");
    mkdirSync(residueLooking);
    writeFileSync(join(dir, "auth.json"), "{}");
    const same = lstatSync(ancestor, { bigint: true });
    const shortSame = lstatSync(shortLooking, { bigint: true });
    const residueSame = lstatSync(residueLooking, { bigint: true });
    const entry = {
      names: new Set(["auth.json", "direct"]),
      ancestors: new Map<string, { dev: bigint; ino: bigint } | null>([
        ["ancestor", { dev: same.dev, ino: same.ino }],
        ["ocx~1", { dev: shortSame.dev, ino: shortSame.ino }],
        ["config.json.ocx.home", { dev: residueSame.dev, ino: residueSame.ino }],
        ["unverifiable", null],
      ]),
    };
    const action = (event: string, name: string | null) =>
      inventory.credentialWatchEventAction(dir, entry, event, name);

    // A same-identity ancestor reporting only a last-write tick is ordinary child
    // churn, however often it repeats: no reconcile, no save, no re-arm.
    expect(action("change", "ancestor")).toBe("ignore");
    expect(action("change", "ancestor")).toBe("ignore");
    // A rename is structural even when the entry re-identifies the same afterwards.
    expect(action("rename", "ancestor")).toBe("reconcile");
    // Direct names reconcile on any event, including a plain content change.
    expect(action("change", "auth.json")).toBe("reconcile");
    expect(action("rename", "auth.json")).toBe("reconcile");
    expect(action("change", "direct")).toBe("reconcile");
    // A name carrying both roles stays direct: direct wins over ancestor.
    const overlapping = { names: new Set(["ancestor"]), ancestors: entry.ancestors };
    expect(inventory.credentialWatchEventAction(dir, overlapping, "change", "ancestor")).toBe("reconcile");
    // Credential-write residue is always coverage-relevant.
    expect(action("change", "config.json.ocx.7.tmp")).toBe("reconcile");
    // An ancestor that could not be identified at install reconciles on any event.
    expect(action("change", "unverifiable")).toBe("reconcile");
    expect(action("rename", "unverifiable")).toBe("reconcile");
    // Unrelated names never reconcile.
    expect(action("change", "foreign")).toBe("ignore");
    expect(action("rename", "unknown.tmp")).toBe("ignore");
    // A case-insensitive volume reports the writer's spelling: a differently cased or
    // trailing-dot spelling of a target or its write residue must still reconcile rather
    // than fall through as an unrelated name.
    expect(action("rename", "AUTH.JSON")).toBe("reconcile");
    expect(action("change", "Auth.Json")).toBe("reconcile");
    expect(action("change", "auth.json.")).toBe("reconcile");
    expect(action("rename", "Direct")).toBe("reconcile");
    expect(action("rename", "CONFIG.JSON.OCX.7.tmp")).toBe("reconcile");
    // An entry without recorded target identities cannot resolve a short name: reconcile.
    expect(action("rename", "AUTH~1.JSO")).toBe("reconcile");
    // A real ancestor whose name only looks like a short name (OPENCODEX_HOME=C:\ocx~1) is
    // identity-checked like any other ancestor, so its own-save tick cannot re-arm the loop.
    expect(action("change", "ocx~1")).toBe("ignore");
    expect(action("rename", "ocx~1")).toBe("reconcile");
    expect(action("change", "config.json.ocx.home")).toBe("ignore");
    expect(action("rename", "config.json.ocx.home")).toBe("reconcile");
    // A differently cased ancestor is still an ancestor: renames reconcile, and a change is
    // ignored only when that spelling resolves to the recorded directory itself.
    expect(action("rename", "ANCESTOR")).toBe("reconcile");
    const upper = (() => { try { return lstatSync(join(dir, "ANCESTOR"), { bigint: true }); } catch { return null; } })();
    const sameDir = upper !== null && upper.dev === same.dev && upper.ino === same.ino;
    expect(action("change", "ANCESTOR")).toBe(sameDir ? "ignore" : "reconcile");
    // A different real directory at the same name: the original is kept aside so
    // its inode stays allocated and the replacement provably has a new identity.
    renameSync(ancestor, join(dir, "ancestor-aside"));
    mkdirSync(ancestor);
    expect(action("change", "ancestor")).toBe("reconcile");
    // Missing, and replaced by a link, cannot prove the tick is noise either.
    rmSync(ancestor, { recursive: true, force: true });
    expect(action("change", "ancestor")).toBe("reconcile");
    symlinkSync(foreign, ancestor, "junction");
    expect(action("change", "ancestor")).toBe("reconcile");
    unlinkSync(ancestor);
    rmSync(join(dir, "ancestor-aside"), { recursive: true, force: true });
    // A watcher overflow reports a null name and must fail closed.
    expect(action("change", null)).toBe("fail");
    expect(action("rename", null)).toBe("fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unmatched 8.3 short names resolve by identity against the install snapshot", async () => {
  const inventory = await import("../../src/local-credentials/inventory");
  const dir = mkdtempSync(join(tmpdir(), "ocx-watch-short-"));
  try {
    // Literal tilde names stand in for the short spellings Windows may report for files.
    mkdirSync(join(dir, "longancestor"));
    writeFileSync(join(dir, "auth.json"), "{}");
    writeFileSync(join(dir, "localc~1.jso"), "{}");
    const ancestorStat = lstatSync(join(dir, "longancestor"), { bigint: true });
    const entry = {
      names: new Set(["auth.json", "config.json"]),
      ancestors: new Map<string, { dev: bigint; ino: bigint } | null>([
        ["longancestor", { dev: ancestorStat.dev, ino: ancestorStat.ino }],
      ]),
      targetIdentities: new Map([
        ["auth.json", inventory.watchEntryIdentity(dir, "auth.json")],
        ["config.json", inventory.watchEntryIdentity(dir, "config.json")],
      ]),
    };
    expect(entry.targetIdentities.get("config.json")).toBe("absent");
    const action = (event: string, name: string) => inventory.credentialWatchEventAction(dir, entry, event, name);
    // The observer's own metadata save under a short spelling, live or already renamed
    // away, changed no target or ancestor, so it must not re-arm the reconcile.
    expect(action("change", "localc~1.jso")).toBe("ignore");
    expect(action("rename", "localc~2.tmp")).toBe("ignore");
    // A short alias of a tracked ancestor: its change is that ancestor's tick, a rename is
    // structural. Whether LONGAN~1 resolves depends on the volume's 8.3 setting; either way
    // the change cannot re-arm the loop.
    const alias = (() => { try { return lstatSync(join(dir, "LONGAN~1"), { bigint: true }); } catch { return null; } })();
    const resolvesToAncestor = alias !== null && alias.dev === ancestorStat.dev && alias.ino === ancestorStat.ino;
    expect(action("change", "LONGAN~1")).toBe("ignore");
    expect(action("rename", "LONGAN~1")).toBe(resolvesToAncestor ? "reconcile" : "ignore");
    // A short alias that resolves to a target is that target.
    linkSync(join(dir, "auth.json"), join(dir, "authjs~1.jso"));
    expect(action("change", "authjs~1.jso")).toBe("reconcile");
    unlinkSync(join(dir, "authjs~1.jso"));
    // A removed or newly created target makes any unresolvable short name relevant.
    writeFileSync(join(dir, "config.json"), "{}");
    expect(action("rename", "config~1.jso")).toBe("reconcile");
    unlinkSync(join(dir, "config.json"));
    expect(action("rename", "config~1.jso")).toBe("ignore");
    unlinkSync(join(dir, "auth.json"));
    expect(action("rename", "auth~1.jso")).toBe("reconcile");
    // A replaced ancestor does too.
    writeFileSync(join(dir, "auth.json"), "{}");
    entry.targetIdentities.set("auth.json", inventory.watchEntryIdentity(dir, "auth.json"));
    expect(action("rename", "other~1")).toBe("ignore");
    renameSync(join(dir, "longancestor"), join(dir, "aside"));
    expect(action("change", "LONGAN~1")).toBe("reconcile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary churn inside a watched ancestor does not re-arm the observer or advance the generation", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await generationOf(f.inventory);
    expect(before).toBeDefined();
    // Writes like runtime-port.json, journals, and this observer's own save tick the
    // ancestor's last-write time on Windows; that tick must not re-arm a reconcile.
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(join(f.home, `runtime-${i}.json`), "{}");
      if (i % 2 === 1) unlinkSync(join(f.home, `runtime-${i - 1}.json`));
    }
    await expectStableGeneration(f.inventory, before);
    // Suppression must not deafen the observer: a real target write still reconciles.
    f.put(join(f.home, "config.json"), { model: "fixture" });
    const revived = await waitForNewGeneration(f.inventory, before);
    expect(revived).toBeDefined();
    expect(revived).not.toBe(before);
  });
});

test("a same-identity rename of a watched ancestor still advances the generation", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await generationOf(f.inventory);
    expect(before).toBeDefined();
    const moved = `${f.codex}-moved`;
    renameSync(f.codex, moved);
    renameSync(moved, f.codex);
    const after = await waitForNewGeneration(f.inventory, before);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

test("a direct target replacing itself with identical bytes still advances the generation", async () => {
  await withLocalCredentialFixture(async f => {
    f.start();
    const before = await generationOf(f.inventory);
    expect(before).toBeDefined();
    const auth = join(f.codex, "auth.json");
    const shadow = join(f.codex, "auth-shadow.tmp");
    f.put(auth, { OPENAI_API_KEY: "fixture-native-key" });
    const writeObserved = await waitForNewGeneration(f.inventory, before);
    expect(writeObserved).toBeDefined();
    const settled = await settleGeneration(f.inventory);
    expect(settled).toBeDefined();
    // Rebind the directory entry to the same inode: the bytes stay identical, so
    // only the observed event itself -- never content -- may advance coverage.
    linkSync(auth, shadow);
    unlinkSync(auth);
    renameSync(shadow, auth);
    const after = await waitForNewGeneration(f.inventory, settled);
    expect(after).toBeDefined();
    expect(after).not.toBe(settled);
    expect(readFileSync(auth, "utf8")).toBe(JSON.stringify({ OPENAI_API_KEY: "fixture-native-key" }));
  });
});

test("an unknown entry in the shared native-profile vault still reaches the observer", async () => {
  await withLocalCredentialFixture(async f => {
    const shared = join(f.codex, ".opencodex-native-main-profiles");
    // The vault listing itself is verified, so the directory must be a direct watch
    // target; otherwise an unknown create/delete pair hides behind an ancestor tick.
    expect(f.inventory.scanLocalCredentials().targets).toContain(shared);
    f.start();
    const before = await generationOf(f.inventory);
    expect(before).toBeDefined();
    mkdirSync(shared);
    const created = await waitForNewGeneration(f.inventory, before);
    expect(created).toBeDefined();
    // Let residual notifications from the mkdir drain: the ABA below must be
    // measured against a settled token, not one still racing earlier events.
    const settled = await settleGeneration(f.inventory);
    expect(settled).toBeDefined();
    const vectorBefore = f.inventory.scanLocalCredentials().vector;
    const unknown = join(shared, "unknown.json");
    writeFileSync(unknown, "{}");
    // Coverage fails closed while the entry is present: no attestation for an
    // unverifiable vault listing.
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    unlinkSync(unknown);
    // The ABA pair leaves the vault listing -- and therefore the scan vector --
    // exactly as it was, so any advance can only come from observed events.
    expect(f.inventory.scanLocalCredentials().vector).toBe(vectorBefore);
    if (process.platform === "win32") {
      // On Windows the pair ticks the vault's parent and is itself observed, so
      // the previous token cannot be reused. Platforms that report no event for
      // this pair cannot force the advance, so this is a win32-only check, not a
      // platform-common verification.
      const after = await waitForNewGeneration(f.inventory, settled);
      expect(after).toBeDefined();
      expect(after).not.toBe(settled);
    } else {
      expect(await generationOf(f.inventory)).toBeDefined();
    }
  });
});
