import { createHash, createPrivateKey, createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createCertificateAuthority, isServerAuthOnlyCertificate, type LocalInterceptCa } from "../../claude/intercept/local-ca";
import { withClientLifecycle } from "../../client/lifecycle-lock";
import { hardenSecretDirAsync, hardenSecretPathAsync } from "../../lib/windows-secret-acl";
import { windowsAuthorityKeyProtection, type AuthorityKeyProtection } from "./windows-key-protection";

const POLICY = "codex-desktop-chatgpt-only/v1";
const FILE = "authority.json";
const MAX_FILE = 131_072;
const VALIDITY_DAYS = 30;
const DAY = 86_400_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class DesktopAuthorityError extends Error {
  constructor(readonly code: "unsafe_path" | "unreadable" | "expired" | "renewal_required" | "protection_failed" | "fingerprint_changed") {
    super(`desktop_compatibility_authority_${code}`); this.name = "DesktopAuthorityError";
  }
}

export interface DesktopAuthorityStoreOptions {
  /** Explicit feature-owned directory; never an OS trust store or existing Claude CA. */
  directory: string;
  now?: () => number;
  /** Test seam; production always uses Windows CurrentUser DPAPI. */
  protection?: AuthorityKeyProtection;
}

export interface StoredDesktopAuthority {
  authority: LocalInterceptCa;
  commonName: string;
  fingerprint: string;
  expiresAt: number;
  renewalDue: boolean;
  reused: boolean;
}

export type DesktopAuthorityInspection =
  | { status: "missing" | "invalid" }
  | { status: "present" | "expired" | "renewal-required"; certPem: string; fingerprint: string; expiresAt: number; renewalDue: boolean };

/** Read-only public metadata for status: no key decryption, ACL write, lock or generation. */
export function inspectDesktopCompatibilityAuthority(directory: string, now = Date.now()): DesktopAuthorityInspection {
  if (!isAbsolute(directory) || !Number.isFinite(now)) return { status: "invalid" };
  const path = join(directory, FILE);
  try {
    if (!pathPresent(directory)) return { status: "missing" };
    assertPath(directory, true);
    if (!pathPresent(path)) return { status: "missing" };
    assertPath(path, false);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.version !== 1 || saved.protection !== "windows-current-user-dpapi" || typeof saved.certPem !== "string"
      || typeof saved.sealed !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(saved.sealed) || saved.sealed.length > MAX_FILE) return { status: "invalid" };
    const certificate = new X509Certificate(saved.certPem), expiresAt = Date.parse(certificate.validTo);
    if (!certificate.ca || !Number.isFinite(expiresAt)) return { status: "invalid" };
    return { status: expiresAt <= now ? "expired" : isServerAuthOnlyCertificate(certificate) ? "present" : "renewal-required", certPem: saved.certPem,
      fingerprint: certificate.fingerprint256.replaceAll(":", ""), expiresAt, renewalDue: expiresAt - now <= 7 * DAY };
  } catch { return { status: "invalid" }; }
}

function assertPath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE)) {
    throw new DesktopAuthorityError("unsafe_path");
  }
}

function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw new DesktopAuthorityError("unsafe_path");
  }
}

function validatedAuthority(certPem: string, keyPem: string, commonName: string, now: number, reused: boolean, allowExpired = false): StoredDesktopAuthority {
  try {
    const certificate = new X509Certificate(certPem);
    const privateKey = createPrivateKey(keyPem), publicKey = createPublicKey(keyPem);
    if (!certificate.ca || !certificate.checkPrivateKey(privateKey) || !certificate.verify(publicKey)
      || certificate.subject !== certificate.issuer
      || !commonName.startsWith("OpenCodex Codex Desktop ") || !certificate.subject.split("\n").includes(`CN=${commonName}`)) {
      throw new Error("invalid");
    }
    const expiresAt = Date.parse(certificate.validTo), startsAt = Date.parse(certificate.validFrom);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(startsAt) || startsAt > now
      || expiresAt - startsAt > (VALIDITY_DAYS + 1) * DAY) throw new Error("invalid");
    if (expiresAt <= now && !allowExpired) throw new DesktopAuthorityError("expired");
    if (!allowExpired && !isServerAuthOnlyCertificate(certificate)) throw new DesktopAuthorityError("renewal_required");
    return { authority: { certPem, keyPem, privateKey, publicKey }, commonName,
      fingerprint: certificate.fingerprint256.replaceAll(":", ""), expiresAt,
      renewalDue: expiresAt - now <= 7 * DAY, reused };
  } catch (error) {
    if (error instanceof DesktopAuthorityError) throw error;
    throw new DesktopAuthorityError("unreadable");
  }
}

