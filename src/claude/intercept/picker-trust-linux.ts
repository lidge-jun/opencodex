import { Database } from "bun:sqlite";
import { X509Certificate } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { acceptsPickerAuthority, PICKER_CA_COMMON_NAME, sameLinuxPickerTrustStore, type LinuxPickerTrustStore } from "./picker-ca";
import type { PickerTrustState, SecurityResult } from "./picker-trust";

export type LinuxTrustRunner = (args: readonly string[]) => Promise<SecurityResult>;

export const LINUX_TRUST_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const LINUX_TRUST_TRUNCATED = "certutil_output_truncated";
const MISSING = "certutil_missing";
const NSS_FILES = ["cert9.db", "key4.db", "pkcs11.txt", "cert8.db", "key3.db", "secmod.db",
  ...["cert9.db", "key4.db"].flatMap(db => ["-journal", "-shm", "-wal"].map(suffix => db + suffix))];

function statIfPresent(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function legacyDbDir(home: string): string {
  if (!isAbsolute(home) || home.split(sep).includes("..")) throw new Error("unsafe NSS home");
  return join(home, ".pki", "nssdb");
}

function xdgDbDir(home: string, xdgDataHome?: string): string {
  const data = xdgDataHome || join(home, ".local", "share");
  if (!isAbsolute(data) || data.split(sep).includes("..")) throw new Error("unsafe NSS data home");
  return join(data, "pki", "nssdb");
}

export function linuxNssDbDir(home = homedir(), xdgDataHome?: string): string {
  // Chromium crypto/nss_util.cc:GetDefaultNSSConfigDirectory prefers an existing legacy
  // directory, then uses ${XDG_DATA_HOME:-$HOME/.local/share}/pki/nssdb.
  // https://chromium.googlesource.com/chromium/src/+/main/crypto/nss_util.cc
  const legacy = legacyDbDir(home);
  const stat = statIfPresent(legacy);
  // A legacy symlink may be Chromium's active store. Select it so the safety check refuses it.
  if (stat?.isDirectory() || stat?.isSymbolicLink()) return legacy;
  return xdgDbDir(home, xdgDataHome);
}

export function linuxPickerNickname(sha1: string): string {
  return `${PICKER_CA_COMMON_NAME} ${sha1}`;
}

/** Check ancestors as well, since a writable parent can replace a safe directory. */
function safeDirectory(path: string, database: boolean, uid: bigint | undefined): BigIntStats | undefined {
  const parent = dirname(path);
  if (parent !== path) safeDirectory(parent, false, uid);
  const stat = statIfPresent(path);
  if (!stat) return undefined;
  if (!database && uid !== undefined && stat.uid === 0n && stat.isSymbolicLink()) {
    // Trusted system aliases (for example /var) may lead to an otherwise safe ancestor.
    return safeDirectory(realpathSync(path), false, uid);
  }
  if (!stat.isDirectory() || (uid !== undefined && (
    (stat.uid !== uid && (database || stat.uid !== 0n))
    || ((stat.mode & 0o022n) !== 0n && (database || (stat.mode & 0o1000n) === 0n))
  ))) throw new Error("unsafe NSS directory");
  return stat;
}

function openNssDb(dir: string) {
  const uid = process.platform === "win32" ? undefined : BigInt(process.getuid!());
  const directory = safeDirectory(dir, true, uid);
  const files = new Map<string, BigIntStats>();
  if (directory) {
    for (const name of NSS_FILES) {
      const stat = statIfPresent(join(dir, name));
      if (!stat) continue;
      if (!stat.isFile() || stat.nlink !== 1n || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022n)))) {
        throw new Error("unsafe NSS database file");
      }
      files.set(name, stat);
    }
  }
  return { dir, db: `sql:${dir}`, directory, files };
}

type NssDb = ReturnType<typeof openNssDb>;

function sameDirectory(before: NssDb, after: NssDb): boolean {
  return before.dir === after.dir && before.directory !== undefined && after.directory !== undefined
    && before.directory.ino !== 0n
    && before.directory.dev === after.directory.dev && before.directory.ino === after.directory.ino;
}

function identifyStore(db: NssDb): LinuxPickerTrustStore | undefined {
  const certDb = db.files.get("cert9.db");
  if (!db.directory?.ino || !certDb?.ino) return undefined;
  return { dir: realpathSync(db.dir), directoryId: `${db.directory.dev}:${db.directory.ino}`,
    certDbId: `${certDb.dev}:${certDb.ino}` };
}

