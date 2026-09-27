import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withClientLifecycleSync } from "../../client/lifecycle-lock";
import {
  ALL_IP_ADDRESS_BASES,
  createCertificateAuthority,
  issueServerLeaf,
  type LocalInterceptCa,
  type PemKeyPair,
} from "./local-ca";

/** Separate root for Desktop traffic: its critical DNS constraint is checked on every reload. */
export const PICKER_HOST = "claude.ai";
export const PICKER_CA_COMMON_NAME = "opencodex Claude Desktop Picker CA";
export const PICKER_STATE_DIR = "claude-picker";

export interface PickerCa extends LocalInterceptCa { fingerprint: string }
export interface PendingPickerCaUntrust { certPem: string; sha1: string; sha256: string }

const processAuthorities = new Map<string, PickerCa>();
const MAX_PENDING_CA_BYTES = 64 * 1024;
const LEGACY_OWNER_MTIME_TOLERANCE_MS = 2_000;

export function pickerStateDir(configDir: string): string { return join(configDir, PICKER_STATE_DIR); }
export function pickerCaCertPath(configDir: string): string { return join(pickerStateDir(configDir), "ca.pem"); }
export function pickerLeafCertPath(configDir: string): string { return join(pickerStateDir(configDir), "leaf.pem"); }
export function pickerCaOwnerPath(configDir: string): string { return join(pickerStateDir(configDir), "ca-owner.json"); }
export function pickerCaPendingUntrustPath(configDir: string): string { return join(pickerStateDir(configDir), "pending-untrust.json"); }
function pickerCaLockPath(configDir: string): string { return join(pickerStateDir(configDir), "ca.lock.sqlite"); }

export function pickerCaFingerprints(certPem: string): { sha1: string; sha256: string } {
  const der = new X509Certificate(certPem).raw;
  return {
    sha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
    sha256: createHash("sha256").update(der).digest("hex").toUpperCase(),
  };
}

interface DerItem { tag: number; body: Buffer; next: number }

function readDer(bytes: Buffer, at: number): DerItem | null {
  if (at + 2 > bytes.length) return null;
  const tag = bytes[at]!;
  let length = bytes[at + 1]!;
  let cursor = at + 2;
  if (length & 0x80) {
    const width = length & 0x7f;
    if (width === 0 || width > 4 || cursor + width > bytes.length) return null;
    length = 0;
    for (let i = 0; i < width; i++) length = length * 256 + bytes[cursor++]!;
  }
  if (cursor + length > bytes.length) return null;
  return { tag, body: bytes.subarray(cursor, cursor + length), next: cursor + length };
}

function children(bytes: Buffer): DerItem[] | null {
  const out: DerItem[] = [];
  for (let cursor = 0; cursor < bytes.length;) {
    const item = readDer(bytes, cursor);
    if (!item) return null;
    out.push(item);
    cursor = item.next;
  }
  return out;
}

function constrainedToPickerHost(value: Buffer): boolean {
  const root = readDer(value, 0);
  if (!root || root.tag !== 0x30 || root.next !== value.length) return false;
  const fields = children(root.body);
  if (!fields || fields.length !== 2 || fields[0]!.tag !== 0xa0 || fields[1]!.tag !== 0xa1) return false;
  const excluded = children(fields[1]!.body);
  const excludesAllIps = excluded?.length === ALL_IP_ADDRESS_BASES.length && excluded.every((subtree, index) => {
    const base = subtree.tag === 0x30 ? children(subtree.body) : null;
    return base?.length === 1 && base[0]!.tag === 0x87
      && base[0]!.body.equals(Buffer.from(ALL_IP_ADDRESS_BASES[index]!));
  });
  if (!excludesAllIps) return false;
  const subtrees = children(fields[0]!.body);
  const subtree = subtrees?.length === 1 && subtrees[0]!.tag === 0x30 ? children(subtrees[0]!.body) : null;
  return subtree?.length === 1 && subtree[0]!.tag === 0x82
    && subtree[0]!.body.equals(Buffer.from(PICKER_HOST, "ascii"));
}

