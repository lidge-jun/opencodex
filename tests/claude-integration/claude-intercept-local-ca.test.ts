import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withClientLifecycleSync } from "../../src/client/lifecycle-lock";
import {
  CLAUDE_INTERCEPT_CA_COMMON_NAME,
  claudeInterceptCaCertPath,
  claudeInterceptStateDir,
  createLocalInterceptCa,
  ensureLocalInterceptCa,
  ensureLocalInterceptCaForStartup,
  issueLocalInterceptLeaf,
} from "../../src/claude/intercept/local-ca";

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-intercept-ca-"));
}

test("CA certificate is a self-signed X.509 v3 authority", () => {
  const ca = createLocalInterceptCa();
  const cert = new X509Certificate(ca.certPem);
  expect(cert.ca).toBe(true);
  expect(cert.subject).toContain(`CN=${CLAUDE_INTERCEPT_CA_COMMON_NAME}`);
  expect(cert.issuer).toBe(cert.subject);
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkIssued(cert)).toBe(true);
  expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
  expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000);
});

test("leaf is issued by the CA and names every requested host in SAN", () => {
  const ca = createLocalInterceptCa();
  const leaf = issueLocalInterceptLeaf(ca, ["api.anthropic.com", "example.test"]);
  const cert = new X509Certificate(leaf.certPem);
  const caCert = new X509Certificate(ca.certPem);
  expect(cert.ca).toBe(false);
  expect(cert.checkIssued(caCert)).toBe(true);
  expect(cert.verify(ca.publicKey)).toBe(true);
  expect(cert.checkHost("api.anthropic.com")).toBe("api.anthropic.com");
  expect(cert.checkHost("example.test")).toBe("example.test");
  expect(cert.checkHost("other.example")).toBeUndefined();
  expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
  expect(leaf.keyPem).toContain("PRIVATE KEY");
});

test("two CAs never share a serial or key", () => {
  const a = createLocalInterceptCa();
  const b = createLocalInterceptCa();
  expect(new X509Certificate(a.certPem).serialNumber).not.toBe(new X509Certificate(b.certPem).serialNumber);
  expect(a.keyPem).not.toBe(b.keyPem);
});

test("ensureLocalInterceptCa persists once and reloads the same authority", () => {
  const configDir = tmpConfigDir();
  const first = ensureLocalInterceptCa(configDir);
  const second = ensureLocalInterceptCa(configDir);
  expect(second.certPem).toBe(first.certPem);
  expect(second.keyPem).toBe(first.keyPem);
  expect(readFileSync(claudeInterceptCaCertPath(configDir), "utf8")).toBe(first.certPem);
  if (process.platform !== "win32") {
    expect(statSync(join(claudeInterceptStateDir(configDir), "ca.key")).mode & 0o777).toBe(0o600);
    expect(statSync(claudeInterceptCaCertPath(configDir)).mode & 0o777).toBe(0o644);
    expect(statSync(claudeInterceptStateDir(configDir)).mode & 0o777).toBe(0o700);
  }
});

test("a corrupt private key regenerates the authority instead of throwing", () => {
  const configDir = tmpConfigDir();
  const first = ensureLocalInterceptCa(configDir);
  writeFileSync(join(claudeInterceptStateDir(configDir), "ca.key"), "not a key\n");
  const regenerated = ensureLocalInterceptCa(configDir);
  expect(regenerated.certPem).not.toBe(first.certPem);
  expect(new X509Certificate(regenerated.certPem).ca).toBe(true);
  expect(readFileSync(claudeInterceptCaCertPath(configDir), "utf8")).toBe(regenerated.certPem);
});

test("a certificate from a different CA is never loaded with the persisted key", () => {
  const configDir = tmpConfigDir();
  const first = ensureLocalInterceptCa(configDir);
  writeFileSync(claudeInterceptCaCertPath(configDir), createLocalInterceptCa().certPem);
  const repaired = ensureLocalInterceptCa(configDir);
  expect(repaired.keyPem).not.toBe(first.keyPem);
  const certificate = new X509Certificate(repaired.certPem);
  expect(certificate.checkPrivateKey(repaired.privateKey)).toBe(true);
  expect(certificate.verify(repaired.publicKey)).toBe(true);
});

test("a contending CA publisher cannot read or change a partial pair", () => {
  const configDir = tmpConfigDir();
  const first = ensureLocalInterceptCa(configDir);
  const dir = claudeInterceptStateDir(configDir);
  withClientLifecycleSync(() => {
    writeFileSync(join(dir, "ca.key"), createLocalInterceptCa().keyPem);
    const partialKey = readFileSync(join(dir, "ca.key"), "utf8");
    expect(() => ensureLocalInterceptCa(configDir)).toThrow("client_lifecycle_busy");
    expect(readFileSync(join(dir, "ca.key"), "utf8")).toBe(partialKey);
    expect(readFileSync(claudeInterceptCaCertPath(configDir), "utf8")).toBe(first.certPem);
  }, { lockPath: join(dir, "ca-publication.sqlite") });
  const repaired = ensureLocalInterceptCa(configDir);
  expect(new X509Certificate(repaired.certPem).checkPrivateKey(repaired.privateKey)).toBe(true);
});

test("startup retries CA contention after the publisher releases its lease", async () => {
  const configDir = tmpConfigDir();
  const first = ensureLocalInterceptCa(configDir);
  const pending = withClientLifecycleSync(() => {
    const startup = ensureLocalInterceptCaForStartup(configDir);
    // Return a plain wrapper: the synchronous lease never spans an await.
    return { startup };
  }, { lockPath: join(claudeInterceptStateDir(configDir), "ca-publication.sqlite") });
  const loaded = await pending.startup;
  expect(loaded.certPem).toBe(first.certPem);
  expect(loaded.keyPem).toBe(first.keyPem);
});