function unchanged(db: NssDb, store: LinuxPickerTrustStore | undefined): boolean {
  const current = openNssDb(db.dir);
  return sameDirectory(db, current) && sameLinuxPickerTrustStore(store, identifyStore(current));
}

function resolveNssDb(home?: string, xdgDataHome = home === undefined ? process.env.XDG_DATA_HOME : undefined): NssDb {
  return openNssDb(linuxNssDbDir(home, xdgDataHome));
}

/** certutil runner with a bounded runtime and output, code null when the executable is absent. */
export function createLinuxCertutilRunner(exe: string | null = Bun.which("certutil"), env?: NodeJS.ProcessEnv): LinuxTrustRunner {
  return args => runCertutil(exe, args, env);
}

export const defaultLinuxCertutilRunner: LinuxTrustRunner = args => runCertutil(Bun.which("certutil"), args);

async function runCertutil(exe: string | null, args: readonly string[], env = process.env): Promise<SecurityResult> {
  if (!exe) return { code: null, stdout: "", stderr: MISSING };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([exe, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...env, LC_ALL: "C" } });
    const capture = async (pipe: ReadableStream<Uint8Array>): Promise<string> => {
      const result = await readBoundedResponseBytes(new Response(pipe), { maxBytes: OUTPUT_LIMIT, signal: abort.signal });
      if (result.oversized) throw new Error(LINUX_TRUST_TRUNCATED);
      return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    };
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("certutil timed out")), LINUX_TRUST_TIMEOUT_MS);
      });
      const [stdout, stderr, code] = await Promise.race([
        Promise.all([capture(proc.stdout), capture(proc.stderr), proc.exited]),
        deadline,
      ]);
      return { code, stdout, stderr };
    } catch (error) {
      try { proc.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
      abort.abort(error);
      throw error;
    }
  } catch (error) {
    return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeSha1(value: string): string | null {
  const normalized = value.replace(/[:\s]/g, "").toUpperCase();
  return /^[0-9A-F]{40}$/.test(normalized) ? normalized : null;
}

function missingTool(result: SecurityResult): boolean {
  return result.code === null && result.stderr === MISSING;
}

function certificate(pem: string): X509Certificate | null {
  if (!/^\s*-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*$/.test(pem)) return null;
  try { return new X509Certificate(pem); }
  catch { return null; }
}

type Listing = { kind: "listed"; entries: Map<string, string> } | { kind: "missing_tool" | "failed" };

async function listCertificates(run: LinuxTrustRunner, db: string): Promise<Listing> {
  const result = await run(["-L", "-d", db]);
  if (missingTool(result)) return { kind: "missing_tool" };
  if (result.code !== 0 || result.stderr.trim()) return { kind: "failed" };
  const entries = new Map<string, string>();
  const lines = result.stdout.trim().split(/\r?\n/);
  if (!/^Certificate Nickname\s+Trust Attributes\s*$/.test(lines.shift() ?? "")
    || lines.shift()?.trim() !== "SSL,S/MIME,JAR/XPI") return { kind: "failed" };
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = /^(\S(?:.*\S)?)\s+([A-Za-z]*,[A-Za-z]*,[A-Za-z]*)\s*$/.exec(line);
    if (!match || entries.has(match[1]!)) return { kind: "failed" };
    entries.set(match[1]!, match[2]!);
  }
  return { kind: "listed", entries };
}

async function exportCertificate(run: LinuxTrustRunner, db: NssDb, nickname: string): Promise<X509Certificate | null> {
  const result = await run(["-L", "-d", db.db, "-n", nickname, "-a"]);
  if (result.code !== 0 || result.stderr.trim()) return null;
  const text = result.stdout.trim();
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----/g);
  if (!blocks || text.replace(/-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----/g, "").trim()) return null;
  const certificates = blocks.map(certificate);
  if (certificates.some(cert => cert === null)) return null;
  if (certificates.length === 1) return certificates[0]!;

  // Both -a and -r enumerate the entire subject group. Bind the result to the internal
  // SQL token's exact CKA_LABEL and CKA_VALUE (NSS columns a3 and a11). Read only and
  // fail closed on an unexpected schema, a non-local token or an ambiguous label.
  if (!db.files.has("cert9.db")) return null;
  using sql = new Database(join(db.dir, "cert9.db"), { readonly: true });
  const rows = sql.query<{ der: Uint8Array }, [Buffer, number]>(
    "SELECT a11 AS der FROM nssPublic WHERE a0 = X'00000001' AND a3 = ? AND length(a11) <= ? LIMIT 2",
  ).all(Buffer.from(nickname), OUTPUT_LIMIT);
  return rows.length === 1 ? certificates.find(cert => cert?.raw.equals(rows[0]!.der)) ?? null : null;
}