interface ParsedExtension { oid: Buffer; critical: boolean; value: Buffer }

/** One Extension SEQUENCE → oid, criticality, and extnValue bytes; malformed shapes return null. */
function parseExtension(item: DerItem): ParsedExtension | null {
  if (item.tag !== 0x30) return null;
  const fields = children(item.body);
  if (!fields || fields.length < 2 || fields.length > 3 || fields[0]!.tag !== 0x06) return null;
  const value = fields[fields.length - 1]!;
  if (value.tag !== 0x04) return null;
  if (fields.length === 2) return { oid: fields[0]!.body, critical: false, value: value.body };
  // DER encodes the critical flag only as BOOLEAN TRUE; anything else is not a real extension.
  if (fields[1]!.tag !== 0x01 || !fields[1]!.body.equals(Buffer.from([0xff]))) return null;
  return { oid: fields[0]!.body, critical: true, value: value.body };
}

// DER OID bodies for the only four extensions a picker authority carries. A SAN, an EKU, or any
// other extension means the certificate is not a picker authority, whatever its subject claims.
const EXT_BASIC_CONSTRAINTS = "551d13";
const EXT_KEY_USAGE = "551d0f";
const EXT_SUBJECT_KEY_IDENTIFIER = "551d0e";
const EXT_NAME_CONSTRAINTS = "551d1e";
const PICKER_CA_EXTENSION_OIDS = new Set([
  EXT_BASIC_CONSTRAINTS, EXT_KEY_USAGE, EXT_SUBJECT_KEY_IDENTIFIER, EXT_NAME_CONSTRAINTS,
]);

/** basicConstraints CA:TRUE with pathLenConstraint 0 — the anchor signs leaves, not other CAs. */
const PICKER_CA_BASIC_CONSTRAINTS = Buffer.from([0x30, 0x06, 0x01, 0x01, 0xff, 0x02, 0x01, 0x00]);
/** keyUsage keyCertSign | cRLSign only — the anchor can never sign a TLS handshake itself. */
const PICKER_CA_KEY_USAGE = Buffer.from([0x03, 0x02, 0x01, 0x06]);

/**
 * The trust decision accepts exactly the extension profile createCertificateAuthority emits, not
 * merely a certificate that happens to contain the right name constraint. A root that also carries
 * leaf privileges (SAN, serverAuth EKU, digitalSignature) could be presented directly as an
 * off-host server certificate, where name constraints on subordinates no longer apply.
 */
function acceptsExtensionProfile(extensions: DerItem[]): boolean {
  const seen = new Set<string>();
  for (const item of extensions) {
    const extension = parseExtension(item);
    if (extension === null) return false;
    const key = extension.oid.toString("hex");
    if (!PICKER_CA_EXTENSION_OIDS.has(key) || seen.has(key)) return false;
    seen.add(key);
    switch (key) {
      case EXT_BASIC_CONSTRAINTS:
        if (!extension.critical || !extension.value.equals(PICKER_CA_BASIC_CONSTRAINTS)) return false;
        break;
      case EXT_KEY_USAGE:
        if (!extension.critical || !extension.value.equals(PICKER_CA_KEY_USAGE)) return false;
        break;
      case EXT_SUBJECT_KEY_IDENTIFIER: {
        const id = readDer(extension.value, 0);
        if (extension.critical || id === null || id.tag !== 0x04 || id.next !== extension.value.length) return false;
        break;
      }
      default:
        if (!extension.critical || !constrainedToPickerHost(extension.value)) return false;
    }
  }
  return seen.size === PICKER_CA_EXTENSION_OIDS.size;
}