async function readAuthority(path: string, protection: AuthorityKeyProtection, now: number, allowExpired = false): Promise<StoredDesktopAuthority> {
  assertPath(path, false);
  await hardenSecretPathAsync(path, { required: true });
  assertPath(path, false);
  let cleartext: Uint8Array | undefined;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.version !== 1 || saved.protection !== "windows-current-user-dpapi"
      || typeof saved.certPem !== "string" || typeof saved.sealed !== "string"
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(saved.sealed) || saved.sealed.length > MAX_FILE) throw new Error("invalid");
    cleartext = await protection.unprotect(Buffer.from(saved.sealed, "base64"));
    const secret = JSON.parse(Buffer.from(cleartext).toString("utf8"));
    if (secret.policy !== POLICY || secret.certSha256 !== digest(saved.certPem)
      || typeof secret.keyPem !== "string" || typeof secret.commonName !== "string") throw new Error("invalid");
    return validatedAuthority(saved.certPem, secret.keyPem, secret.commonName, now, true, allowExpired);
  } catch (error) {
    if (error instanceof DesktopAuthorityError) throw error;
    // A corrupt or foreign-user key never silently regenerates a new root or trust prompt.
    throw new DesktopAuthorityError("unreadable");
  } finally { cleartext?.fill(0); }
}

/** Loads only existing state. Expired or legacy-purpose keys may be loaded solely for trust removal/renewal. */
export async function loadDesktopCompatibilityAuthority(options: DesktopAuthorityStoreOptions, allowExpiredForRemoval = false): Promise<StoredDesktopAuthority> {
  if (!isAbsolute(options.directory)) throw new DesktopAuthorityError("unsafe_path");
  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(now)) throw new DesktopAuthorityError("unreadable");
  assertPath(options.directory, true);
  const path = join(options.directory, FILE);
  if (!pathPresent(path)) throw new DesktopAuthorityError("unreadable");
  return readAuthority(path, options.protection ?? windowsAuthorityKeyProtection, now, allowExpiredForRemoval);
}

/** Reuses one user-protected root across restarts; never installs, rotates or removes trust. */
export async function ensureDesktopCompatibilityAuthority(options: DesktopAuthorityStoreOptions): Promise<StoredDesktopAuthority> {
  return publishAuthority(options);
}

/** Deliberate replacement after the caller has removed OS trust and stopped consumers. */
export async function renewDesktopCompatibilityAuthority(options: DesktopAuthorityStoreOptions, expectedFingerprint: string): Promise<StoredDesktopAuthority> {
  if (!/^[A-F0-9]{64}$/.test(expectedFingerprint)) throw new DesktopAuthorityError("fingerprint_changed");
  return publishAuthority(options, expectedFingerprint);
}

async function publishAuthority(options: DesktopAuthorityStoreOptions, expectedFingerprint?: string): Promise<StoredDesktopAuthority> {
  if (!isAbsolute(options.directory)) throw new DesktopAuthorityError("unsafe_path");
  if (!options.protection && process.platform !== "win32") throw new Error("desktop_compatibility_windows_required");
  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(now)) throw new DesktopAuthorityError("unreadable");
  const protection = options.protection ?? windowsAuthorityKeyProtection;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  assertPath(options.directory, true);
  await hardenSecretDirAsync(options.directory, { required: true });
  return withClientLifecycle(async () => {
    assertPath(options.directory, true);
    const path = join(options.directory, FILE);
    let original: string | undefined;
    if (expectedFingerprint !== undefined) {
      if (!pathPresent(path)) throw new DesktopAuthorityError("fingerprint_changed");
      const previous = await readAuthority(path, protection, now, true);
      if (previous.fingerprint !== expectedFingerprint) throw new DesktopAuthorityError("fingerprint_changed");
      original = readFileSync(path, "utf8");
    } else if (pathPresent(path)) return readAuthority(path, protection, now);
    const commonName = `OpenCodex Codex Desktop ${randomUUID()}`;
    const authority = createCertificateAuthority({ commonName, validityDays: VALIDITY_DAYS,
      permittedDnsNames: ["chatgpt.com"], excludeAllIpAddresses: true, serverAuthOnly: true });
    const cleartext = Buffer.from(JSON.stringify({ policy: POLICY, certSha256: digest(authority.certPem), commonName, keyPem: authority.keyPem }));
    let sealed: Uint8Array;
    try { sealed = await protection.protect(cleartext); }
    catch { throw new DesktopAuthorityError("protection_failed"); }
    finally { cleartext.fill(0); }
    if (sealed.byteLength === 0 || sealed.byteLength > 65_536) throw new DesktopAuthorityError("protection_failed");
    const contents = JSON.stringify({ version: 1, protection: "windows-current-user-dpapi", certPem: authority.certPem,
      sealed: Buffer.from(sealed).toString("base64") });
    const temporary = join(options.directory, `authority-${randomUUID()}.tmp`);
    let created = false;
    try {
      const fd = openSync(temporary, "wx", 0o600); created = true;
      try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
      await hardenSecretPathAsync(temporary, { required: true });
      assertPath(temporary, false); assertPath(options.directory, true);
      // Verify the new encrypted envelope before replacing the only recovery source.
      await readAuthority(temporary, protection, now);
      if (original !== undefined) {
        assertPath(path, false);
        if (readFileSync(path, "utf8") !== original) throw new DesktopAuthorityError("fingerprint_changed");
      } else if (pathPresent(path)) throw new DesktopAuthorityError("unsafe_path");
      renameSync(temporary, path); created = false;
      // Read back the actual persisted pair before reporting a successful setup.
      const persisted = await readAuthority(path, protection, now);
      return { ...persisted, reused: false };
    } finally { if (created) unlinkSync(temporary); }
  }, { lockPath: join(options.directory, "authority-publication.sqlite") });
}