interface NssEntry { fingerprint: string; flags: string }

async function inventory(run: LinuxTrustRunner, db: NssDb): Promise<Map<string, NssEntry> | null> {
  const start = performance.now();
  const listing = await listCertificates(run, db.db);
  if (listing.kind !== "listed") return null;
  const certs = new Map<string, NssEntry>();
  for (const [nickname, flags] of listing.entries) {
    if (performance.now() - start >= LINUX_TRUST_TIMEOUT_MS) return null;
    const cert = await exportCertificate(run, db, nickname);
    if (!cert) return null;
    certs.set(nickname, { fingerprint: cert.fingerprint256, flags });
  }
  if (performance.now() - start >= LINUX_TRUST_TIMEOUT_MS) return null;
  const after = await listCertificates(run, db.db);
  if (after.kind !== "listed" || after.entries.size !== listing.entries.size) return null;
  for (const [nickname, flags] of listing.entries) {
    if (after.entries.get(nickname) !== flags) return null;
  }
  return certs;
}

export async function inspectPickerTrustLinux(
  caSha1: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  home?: string,
  xdgDataHome?: string,
): Promise<PickerTrustState> {
  const sha1 = normalizeSha1(caSha1);
  if (!sha1) return "untrusted";
  try {
    const selected = resolveNssDb(home, xdgDataHome);
    if (!selected.directory) return "untrusted";
    const store = identifyStore(selected);
    const listing = await listCertificates(run, selected.db);
    if (listing.kind === "missing_tool") return "unsupported";
    if (listing.kind !== "listed") return "unknown";
    for (const nickname of [linuxPickerNickname(sha1), PICKER_CA_COMMON_NAME]) {
      const flags = listing.entries.get(nickname);
      if (flags === undefined) continue;
      const cert = await exportCertificate(run, selected, nickname);
      if (!cert || !unchanged(selected, store)) return "unknown";
      if (normalizeSha1(cert.fingerprint) === sha1) return flags.split(",")[0]!.includes("C") ? "trusted" : "untrusted";
    }
    return "untrusted";
  } catch { // no-excuse-ok: catch -- OS read unavailable or denied; never claim trust.
    return "unknown";
  }
}

export async function trustPickerCaLinux(
  _caPath: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  cert?: { pem?: string },
  home?: string,
  xdgDataHome?: string,
  bindStore?: (store: LinuxPickerTrustStore) => void,
  recordedStore?: LinuxPickerTrustStore,
): Promise<{ ok: boolean; reason?: "unsupported" | "declined_or_failed" }> {
  const failed = { ok: false, reason: "declined_or_failed" } as const;
  let privateDir: string | undefined;
  try {
    const pem = cert?.pem;
    const root = pem && certificate(pem);
    const sha1 = root && normalizeSha1(root.fingerprint);
    if (!pem || !sha1 || !acceptsPickerAuthority(pem)) return failed;
    const selected = resolveNssDb(home, xdgDataHome);
    const tool = await run(["--build-flags"]);
    if (missingTool(tool)) return { ok: false, reason: "unsupported" };
    if (tool.code !== 0) return failed;

    let current = resolveNssDb(home, xdgDataHome);
    if (selected.dir !== current.dir || (selected.directory && !sameDirectory(selected, current))) return failed;
    if (recordedStore && !sameLinuxPickerTrustStore(recordedStore, identifyStore(current))) return failed;
    if (!current.directory) {
      mkdirSync(current.dir, { recursive: true, mode: 0o700 });
      const created = resolveNssDb(home, xdgDataHome);
      if (created.dir !== current.dir || !created.directory) return failed;
      current = created;
    }
    if (!current.files.has("cert9.db")) {
      // Initialize an empty directory only. An incomplete database needs owner intervention.
      if (current.files.size !== 0) return failed;
      const initialized = await run(["-N", "-d", current.db, "--empty-password"]);
      if (initialized.code !== 0) return failed;
      const ready = resolveNssDb(home, xdgDataHome);
      if (!sameDirectory(current, ready)) return failed;
      current = ready;
    }
    const store = identifyStore(current);
    if (!store || !unchanged(current, store)) return failed;
    privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-ca-"));
    const installPath = join(privateDir, "ca.pem");
    writeFileSync(installPath, pem, { mode: 0o600 });
    bindStore?.(store);
    const added = await run(["-A", "-d", current.db, "-n", linuxPickerNickname(sha1), "-t", "C,,", "-a", "-i", installPath]);
    return added.code === 0 && unchanged(current, store) ? { ok: true } : failed;
  } catch { // no-excuse-ok: catch -- directory or command failure is reported.
    return failed;
  } finally {
    if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  }
}

