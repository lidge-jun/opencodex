import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, X509Certificate, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withClientLifecycleSync } from "../../client/lifecycle-lock";

/**
 * Local certificate authority for the Claude intercept listener.
 *
 * Claude Code opens `CONNECT api.anthropic.com:443` through `HTTPS_PROXY` and then expects a
 * TLS server that presents a certificate for that name. This module mints that authority and
 * its leaves with nothing but `node:crypto`: no OpenSSL shell-out, no third-party ASN.1
 * library. The CA is trusted by the Claude Code process alone via `NODE_EXTRA_CA_CERTS`; it is
 * never installed into an OS trust store.
 *
 * Only the subset of X.509 needed for a v3 CA and a serverAuth leaf is encoded. ECDSA P-256 is
 * used for both, which Node's TLS stack accepts without any additional configuration.
 */

export const CLAUDE_INTERCEPT_CA_COMMON_NAME = "opencodex Claude Intercept CA";
const ORGANIZATION = "opencodex";
const CA_VALIDITY_DAYS = 3650;
const LEAF_VALIDITY_DAYS = 365;

// ── DER encoding ────────────────────────────────────────────────────────────────

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

const sequence = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts));
const boolean = (value: boolean) => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));
const octetString = (body: Uint8Array) => tlv(0x04, body);
const utf8String = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
const contextTag = (n: number, body: Uint8Array, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);

function integer(bytes: Uint8Array): Uint8Array {
  return tlv(0x02, (bytes[0]! & 0x80) !== 0 ? concat(Uint8Array.of(0), bytes) : bytes);
}

function bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(0x03, concat(Uint8Array.of(unusedBits), bytes));
}

function objectIdentifier(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const encoded: number[] = [arc & 0x7f];
    let rest = arc >> 7;
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    bytes.push(...encoded);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

function utcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
}

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  extendedKeyUsage: "2.5.29.37",
  subjectKeyIdentifier: "2.5.29.14",
  authorityKeyIdentifier: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

function distinguishedName(commonName: string): Uint8Array {
  return sequence(
    set(sequence(objectIdentifier(OID.organization), utf8String(ORGANIZATION))),
    set(sequence(objectIdentifier(OID.commonName), utf8String(commonName))),
  );
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

function subjectPublicKeyInfo(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ type: "spki", format: "der" }));
}

/** RFC 5280 permits any unique octet string; a truncated SHA-256 of the SPKI is stable and collision-safe. */
function keyIdentifier(key: KeyObject): Uint8Array {
  return new Uint8Array(createHash("sha256").update(subjectPublicKeyInfo(key)).digest()).subarray(0, 20);
}

function randomSerial(): Uint8Array {
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0]! &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  return serial;
}

function toPem(label: string, der: Uint8Array): string {
  const base64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

interface IssueOptions {
  subject: Uint8Array;
  issuer: Uint8Array;
  subjectKey: KeyObject;
  signingKey: KeyObject;
  validityDays: number;
  extensions: Uint8Array[];
}

function issueCertificate(options: IssueOptions): Uint8Array {
  // Back-date slightly so a client whose clock trails ours by a few minutes still accepts it.
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(notBefore.getTime() + options.validityDays * 86_400_000);
  const algorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));
  const tbsCertificate = sequence(
    contextTag(0, tlv(0x02, Uint8Array.of(2))),
    integer(randomSerial()),
    algorithm,
    options.issuer,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    options.subject,
    subjectPublicKeyInfo(options.subjectKey),
    contextTag(3, sequence(...options.extensions)),
  );
  const signature = new Uint8Array(sign("sha256", tbsCertificate, { key: options.signingKey, dsaEncoding: "der" }));
  return sequence(tbsCertificate, algorithm, bitString(signature));
}

// ── Authority + leaves ──────────────────────────────────────────────────────────

export interface PemKeyPair {
  certPem: string;
  keyPem: string;
}

export interface LocalInterceptCa extends PemKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function createLocalInterceptCa(): LocalInterceptCa {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = distinguishedName(CLAUDE_INTERCEPT_CA_COMMON_NAME);
  const der = issueCertificate({
    subject: name,
    issuer: name,
    subjectKey: publicKey,
    signingKey: privateKey,
    validityDays: CA_VALIDITY_DAYS,
    extensions: [
      extension(OID.basicConstraints, true, sequence(boolean(true), tlv(0x02, Uint8Array.of(0)))),
      // keyCertSign | cRLSign
      extension(OID.keyUsage, true, bitString(Uint8Array.of(0x06), 1)),
      extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(publicKey))),
    ],
  });
  return {
    certPem: toPem("CERTIFICATE", der),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKey,
    privateKey,
  };
}