/** Independently authorize a root before installing it as system trust. */
export function acceptsPickerAuthority(certPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    const names = cert.subject.split("\n");
    if (!names.includes(`CN=${PICKER_CA_COMMON_NAME}`)) return false;
    if (names.filter(line => line.startsWith("CN=")).length !== 1) return false;
    // A picker authority is self-issued and self-signed; a foreign issuer is not one of ours.
    if (cert.issuer !== cert.subject || !cert.verify(cert.publicKey)) return false;
    const root = readDer(cert.raw, 0);
    const certificate = root?.tag === 0x30 && root.next === cert.raw.length ? children(root.body) : null;
    const tbs = certificate?.[0]?.tag === 0x30 ? children(certificate[0].body) : null;
    const extensionField = tbs?.find(item => item.tag === 0xa3);
    const wrapped = extensionField && readDer(extensionField.body, 0);
    const extensions = wrapped?.tag === 0x30 && wrapped.next === extensionField!.body.length
      ? children(wrapped.body) : null;
    return extensions !== null && acceptsExtensionProfile(extensions);
  } catch {
    return false;
  }
}

/** Atomically publish a public certificate; these files carry no key material. */
function publishPem(path: string, pem: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, pem, { flag: "wx", mode: 0o644 });
    try { chmodSync(tmp, 0o644); } catch { /* best-effort on platforms without POSIX modes */ }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Publish this process's authority and record which pid owns it, so another process that shares
 * the config directory can distinguish "the file went missing or stale" from "a live peer rotated
 * the authority" — only the former may be overwritten.
 */
function publishAuthority(configDir: string, ca: PickerCa): void {
  publishPem(pickerCaCertPath(configDir), ca.certPem);
  publishOwner(configDir, ca);
}

function publishOwner(configDir: string, ca: PickerCa): void {
  publishPem(pickerCaOwnerPath(configDir), JSON.stringify({
    pid: process.pid,
    startTime: processStartIdentity(process.pid),
    sha256: ca.fingerprint,
  }) + "\n");
}

function currentProcessOwnsPublishedCa(configDir: string, ca: PickerCa): boolean {
  try {
    const owner = JSON.parse(readFileSync(pickerCaOwnerPath(configDir), "utf8")) as Record<string, unknown>;
    return owner.pid === process.pid && owner.sha256 === ca.fingerprint
      && owner.startTime === processStartIdentity(process.pid);
  } catch { return false; }
}

/** The OS process start identity prevents a recycled PID from impersonating the recorded owner. */
function processStartIdentity(pid: number, utc = false): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const afterCommand = stat.lastIndexOf(") ");
      const ticks = afterCommand < 0 ? undefined : stat.slice(afterCommand + 2).trim().split(/\s+/)[19];
      return ticks && /^\d+$/.test(ticks) ? ticks : null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
        ...(utc ? { env: { ...process.env, TZ: "UTC" } } : {}),
      });
      const value = result.stdout.toString().trim();
      return result.exitCode === 0 && value.length > 0 && value.length <= 128 ? value : null;
    } catch { return null; }
  }
  return null;
}

/** Darwin's lstart is local wall-clock time; Linux's /proc start ticks are not comparable to mtime. */
function processStartEpochMs(pid: number): number | null {
  if (process.platform !== "darwin") return null;
  const identity = processStartIdentity(pid, true);
  if (identity === null) return null;
  const epoch = Date.parse(`${identity} UTC`);
  return Number.isFinite(epoch) ? epoch : null;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signallable by us; ESRCH means it is gone.
    return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * True when the published certificate belongs to a live process's authority. The owner
 * record is only trusted while it describes the certificate actually on disk: a stale or
 * third-party `ca-owner.json` cannot shield a file that was tampered with after the owner wrote it.
 */
function livePublishedOwner(configDir: string, published: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(pickerCaOwnerPath(configDir), "utf8")) as unknown;
    if (owner === null || typeof owner !== "object") return false;
    const { pid, sha256, startTime } = owner as { pid?: unknown; sha256?: unknown; startTime?: unknown };
    if (typeof pid !== "number" || typeof sha256 !== "string") return false;
    if (sha256 !== pickerCaFingerprints(published).sha256) return false;
    if (!processAlive(pid)) return false;
    // Older records have no start identity. On Darwin, wall-clock start after the owner
    // file proves PID reuse; otherwise preserve the conservative live-owner decision.
    if (startTime === undefined || startTime === null) {
      const startedAt = processStartEpochMs(pid);
      if (startedAt === null) return true;
      let mtime: number;
      try { mtime = statSync(pickerCaOwnerPath(configDir)).mtimeMs; }
      catch { return true; }
      return !Number.isFinite(mtime) || startedAt <= mtime + LEGACY_OWNER_MTIME_TOLERANCE_MS;
    }
    if (typeof startTime !== "string" || startTime.length === 0 || startTime.length > 128) return false;
    const actual = processStartIdentity(pid);
    return actual === null || actual === startTime;
  } catch {
    return false;
  }
}

