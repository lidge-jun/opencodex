import { expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLocalCredentialFixture } from "../helpers/local-credentials";

const credential = { access: "fixture-access", refresh: "fixture-refresh", expires: 1 };

test("a link-only Child has zero local provider credentials without consulting Home", async () => {
  await withLocalCredentialFixture(async f => {
    f.put(join(f.home, "config.json"), { providers: {}, runtimeRole: "client", client: { apiKey: "fixture-link-only" }, apiKeys: ["fixture-incoming"] });
    f.start();
    const result = await f.inventory.collectLocalCredentials();
    expect(result?.count).toBe(0);
    expect(result?.generation).toMatch(/^lc1:[a-f0-9-]{36}:\d+$/);
  });
});
test("counts inactive OAuth accounts and retained legacy credentials without dropping malformed siblings", async () => {
  await withLocalCredentialFixture(async f => {
    const path = join(f.home, "auth.json");
    f.put(path, { p: { activeAccountId: "a", accounts: [
      { id: "a", credential }, { id: "b", credential, paused: true, needsReauth: true },
    ] } });
    f.put(path + ".pre-multiauth", { q: credential });
    const owner = f.start();
    expect((await f.inventory.collectLocalCredentials())?.count).toBe(3);
    f.put(path, { good: credential, rejected: { accounts: [{ id: "bad" }] } });
    owner.reconcile();
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
  });
});
test("counts disabled API keys and private references without counting an active mirror twice", async () => {
  await withLocalCredentialFixture(async f => {
    f.put(join(f.home, "config.json"), { providers: { p: {
      apiKey: "fixture-a", apiKeyPool: [
        { id: "a", key: "fixture-a" }, { id: "b", key: "keychain:p/b", disabled: true },
        { id: "c", key: "${FIXTURE_UNSET}" }, { id: "d", key: "gcp-sa:p/d" },
      ],
    } } });
    f.start();
    const keys = await import("../../src/providers/api-key-resolve");
    keys.setProviderKeychainEntryFactoryForTests(() => { throw new Error("Passive inventory attempted keychain access"); });
    try { expect((await f.inventory.collectLocalCredentials())?.count).toBe(4); }
    finally { keys.setProviderKeychainEntryFactoryForTests(null); }
  });
});
test("counts Codex pool API-key main auth and inactive native envelopes without decrypting the vault", async () => {
  await withLocalCredentialFixture(async f => {
    f.put(join(f.home, "codex-accounts.json"), {
      a: { accessToken: "fixture-a", refreshToken: "fixture-r", expiresAt: 1, chatgptAccountId: "fixture-id" },
      removed: { generation: 1, deletedAt: 1 },
    });
    f.put(join(f.codex, "auth.json"), { OPENAI_API_KEY: "fixture-native-key" });
    const { nativeProfileHomeId } = await import("../../src/codex/native-profile-store");
    const homeId = nativeProfileHomeId(f.codex);
    const dir = join(f.codex, ".opencodex-native-main-profiles");
    mkdirSync(dir);
    const active = randomUUID(); const inactive = randomUUID();
    const profile = (id: string, state: string, hash: string, payload: unknown) => ({
      id, label: id, state, identityHash: hash, identityHint: `account-${hash.slice(0, 8)}`,
      createdAt: "fixture", updatedAt: "fixture", payload,
    });
    f.put(join(dir, `${homeId}.vault.json`), { version: 1, homeId, revision: 1, activeProfileId: active, profiles: [
      profile(active, "active", "a".repeat(64), null),
      profile(inactive, "inactive", "b".repeat(64), {
        cipher: "aes-256-gcm", keyRef: "fixture", nonce: "fixture", ciphertext: "fixture", tag: "fixture", envelopeSha256: "c".repeat(64),
      }),
    ] });
    f.start();
    expect((await f.inventory.collectLocalCredentials())?.count).toBe(3);
  });
});
test("omits attestation for unsupported native stores and malformed bytes", async () => {
  await withLocalCredentialFixture(async f => {
    const owner = f.start();
    const path = join(f.codex, "config.toml");
    for (const mode of ["auto", "keyring", "ephemeral"]) {
      writeFileSync(path, `cli_auth_credentials_store = "${mode}"\n`);
      owner.reconcile();
      expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    }
    writeFileSync(path, 'cli_auth_credentials_store = "file"\n');
    writeFileSync(join(f.home, "auth.json"), Buffer.from([0xff]));
    owner.reconcile();
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
  });
});
test("a passive snapshot does not rewrite stores refresh credentials or call the network", async () => {
  await withLocalCredentialFixture(async f => {
    const path = join(f.home, "auth.json");
    f.put(path, { p: credential });
    f.start();
    const before = readFileSync(path); const stat = statSync(path);
    using fetch = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Passive inventory attempted network"); });
    expect((await f.inventory.collectLocalCredentials())?.count).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(stat.mtimeMs);
    expect(statSync(path).mode).toBe(stat.mode);
    expect(fetch).not.toHaveBeenCalled();
  });
});

test("the runtime observer both runtimes share attests while it serves and withdraws when it stops", async () => {
  await withLocalCredentialFixture(async f => {
    f.put(join(f.home, "config.json"), { providers: {}, runtimeRole: "client", client: { apiKey: "fixture-link-only" } });
    const { observeLocalCredentials, withLocalCredentialObservation } = await import("../../src/local-credentials/runtime-observation");
    const observation = observeLocalCredentials();
    const attested = await f.inventory.collectLocalCredentials();
    expect(attested?.count).toBe(0);
    expect(attested?.generation).toMatch(/^lc1:/);
    observation.stop();
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    let stopped = 0;
    const server = withLocalCredentialObservation(() => ({ async stop() { stopped += 1; } }));
    expect((await f.inventory.collectLocalCredentials())?.count).toBe(0);
    await server.stop();
    expect(stopped).toBe(1);
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
    expect(() => withLocalCredentialObservation(() => { throw new Error("fixture bind failed"); })).toThrow("fixture bind failed");
    expect(await f.inventory.collectLocalCredentials()).toBeUndefined();
  });
});
