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
/** certutil's own exit code when the nickname is absent from the database. */
const NOT_FOUND = 255;
const OUTPUT_LIMIT = 256 * 1024;
const MAX_DELETIONS = 8;

export function linuxNssDbDir(home = homedir()): string {
  return join(home, ".pki", "nssdb");
}

function nssDb(home?: string): string {
  return `sql:${linuxNssDbDir(home)}`;
}

/** Production runner: certutil from PATH (libnss3-tools / nss-tools), bounded runtime, code null when absent. */
export const defaultLinuxCertutilRunner: LinuxTrustRunner = async args => {
  const exe = Bun.which("certutil");
  if (!exe) return { code: null, stdout: "", stderr: "certutil_missing" };
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

/** SHA-1 of every PEM block certutil printed for the picker nickname. */
function listedSha1s(pemOutput: string): string[] {
  const blocks = pemOutput.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const out: string[] = [];
  for (const block of blocks) {
    try { out.push(createHash("sha1").update(new X509Certificate(block).raw).digest("hex").toUpperCase()); }
    catch { /* an unparsable block proves nothing */ }
  }
  return out;
}

/** The SSL trust flags of the picker nickname: the first comma field of `certutil -L`. */
function sslTrustFlags(listing: string): string[] {
  const flags: string[] = [];
  for (const line of listing.split(/\r?\n/)) {
    const match = /^(.*\S)\s+([A-Za-z]*),([A-Za-z]*),([A-Za-z]*)\s*$/.exec(line);
    if (match && match[1] === PICKER_CA_COMMON_NAME) flags.push(match[2]!);
  }
  return flags;
}

async function listed(run: LinuxTrustRunner, sha1: string, home?: string): Promise<boolean> {
  const found = await run(["-L", "-d", nssDb(home), "-n", PICKER_CA_COMMON_NAME, "-a"]);
  if (found.code === NOT_FOUND) return false;
  if (found.code !== 0) throw new Error("certutil_list_failed");
  return listedSha1s(found.stdout).includes(sha1);
}

/**
 * Trusted means the current root is in the NSS database under the picker nickname with the
 * SSL `C` flag. The CA's critical name constraints keep that trust limited to claude.ai.
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
    const found = await run(["-L", "-d", nssDb(home), "-n", PICKER_CA_COMMON_NAME, "-a"]);
    if (found.code === null && found.stderr === "certutil_missing") return "unsupported";
    if (found.code === NOT_FOUND) return "untrusted";
    if (found.code !== 0) return "unknown";
    if (!listedSha1s(found.stdout).includes(sha1)) return "untrusted";
    const all = await run(["-L", "-d", nssDb(home)]);
    if (all.code !== 0) return "unknown";
    // Several picker roots may share the nickname; every one must carry C, or the current one may not.
    const flags = sslTrustFlags(all.stdout);
    return flags.length > 0 && flags.every(value => value.includes("C")) ? "trusted" : "untrusted";
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
    if (cert?.pem !== undefined) {
      privateDir = mkdtempSync(join(tmpdir(), "ocx-picker-ca-"));
      installPath = join(privateDir, "ca.pem");
      writeFileSync(installPath, cert.pem, { mode: 0o600 });
    }
    const dir = linuxNssDbDir(home);
    if (!existsSync(join(dir, "cert9.db"))) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const created = await run(["-N", "-d", nssDb(home), "--empty-password"]);
      if (created.code === null && created.stderr === "certutil_missing") return { ok: false, reason: "unsupported" };
      if (created.code !== 0) return { ok: false, reason: "declined_or_failed" };
    }
    const added = await run(["-A", "-d", nssDb(home), "-n", PICKER_CA_COMMON_NAME, "-t", "C,,", "-a", "-i", installPath]);
    if (added.code === null && added.stderr === "certutil_missing") return { ok: false, reason: "unsupported" };
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
    // certutil -D removes one certificate per nickname, so repeat until the current root is gone.
    for (let i = 0; i < MAX_DELETIONS; i += 1) {
      if (!(await listed(run, sha1, home))) return { ok: true };
      const deleted = await run(["-D", "-d", nssDb(home), "-n", PICKER_CA_COMMON_NAME]);
      if (deleted.code !== 0) return { ok: false };
    }
    return { ok: !(await listed(run, sha1, home)) };
  } catch { // no-excuse-ok: catch -- failed removal must be visible to the caller.
    return { ok: false };
  }
}