function publicCertificate(pem: string): PendingPickerCaUntrust | null {
  try {
    const certPem = new X509Certificate(pem).toString();
    return { certPem, ...pickerCaFingerprints(certPem) };
  } catch {
    return null;
  }
}

/** The pending record is public-only, but malformed or unsafe state must never be discarded. */
export function readPendingPickerCaUntrust(configDir: string): PendingPickerCaUntrust | null {
  const path = pickerCaPendingUntrustPath(configDir);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PENDING_CA_BYTES) {
    throw new Error("picker_ca_pending_untrust_unsafe");
  }
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw) > MAX_PENDING_CA_BYTES) throw new Error("picker_ca_pending_untrust_unsafe");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("picker_ca_pending_untrust_invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("picker_ca_pending_untrust_invalid");
  }
  const pending = value as Partial<PendingPickerCaUntrust>;
  if (Object.keys(pending).sort().join(",") !== "certPem,sha1,sha256"
    || typeof pending.certPem !== "string" || typeof pending.sha1 !== "string" || typeof pending.sha256 !== "string") {
    throw new Error("picker_ca_pending_untrust_invalid");
  }
  const publicOnly = publicCertificate(pending.certPem);
  if (!publicOnly || pending.certPem !== publicOnly.certPem
    || pending.sha1 !== publicOnly.sha1 || pending.sha256 !== publicOnly.sha256) {
    throw new Error("picker_ca_pending_untrust_invalid");
  }
  return publicOnly;
}

