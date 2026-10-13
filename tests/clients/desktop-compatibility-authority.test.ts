import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDesktopCompatibilityAuthority, inspectDesktopCompatibilityAuthority, loadDesktopCompatibilityAuthority, renewDesktopCompatibilityAuthority } from "../../src/codex/desktop-compatibility/certificate-store";
import { windowsAuthorityKeyProtection, type AuthorityKeyProtection } from "../../src/codex/desktop-compatibility/windows-key-protection";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";

const roots: string[] = [];
const success = () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" });
// These temporary-store cases exercise publication semantics, not the separate ACL implementation.
setIcaclsRunnerForTests(success);
setAsyncIcaclsRunnerForTests(async () => success());
afterAll(() => {
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null);
  for (const root of roots) rmSync(root, { recursive: true });
});
const directory = () => { const root = mkdtempSync(join(tmpdir(), "ocx-compat-authority-")); roots.push(root); return root; };
function protector(): AuthorityKeyProtection {
  const key = randomBytes(32);
  return {
    async protect(cleartext) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(cleartext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async unprotect(ciphertext) {
      const data = Buffer.from(ciphertext), cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
    },
  };
}

describe("Codex Desktop compatibility authority lifecycle", () => {
  test("legacy-purpose authority stays removable but must be deliberately renewed before reuse", async () => {
    const root = directory(), protection = protector(), commonName = `OpenCodex Codex Desktop ${randomUUID()}`;
    const legacy = createCertificateAuthority({ commonName, validityDays: 30, permittedDnsNames: ["chatgpt.com"] });
    expect(new X509Certificate(legacy.certPem).keyUsage).toBeUndefined();
    const clear = Buffer.from(JSON.stringify({ policy: "codex-desktop-chatgpt-only/v1", commonName,
      certSha256: createHash("sha256").update(legacy.certPem).digest("hex"), keyPem: legacy.keyPem }));
    const path = join(root, "authority.json");
    writeFileSync(path, JSON.stringify({ version: 1, protection: "windows-current-user-dpapi", certPem: legacy.certPem,
      sealed: Buffer.from(await protection.protect(clear)).toString("base64") })); clear.fill(0);
    const before = readFileSync(path, "utf8");
    expect(inspectDesktopCompatibilityAuthority(root).status).toBe("renewal-required");
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection })).rejects.toMatchObject({ code: "renewal_required" });
    await expect(loadDesktopCompatibilityAuthority({ directory: root, protection })).rejects.toMatchObject({ code: "renewal_required" });
    const removable = await loadDesktopCompatibilityAuthority({ directory: root, protection }, true);
    expect(readFileSync(path, "utf8")).toBe(before);
    const renewed = await renewDesktopCompatibilityAuthority({ directory: root, protection }, removable.fingerprint);
    expect(renewed.fingerprint).not.toBe(removable.fingerprint);
    expect(new X509Certificate(renewed.authority.certPem).keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(inspectDesktopCompatibilityAuthority(root).status).toBe("present");
  });

  test("deliberate renewal replaces one encrypted identity and refuses a stale fingerprint", async () => {
    const root = directory(), protection = protector();
    const first = await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    const second = await renewDesktopCompatibilityAuthority({ directory: root, protection }, first.fingerprint);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.reused).toBe(false);
    expect((await ensureDesktopCompatibilityAuthority({ directory: root, protection })).fingerprint).toBe(second.fingerprint);
    const contents = readFileSync(join(root, "authority.json"), "utf8");
    await expect(renewDesktopCompatibilityAuthority({ directory: root, protection }, first.fingerprint)).rejects.toMatchObject({ code: "fingerprint_changed" });
    expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(contents);
    expect(readdirSync(root).filter(name => /authority.*\.(json|tmp)$/.test(name))).toEqual(["authority.json"]);
  });

  test("failed renewal preserves the old removable envelope and cleans unpublished staging", async () => {
    const root = directory(), protection = protector();
    const first = await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    const original = readFileSync(join(root, "authority.json"), "utf8");
    const broken = { ...protection, protect: async () => Buffer.from("unreadable replacement") };
    await expect(renewDesktopCompatibilityAuthority({ directory: root, protection: broken }, first.fingerprint)).rejects.toMatchObject({ code: "unreadable" });
    expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(original);
    expect((await loadDesktopCompatibilityAuthority({ directory: root, protection }, true)).fingerprint).toBe(first.fingerprint);
    expect(readdirSync(root).some(name => name.endsWith(".tmp"))).toBe(false);
  });

  test("public status neither creates missing state nor repairs a malformed envelope", async () => {
    const root = directory(), absent = join(root, "not-created");
    expect(inspectDesktopCompatibilityAuthority(absent)).toEqual({ status: "missing" }); expect(existsSync(absent)).toBe(false);
    const prepared = await ensureDesktopCompatibilityAuthority({ directory: root, protection: protector() });
    const path = join(root, "authority.json"), original = readFileSync(path, "utf8");
    expect(inspectDesktopCompatibilityAuthority(root)).toMatchObject({ status: "present", fingerprint: prepared.fingerprint });
    expect(readFileSync(path, "utf8")).toBe(original);
    const malformed = JSON.parse(original); delete malformed.sealed; writeFileSync(path, JSON.stringify(malformed));
    const before = readFileSync(path, "utf8"); expect(inspectDesktopCompatibilityAuthority(root)).toEqual({ status: "invalid" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an expired key can be loaded for exact trust removal without minting a replacement", async () => {
    const root = directory(), protection = protector();
    const prepared = await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    const options = { directory: root, protection, now: () => prepared.expiresAt + 1 };
    await expect(loadDesktopCompatibilityAuthority(options)).rejects.toMatchObject({ code: "expired" });
    const loaded = await loadDesktopCompatibilityAuthority(options, true);
    expect(loaded.fingerprint).toBe(prepared.fingerprint); expect(loaded.authority.keyPem).toBe(prepared.authority.keyPem);
  });

  test("reuses the exact certificate and key after reopening; disk never contains the private PEM", async () => {
    const root = directory(), protection = protector();
    const first = await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    const contents = readFileSync(join(root, "authority.json"), "utf8");
    expect(contents).not.toContain("PRIVATE KEY");
    expect(contents).not.toContain(first.authority.keyPem);
    const second = await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    expect(first.reused).toBe(false); expect(second.reused).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.authority.keyPem).toBe(first.authority.keyPem);
    expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(contents);
  });

  test("a foreign user or corrupt protected key refuses without replacing the trusted identity", async () => {
    const root = directory(), protection = protector();
    await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    const path = join(root, "authority.json"), original = readFileSync(path, "utf8");
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection: protector() }))
      .rejects.toMatchObject({ code: "unreadable" });
    expect(readFileSync(path, "utf8")).toBe(original);
    const saved = JSON.parse(original); saved.sealed = "invalid-ciphertext"; writeFileSync(path, JSON.stringify(saved));
    const corrupted = readFileSync(path, "utf8");
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection })).rejects.toMatchObject({ code: "unreadable" });
    expect(readFileSync(path, "utf8")).toBe(corrupted);
  });

  test("swapping only the public certificate cannot reuse an unrelated protected key", async () => {
    const protection = protector(), root = directory(), foreign = directory();
    await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    await ensureDesktopCompatibilityAuthority({ directory: foreign, protection });
    const path = join(root, "authority.json"), saved = JSON.parse(readFileSync(path, "utf8"));
    saved.certPem = JSON.parse(readFileSync(join(foreign, "authority.json"), "utf8")).certPem;
    writeFileSync(path, JSON.stringify(saved));
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection })).rejects.toMatchObject({ code: "unreadable" });
  });

  test("expiry requires deliberate renewal and never silently creates a new trust prompt", async () => {
    const root = directory(), protection = protector();
    const first = await ensureDesktopCompatibilityAuthority({ directory: root, protection });
    const original = readFileSync(join(root, "authority.json"), "utf8");
    const near = await ensureDesktopCompatibilityAuthority({ directory: root, protection, now: () => first.expiresAt - 60_000 });
    expect(near.renewalDue).toBe(true); expect(near.fingerprint).toBe(first.fingerprint);
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection, now: () => first.expiresAt + 1 }))
      .rejects.toMatchObject({ code: "expired" });
    expect(readFileSync(join(root, "authority.json"), "utf8")).toBe(original);
  });

  test("protection failure publishes no certificate or plaintext fallback", async () => {
    const root = directory();
    const protection: AuthorityKeyProtection = { protect: async () => { throw new Error("fixture secret"); }, unprotect: async () => { throw new Error(); } };
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection })).rejects.toMatchObject({ code: "protection_failed" });
    expect(existsSync(join(root, "authority.json"))).toBe(false);
    expect(readdirSync(root).some(name => name.endsWith(".tmp") || name.endsWith(".pem") || name.endsWith(".key"))).toBe(false);
  });

  test("malformed existing state is preserved for recovery rather than regenerated", async () => {
    const root = directory(), path = join(root, "authority.json");
    writeFileSync(path, "broken state");
    await expect(ensureDesktopCompatibilityAuthority({ directory: root, protection: protector() })).rejects.toMatchObject({ code: "unreadable" });
    expect(readFileSync(path, "utf8")).toBe("broken state");
  });

  test.skipIf(process.platform !== "win32")("real CurrentUser DPAPI survives separate helper invocations and rejects corruption", async () => {
    const original = Buffer.from("synthetic authority secret; no real credentials");
    const encrypted = await windowsAuthorityKeyProtection.protect(original);
    expect(Buffer.from(encrypted).includes(original)).toBe(false);
    expect(Buffer.from(await windowsAuthorityKeyProtection.unprotect(encrypted))).toEqual(original);
    const corrupted = Uint8Array.from(encrypted); corrupted[corrupted.length - 1] ^= 1;
    await expect(windowsAuthorityKeyProtection.unprotect(corrupted)).rejects.toThrow("desktop_compatibility_key_protection_failed");
  }, 35_000);
});
