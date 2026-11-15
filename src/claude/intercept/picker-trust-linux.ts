import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PICKER_CA_COMMON_NAME } from "./picker-ca";
import type { PickerTrustState, SecurityResult } from "./picker-trust";

/**
 * certutil argv runner. Chromium on Linux (and therefore Claude Desktop) reads the user's NSS
 * database, not the system CA bundle, so trust lives in `~/.pki/nssdb` and needs no root.
 */
export type LinuxTrustRunner = (args: readonly string[]) => Promise<SecurityResult>;

export const LINUX_TRUST_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 256 * 1024;
const MISSING = "certutil_missing";

export function linuxNssDbDir(home = homedir()): string {
  return join(home, ".pki", "nssdb");
}

/**
 * One nickname per root: certutil deletes by nickname, so a shared nickname would let the removal
 * of a rotated-out root delete the current one if it was installed in between.
 */
export function linuxPickerNickname(sha1: string): string {
  return `${PICKER_CA_COMMON_NAME} ${sha1}`;
}

function nssDb(home?: string): string {
  return `sql:${linuxNssDbDir(home)}`;
}

/** Production runner: certutil from PATH (libnss3-tools / nss-tools), bounded runtime, code null when absent. */
export const defaultLinuxCertutilRunner: LinuxTrustRunner = async args => {
  const exe = Bun.which("certutil");
  if (!exe) return { code: null, stdout: "", stderr: MISSING };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([exe, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const pending = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const settled = await new Promise<[string, string, number] | null>((resolve, reject) => {
      timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } resolve(null); }, LINUX_TRUST_TIMEOUT_MS);
      pending.then(resolve, reject);
    });
    if (settled === null) return { code: null, stdout: "", stderr: "certutil timed out" };
    const [stdout, stderr, code] = settled;
    return { code, stdout: stdout.slice(-OUTPUT_LIMIT), stderr: stderr.slice(-OUTPUT_LIMIT) };
  } catch (error) {
    return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

function normalizeSha1(value: string): string | null {
  const normalized = value.replace(/[:\s]/g, "").toUpperCase();
  return /^[0-9A-F]{40}$/.test(normalized) ? normalized : null;
}

function missingTool(result: SecurityResult): boolean {
  return result.code === null && result.stderr === MISSING;
}

/** SSL trust flags of `nickname` in a full `certutil -L` listing, or null when it is not listed. */
function sslTrustFlags(listing: string, nickname: string): string | null {
  for (const line of listing.split(/\r?\n/)) {
    const match = /^(.*\S)\s+([A-Za-z]*),([A-Za-z]*),([A-Za-z]*)\s*$/.exec(line);
    if (match && match[1] === nickname) return match[2]!;
  }
  return null;
}

function pemSha1(pem: string): string | null {
  const block = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(pem)?.[0];
  if (!block) return null;
  try { return createHash("sha1").update(new X509Certificate(block).raw).digest("hex").toUpperCase(); }
  catch { return null; }
}

type Lookup =
  | { kind: "absent" }
  | { kind: "present"; nickname: string; flags: string }
  | { kind: "foreign" }
  | { kind: "missing_tool" }
  | { kind: "failed" };

/**
 * Absence is concluded only from a successful read of the whole database: certutil also exits
 * 255 when the database cannot be opened, so a failed nickname lookup proves nothing.
 */
async function lookup(run: LinuxTrustRunner, sha1: string, home?: string): Promise<Lookup> {
  const all = await run(["-L", "-d", nssDb(home)]);
  if (missingTool(all)) return { kind: "missing_tool" };
  if (all.code !== 0) return { kind: "failed" };
  let foreign = false;
  // The bare common name is the nickname an earlier build used; it still counts when it holds this root.
  for (const nickname of [linuxPickerNickname(sha1), PICKER_CA_COMMON_NAME]) {
    const flags = sslTrustFlags(all.stdout, nickname);
    if (flags === null) continue;
    const cert = await run(["-L", "-d", nssDb(home), "-n", nickname, "-a"]);
    if (cert.code !== 0) return { kind: "failed" };
    if (pemSha1(cert.stdout) === sha1) return { kind: "present", nickname, flags };
    foreign ||= nickname !== PICKER_CA_COMMON_NAME;
  }
  return foreign ? { kind: "foreign" } : { kind: "absent" };
}

/**
 * Trusted means the current root is in the NSS database under its own nickname with the SSL `C`
 * flag. The CA's critical name constraints keep that trust limited to claude.ai.
 */
export async function inspectPickerTrustLinux(
  caSha1: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  home?: string,
): Promise<PickerTrustState> {
  const sha1 = normalizeSha1(caSha1);
  if (!sha1) return "untrusted";
  if (!existsSync(linuxNssDbDir(home))) return "untrusted";
  try {
    const found = await lookup(run, sha1, home);
    switch (found.kind) {
      case "missing_tool": return "unsupported";
      case "failed": return "unknown";
      case "present": return found.flags.includes("C") ? "trusted" : "untrusted";
      default: return "untrusted";
    }
  } catch { // no-excuse-ok: catch -- certutil unavailable or denied; never claim trust.
    return "unknown";
  }
}

export async function trustPickerCaLinux(
  caPath: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  cert?: { pem?: string },
  home?: string,
): Promise<{ ok: boolean; reason?: "unsupported" | "declined_or_failed" }> {
  // Same rule as macOS: install the caller-verified bytes from a private copy, never the shared ca.pem.
  let installPath = caPath;
  let privateDir: string | undefined;
  try {
    const pem = cert?.pem;
    const sha1 = pemSha1(pem ?? "");
    if (pem === undefined || sha1 === null) return { ok: false, reason: "declined_or_failed" };
    privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-ca-"));
    installPath = join(privateDir, "ca.pem");
    writeFileSync(installPath, pem, { mode: 0o600 });
    const dir = linuxNssDbDir(home);
    if (!existsSync(join(dir, "cert9.db"))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const created = await run(["-N", "-d", nssDb(home), "--empty-password"]);
      if (missingTool(created)) return { ok: false, reason: "unsupported" };
      if (created.code !== 0) return { ok: false, reason: "declined_or_failed" };
    }
    const added = await run(["-A", "-d", nssDb(home), "-n", linuxPickerNickname(sha1), "-t", "C,,", "-a", "-i", installPath]);
    if (missingTool(added)) return { ok: false, reason: "unsupported" };
    return added.code === 0 ? { ok: true } : { ok: false, reason: "declined_or_failed" };
  } catch { // no-excuse-ok: catch -- command failure is reported, never trust.
    return { ok: false, reason: "declined_or_failed" };
  } finally {
    if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  }
}

export async function untrustPickerCaLinux(
  fingerprintSha1: string,
  run: LinuxTrustRunner = defaultLinuxCertutilRunner,
  home?: string,
): Promise<{ ok: boolean }> {
  const sha1 = normalizeSha1(fingerprintSha1);
  if (!sha1) return { ok: false };
  if (!existsSync(linuxNssDbDir(home))) return { ok: true };
  try {
    const before = await lookup(run, sha1, home);
    if (before.kind === "absent") return { ok: true };
    // A foreign certificate under this nickname is not ours to delete; failed reads prove nothing.
    if (before.kind !== "present") return { ok: false };
    const deleted = await run(["-D", "-d", nssDb(home), "-n", before.nickname]);
    if (deleted.code !== 0) return { ok: false };
    return { ok: (await lookup(run, sha1, home)).kind === "absent" };
  } catch { // no-excuse-ok: catch -- failed removal must be visible to the caller.
    return { ok: false };
  }
}
