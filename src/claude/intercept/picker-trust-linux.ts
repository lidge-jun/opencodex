import { X509Certificate } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { acceptsPickerAuthority, PICKER_CA_COMMON_NAME } from "./picker-ca";
import type { PickerTrustState, SecurityResult } from "./picker-trust";

export type LinuxTrustRunner = (args: readonly string[]) => Promise<SecurityResult>;

export const LINUX_TRUST_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const LINUX_TRUST_TRUNCATED = "certutil_output_truncated";
const MISSING = "certutil_missing";
const NSS_FILES = ["cert9.db", "key4.db", "pkcs11.txt", "cert8.db", "key3.db", "secmod.db",
  ...["cert9.db", "key4.db"].flatMap(db => ["-journal", "-shm", "-wal"].map(suffix => db + suffix))];

function statIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

export function linuxNssDbDir(home = homedir(), xdgDataHome?: string): string {
  // Chromium crypto/nss_util.cc:GetDefaultNSSConfigDirectory prefers an existing legacy
  // directory, then uses ${XDG_DATA_HOME:-$HOME/.local/share}/pki/nssdb.
  // https://chromium.googlesource.com/chromium/src/+/main/crypto/nss_util.cc
  if (!isAbsolute(home) || home.split(sep).includes("..")) throw new Error("unsafe NSS home");
  const legacy = join(home, ".pki", "nssdb");
  const stat = statIfPresent(legacy);
  // A legacy symlink may be Chromium's active store. Select it so the safety check refuses it.
  if (stat?.isDirectory() || stat?.isSymbolicLink()) return legacy;
  const data = xdgDataHome || join(home, ".local", "share");
  if (!isAbsolute(data) || data.split(sep).includes("..")) throw new Error("unsafe NSS data home");
  return join(data, "pki", "nssdb");
}

export function linuxPickerNickname(sha1: string): string {
  return `${PICKER_CA_COMMON_NAME} ${sha1}`;
}

/** Check ancestors as well, since a writable parent can replace a safe directory. */
function safeDirectory(path: string, database: boolean, uid: number | undefined): Stats | undefined {
  const parent = dirname(path);
  if (parent !== path) safeDirectory(parent, false, uid);
  const stat = statIfPresent(path);
  if (!stat) return undefined;
  if (!database && uid !== undefined && stat.uid === 0 && stat.isSymbolicLink()) {
    // Trusted system aliases (for example /var) may lead to an otherwise safe ancestor.
    return safeDirectory(realpathSync(path), false, uid);
  }
  if (!stat.isDirectory() || (uid !== undefined && (
    (stat.uid !== uid && (database || stat.uid !== 0))
    || ((stat.mode & 0o022) !== 0 && (database || (stat.mode & 0o1000) === 0))
  ))) throw new Error("unsafe NSS directory");
  return stat;
}

function resolveNssDb(home?: string, xdgDataHome = home === undefined ? process.env.XDG_DATA_HOME : undefined) {
  const dir = linuxNssDbDir(home, xdgDataHome);
  const uid = process.platform === "win32" ? undefined : process.getuid!();
  const directory = safeDirectory(dir, true, uid);
  const files = new Set<string>();
  if (directory) {
    for (const name of NSS_FILES) {
      const stat = statIfPresent(join(dir, name));
      if (!stat) continue;
      if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022)))) {
        throw new Error("unsafe NSS database file");
      }
      files.add(name);
    }
  }
  return { dir, db: `sql:${dir}`, directory, files };
}

type NssDb = ReturnType<typeof resolveNssDb>;

function sameDirectory(before: NssDb, after: NssDb): boolean {
  return before.dir === after.dir && before.directory !== undefined && after.directory !== undefined
    && before.directory.dev === after.directory.dev && before.directory.ino === after.directory.ino;
}

/** certutil runner with a bounded runtime and output, code null when the executable is absent. */
export function createLinuxCertutilRunner(exe: string | null = Bun.which("certutil")): LinuxTrustRunner {
  return args => runCertutil(exe, args);
}

export const defaultLinuxCertutilRunner: LinuxTrustRunner = args => runCertutil(Bun.which("certutil"), args);

async function runCertutil(exe: string | null, args: readonly string[]): Promise<SecurityResult> {
  if (!exe) return { code: null, stdout: "", stderr: MISSING };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([exe, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, LC_ALL: "C" } });
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
    const match = /^(\S(?:.*\S)?)\s+([A-Za-z]*),[A-Za-z]*,[A-Za-z]*\s*$/.exec(line);
    if (!match || entries.has(match[1]!)) return { kind: "failed" };
    entries.set(match[1]!, match[2]!);
  }
  return { kind: "listed", entries };
}