function writePendingPickerCaUntrust(configDir: string, pending: PendingPickerCaUntrust): void {
  const path = pickerCaPendingUntrustPath(configDir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(pending) + "\n", { flag: "wx", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* best-effort on platforms without POSIX modes */ }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * A lock failure is separate from a successful void callback. Once the callback entered, an
 * exception (including lock release failure) propagates: its effects may be partial.
 */
function underPickerCaLock<T>(configDir: string, check: () => T):
  | { kind: "acquired"; value: T }
  | { kind: "unavailable"; error: unknown } {
  let entered = false;
  try {
    const value = withClientLifecycleSync(() => {
      entered = true;
      return check();
    }, { lockPath: pickerCaLockPath(configDir) });
    return { kind: "acquired", value };
  } catch (error) {
    if (entered) throw error;
    return { kind: "unavailable", error };
  }
}

function lockedPickerCa<T>(configDir: string, check: () => T): T {
  const result = underPickerCaLock(configDir, check);
  if (result.kind === "unavailable") throw result.error;
  return result.value;
}

function publishedPickerCa(configDir: string): string | null {
  try { return readFileSync(pickerCaCertPath(configDir), "utf8"); }
  catch (error) {
    if (error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

/** A pending CA may still be serving when journal publication preceded a failed PEM replacement. */
export function pendingPickerCaHasLivePublishedOwner(configDir: string, pending: PendingPickerCaUntrust): boolean {
  return lockedPickerCa(configDir, () => {
    const current = readPendingPickerCaUntrust(configDir);
    if (!current || current.sha1 !== pending.sha1
      || current.sha256 !== pending.sha256 || current.certPem !== pending.certPem) {
      throw new Error("picker_ca_pending_untrust_changed");
    }
    const published = publishedPickerCa(configDir);
    return published !== null && publicCertificate(published)?.sha256 === pending.sha256
      && livePublishedOwner(configDir, published);
  });
}

/** Acknowledgement never clears an entry another process created or replaced. */
export function acknowledgePendingPickerCaUntrust(
  configDir: string,
  pending: PendingPickerCaUntrust,
  confirmedUntrust: { ok: boolean },
): boolean {
  if (confirmedUntrust?.ok !== true) return false;
  return lockedPickerCa(configDir, () => {
    const current = readPendingPickerCaUntrust(configDir);
    if (!current || current.certPem !== pending.certPem
      || current.sha1 !== pending.sha1 || current.sha256 !== pending.sha256) return false;
    rmSync(pickerCaPendingUntrustPath(configDir));
    return true;
  });
}

/**
 * Drop the legacy exportable signing key, if one exists in the picker state dir. Releases before
 * the process-scoped authority persisted `ca.key` next to `ca.pem`; the removal is deliberately
 * unconditional so a later failed rotation can never leave that key behind.
 */
export function discardPickerCaKey(configDir: string): void {
  rmSync(join(pickerStateDir(configDir), "ca.key"), { force: true });
}

export function ensurePickerCa(configDir: string, options: { rotation?: "startup" } = {}): PickerCa {
  const dir = pickerStateDir(configDir);
  // The signing key must never survive this process: another process under the same user could
  // otherwise steal it and later take over the predictable loopback proxy. Drop a key left (or
  // restored) by an older release on every call, including cache hits.
  discardPickerCaKey(configDir);
  const cached = processAuthorities.get(dir);
  const pickerCa = cached ?? (() => {
    const ca = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
    return { ...ca, fingerprint: pickerCaFingerprints(ca.certPem).sha256 };
  })();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  lockedPickerCa(configDir, () => {
    if (readPendingPickerCaUntrust(configDir)) throw new Error("picker_ca_pending_untrust");
    const published = publishedPickerCa(configDir);
    if (published === pickerCa.certPem) {
      // The signing key is still in this process. A missing/stale owner file must not let a
      // second process rotate this live authority after an otherwise harmless cached ensure.
      if (!currentProcessOwnsPublishedCa(configDir, pickerCa)) publishOwner(configDir, pickerCa);
      return;
    }
    if (published !== null && livePublishedOwner(configDir, published)) {
      throw new Error("picker_ca_live_owner");
    }
    const outgoing = published === null ? null : publicCertificate(published);
    if (outgoing && outgoing.sha256 !== pickerCa.fingerprint) {
      if (options.rotation !== "startup") throw new Error("picker_ca_rotation_requires_startup");
      writePendingPickerCaUntrust(configDir, outgoing);
    }
    publishAuthority(configDir, pickerCa);
  });
  if (!cached) processAuthorities.set(dir, pickerCa);
  return pickerCa;
}

/** Fingerprint of this process's authority only — null until ensurePickerCa has run. */
export function publishedPickerCaSha256(configDir: string): string | null {
  const cached = processAuthorities.get(pickerStateDir(configDir));
  return cached ? pickerCaFingerprints(cached.certPem).sha256 : null;
}

/** Persist only the public leaf, so trust inspection verifies this exact local issuer. */
export function issuePickerLeaf(ca: PickerCa, configDir: string): PemKeyPair {
  const leaf = issueServerLeaf(ca, PICKER_CA_COMMON_NAME, [PICKER_HOST]);
  mkdirSync(pickerStateDir(configDir), { recursive: true, mode: 0o700 });
  publishPem(pickerLeafCertPath(configDir), leaf.certPem);
  return leaf;
}