async function removeFromStore(run: LinuxTrustRunner, selected: NssDb, sha1: string, expected: X509Certificate): Promise<boolean> {
  const store = identifyStore(selected);
  const before = await inventory(run, selected);
  if (!before || !unchanged(selected, store)) return false;

  const nickname = linuxPickerNickname(sha1);
  const target = before.get(nickname);
  if (!target) return ![...before.values()].some(cert => cert.fingerprint === expected.fingerprint256);
  if (target.fingerprint !== expected.fingerprint256
    || [...before].some(([name, cert]) => name !== nickname && cert.fingerprint === target.fingerprint)) return false;

  const fresh = await listCertificates(run, selected.db);
  if (fresh.kind !== "listed" || !fresh.entries.has(nickname)) return false;
  const verified = await exportCertificate(run, selected, nickname);
  if (!verified?.raw.equals(expected.raw) || !unchanged(selected, store)) return false;

  // -D resolves the nickname again. Keep the pre-delete check and verify that the exact
  // predecessor is gone and the surviving entries kept their certificate and trust flags.
  const deleted = await run(["-D", "-d", selected.db, "-n", nickname]);
  if (deleted.code !== 0 || !unchanged(selected, store)) return false;
  const after = await inventory(run, selected);
  if (!after || !unchanged(selected, store)
    || [...after.values()].some(cert => cert.fingerprint === expected.fingerprint256)) return false;
  before.delete(nickname);
  return [...before].every(([name, cert]) => {
    const survivor = after.get(name);
    return survivor?.fingerprint === cert.fingerprint && survivor.flags === cert.flags;
  });
}

export async function untrustPickerCaLinux(
  fingerprintSha1: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  home?: string,
  pending?: { pem: string; linuxStore?: LinuxPickerTrustStore },
  xdgDataHome = home === undefined ? process.env.XDG_DATA_HOME : undefined,
): Promise<{ ok: boolean }> {
  const failed = { ok: false };
  const sha1 = normalizeSha1(fingerprintSha1);
  try {
    const expected = pending && certificate(pending.pem);
    if (!sha1 || !pending || !expected || normalizeSha1(expected.fingerprint) !== sha1
      || !acceptsPickerAuthority(pending.pem)) return failed;
    if (pending.linuxStore) {
      const recorded = openNssDb(pending.linuxStore.dir);
      if (!sameLinuxPickerTrustStore(pending.linuxStore, identifyStore(recorded))) return failed;
      return { ok: await removeFromStore(run, recorded, sha1, expected) };
    }

    // Pre-identity records may refer to either Chromium path. Check existing stores
    // even when Chromium now prefers a different one.
    const userHome = home ?? homedir();
    const dirs = new Set([legacyDbDir(userHome), xdgDbDir(userHome), xdgDbDir(userHome, xdgDataHome)]);
    const candidates = [...dirs].map(dir => ({ dir, db: statIfPresent(dir) ? openNssDb(dir) : undefined }));
    for (const { db } of candidates) {
      if (db && !await removeFromStore(run, db, sha1, expected)) return failed;
    }
    return { ok: candidates.every(({ dir, db }) => db ? unchanged(db, identifyStore(db)) : !statIfPresent(dir)) };
  } catch { // no-excuse-ok: catch -- any uncertainty keeps the pending record.
    return failed;
  }
}