/** Issue a serverAuth leaf for `hosts` (first entry becomes the CN; all become SAN dNSNames). */
export function issueLocalInterceptLeaf(ca: LocalInterceptCa, hosts: readonly string[]): PemKeyPair {
  if (hosts.length === 0) throw new Error("intercept leaf requires at least one host");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = issueCertificate({
    subject: distinguishedName(hosts[0]!),
    issuer: distinguishedName(CLAUDE_INTERCEPT_CA_COMMON_NAME),
    subjectKey: publicKey,
    signingKey: ca.privateKey,
    validityDays: LEAF_VALIDITY_DAYS,
    extensions: [
      extension(OID.basicConstraints, true, sequence()),
      // digitalSignature
      extension(OID.keyUsage, true, bitString(Uint8Array.of(0x80), 7)),
      extension(OID.extendedKeyUsage, false, sequence(objectIdentifier(OID.serverAuth))),
      extension(OID.subjectAltName, false, sequence(
        ...hosts.map(host => contextTag(2, new TextEncoder().encode(host), false)),
      )),
      extension(OID.authorityKeyIdentifier, false, sequence(contextTag(0, keyIdentifier(ca.publicKey), false))),
    ],
  });
  return {
    certPem: toPem("CERTIFICATE", der),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────────

export const CLAUDE_INTERCEPT_STATE_DIR = "claude-intercept";
export const CLAUDE_INTERCEPT_CA_CERT_FILE = "ca.pem";
const CA_KEY_FILE = "ca.key";

export function claudeInterceptStateDir(configDir: string): string {
  return join(configDir, CLAUDE_INTERCEPT_STATE_DIR);
}

/** Path Claude Code must see in `NODE_EXTRA_CA_CERTS`. Stable across restarts. */
export function claudeInterceptCaCertPath(configDir: string): string {
  return join(claudeInterceptStateDir(configDir), CLAUDE_INTERCEPT_CA_CERT_FILE);
}

function writeFileAtomic(path: string, contents: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode });
  try { chmodSync(tmp, mode); } catch { /* best-effort on platforms without POSIX modes */ }
  renameSync(tmp, path);
}

function loadPersistedCa(dir: string): LocalInterceptCa | null {
  const certPath = join(dir, CLAUDE_INTERCEPT_CA_CERT_FILE);
  const keyPath = join(dir, CA_KEY_FILE);
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  try {
    const certPem = readFileSync(certPath, "utf8");
    const keyPem = readFileSync(keyPath, "utf8");
    const privateKey = createPrivateKey(keyPem);
    const publicKey = createPublicKey(keyPem);
    const certificate = new X509Certificate(certPem);
    if (!certificate.ca || !certificate.checkPrivateKey(privateKey) || !certificate.verify(publicKey)) return null;
    return { certPem, keyPem, publicKey, privateKey };
  } catch { // no-excuse-ok: catch -- an unreadable or corrupt authority is regenerated below.
    return null;
  }
}

/**
 * Load the persisted authority under `<configDir>/claude-intercept/`, minting one when absent
 * or unreadable. The private key is written 0600; the certificate is world-readable because
 * `NODE_EXTRA_CA_CERTS` only needs the public half.
 */
export function ensureLocalInterceptCa(configDir: string): LocalInterceptCa {
  const dir = claudeInterceptStateDir(configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A separate SQLite namespace binds exclusion to the explicit CA directory.
  // The OS releases it on crash; a contending caller fails before touching either
  // PEM. Readers also take the lease so they cannot observe half a publication.
  return withClientLifecycleSync(() => {
    const existing = loadPersistedCa(dir);
    if (existing) return existing;
    const ca = createLocalInterceptCa();
    writeFileAtomic(join(dir, CA_KEY_FILE), ca.keyPem, 0o600);
    writeFileAtomic(join(dir, CLAUDE_INTERCEPT_CA_CERT_FILE), ca.certPem, 0o644);
    return ca;
  }, { lockPath: join(dir, "ca-publication.sqlite") });
}

/** Startup may race a settings apply publishing the same CA. Retry only lease
 * contention, before binding listeners, without blocking the main event loop. */
export async function ensureLocalInterceptCaForStartup(configDir: string): Promise<LocalInterceptCa> {
  for (let attempt = 0; ; attempt += 1) {
    try { return ensureLocalInterceptCa(configDir); }
    catch (error) {
      if (attempt >= 49 || !(error instanceof Error)
        || !("code" in error) || error.code !== "client_lifecycle_busy") throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