async function exportCertificate(run: LinuxTrustRunner, db: string, nickname: string): Promise<X509Certificate | null> {
  const result = await run(["-L", "-d", db, "-n", nickname, "-a"]);
  // NSS can emit multiple PEMs for one subject. That export cannot identify what -D would pick.
  return result.code === 0 && !result.stderr.trim() ? certificate(result.stdout) : null;
}

async function inventory(run: LinuxTrustRunner, db: string): Promise<Map<string, string> | null> {
  const start = performance.now();
  const listing = await listCertificates(run, db);
  if (listing.kind !== "listed") return null;
  const certs = new Map<string, string>();
  for (const nickname of listing.entries.keys()) {
    if (performance.now() - start >= LINUX_TRUST_TIMEOUT_MS) return null;
    const cert = await exportCertificate(run, db, nickname);
    if (!cert) return null;
    certs.set(nickname, cert.fingerprint256);
  }
  if (performance.now() - start >= LINUX_TRUST_TIMEOUT_MS) return null;
  const after = await listCertificates(run, db);
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
    const { db, directory } = resolveNssDb(home, xdgDataHome);
    if (!directory) return "untrusted";
    const listing = await listCertificates(run, db);
    if (listing.kind === "missing_tool") return "unsupported";
    if (listing.kind !== "listed") return "unknown";
    for (const nickname of [linuxPickerNickname(sha1), PICKER_CA_COMMON_NAME]) {
      const flags = listing.entries.get(nickname);
      if (flags === undefined) continue;
      const cert = await exportCertificate(run, db, nickname);
      if (!cert) return "unknown";
      if (normalizeSha1(cert.fingerprint) === sha1) return flags.includes("C") ? "trusted" : "untrusted";
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
      if (!sameDirectory(current, resolveNssDb(home, xdgDataHome))) return failed;
    }
    privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-ca-"));
    const installPath = join(privateDir, "ca.pem");
    writeFileSync(installPath, pem, { mode: 0o600 });
    const added = await run(["-A", "-d", current.db, "-n", linuxPickerNickname(sha1), "-t", "C,,", "-a", "-i", installPath]);
    return added.code === 0 ? { ok: true } : failed;
  } catch { // no-excuse-ok: catch -- directory or command failure is reported.
    return failed;
  } finally {
    if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  }
}

export async function untrustPickerCaLinux(
  fingerprintSha1: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  home?: string,
  pending?: { pem: string },
  xdgDataHome?: string,
): Promise<{ ok: boolean }> {
  const failed = { ok: false };
  const sha1 = normalizeSha1(fingerprintSha1);
  try {
    const expected = pending && certificate(pending.pem);
    if (!sha1 || !pending || !expected || normalizeSha1(expected.fingerprint) !== sha1
      || !acceptsPickerAuthority(pending.pem)) return failed;
    const selected = resolveNssDb(home, xdgDataHome);
    if (!selected.directory) return { ok: true };
    const before = await inventory(run, selected.db);
    if (!before || !sameDirectory(selected, resolveNssDb(home, xdgDataHome))) return failed;

    const nickname = linuxPickerNickname(sha1);
    const target = before.get(nickname);
    if (target === undefined) return { ok: ![...before.values()].includes(expected.fingerprint256) };
    if (target !== expected.fingerprint256
      || [...before].some(([name, der]) => name !== nickname && der === target)) return failed;

    const fresh = await listCertificates(run, selected.db);
    if (fresh.kind !== "listed" || !fresh.entries.has(nickname)) return failed;
    const verified = await exportCertificate(run, selected.db, nickname);
    if (!verified?.raw.equals(expected.raw) || !sameDirectory(selected, resolveNssDb(home, xdgDataHome))) return failed;

    // certutil -D resolves a nickname again and has no DER-qualified delete. A same-user writer
    // can still race this check. Avoid shared aliases and verify identity and survivors afterward.
    const deleted = await run(["-D", "-d", selected.db, "-n", nickname]);
    if (deleted.code !== 0 || !sameDirectory(selected, resolveNssDb(home, xdgDataHome))) return failed;
    const after = await inventory(run, selected.db);
    if (!after || !sameDirectory(selected, resolveNssDb(home, xdgDataHome))
      || [...after.values()].includes(expected.fingerprint256)) return failed;
    before.delete(nickname);
    return { ok: [...before].every(([name, der]) => after.get(name) === der) };
  } catch { // no-excuse-ok: catch -- any uncertainty keeps the pending record.
    return failed;
  }
}
