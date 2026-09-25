import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PICKER_CA_COMMON_NAME, PICKER_HOST } from "./picker-ca";

/** Trust is scoped to the current root fingerprint and a verified persisted leaf. */
export type PickerTrustState = "trusted" | "untrusted" | "unsupported" | "unknown";
export interface SecurityResult { code: number | null; stdout: string; stderr: string }
export type SecurityRunner = (args: readonly string[]) => Promise<SecurityResult>;

export const defaultSecurityRunner: SecurityRunner = async args => {
  const child = Bun.spawn(["/usr/bin/security", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, stdout, stderr };
};

export function loginKeychainPath(home = homedir()): string {
  return join(home, "Library", "Keychains", "login.keychain-db");
}

function hasFingerprint(output: string, expected: string): boolean {
  const normalized = expected.replace(/:/g, "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) return false;
  return output.split(/\r?\n/).some(line => {
    const match = /^SHA-1 hash:\s*([0-9a-fA-F:]{40,59})\s*$/.exec(line.trim());
    return !!match && match[1]!.replace(/:/g, "").toUpperCase() === normalized;
  });
}

/**
 * Whether the current CA's user trust settings carry a policy string (a host scope such as the
 * `-s claude.ai` earlier builds used). verify-cert honours those, but Chromium skips them, so
 * Desktop would reject the picker leaf; the CA then counts as untrusted and trust is added again,
 * which replaces the setting. `null` when the settings cannot be read; the caller then reports
 * `unknown`, because arming on a setting Chromium skips would cut Desktop off from claude.ai.
 */
async function hostScopedTrust(caSha1: string, run: SecurityRunner): Promise<boolean | null> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "ocx-picker-trust-"));
    const file = join(dir, "trust-settings.plist");
    if ((await run(["trust-settings-export", file])).code !== 0) return null;
    const xml = readFileSync(file, "utf8");
    const at = xml.indexOf(`<key>${caSha1.replace(/:/g, "").toUpperCase()}</key>`);
    if (at < 0) return false;
    // The entry's trustSettings array holds flat dictionaries, so its first </array> ends it.
    const end = xml.indexOf("</array>", at);
    return xml.slice(at, end < 0 ? undefined : end).includes("<key>kSecTrustSettingsPolicyString</key>");
  } catch { // no-excuse-ok: catch -- unreadable trust settings are no evidence of a host scope.
    return null;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export async function inspectPickerTrust(
  leafPath: string,
  caSha1: string,
  run: SecurityRunner = defaultSecurityRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<PickerTrustState> {
  if (platform !== "darwin") return "unsupported";
  const keychain = loginKeychainPath();
  try {
    const found = await run(["find-certificate", "-a", "-Z", "-c", PICKER_CA_COMMON_NAME, keychain]);
    if (found.code === 1) return "untrusted";
    if (found.code !== 0) return "unknown";
    if (!hasFingerprint(found.stdout, caSha1)) return "untrusted";
    const verified = await run(["verify-cert", "-q", "-L", "-c", leafPath,
      "-p", "ssl", "-n", PICKER_HOST, "-k", keychain]);
    if (verified.code === 0) {
      const scoped = await hostScopedTrust(caSha1, run);
      return scoped === null ? "unknown" : scoped ? "untrusted" : "trusted";
    }
    return verified.code === 1 ? "untrusted" : "unknown";
  } catch { // no-excuse-ok: catch -- OS command unavailable or denied; never claim trust.
    return "unknown";
  }
}

export async function trustPickerCa(
  caPath: string,
  run: SecurityRunner = defaultSecurityRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: boolean; reason?: "unsupported" | "declined_or_failed" }> {
  if (platform !== "darwin") return { ok: false, reason: "unsupported" };
  try {
    // No `-s <host>` policy string: Chromium (Claude Desktop) skips trust settings that carry one,
    // so a host-scoped setting leaves Desktop rejecting the picker leaf. The CA's critical name
    // constraints already limit it to claude.ai; macOS verify-cert rejects any other name.
    const result = await run(["add-trusted-cert", "-r", "trustRoot", "-p", "ssl",
      "-k", loginKeychainPath(), caPath]);
    return result.code === 0 ? { ok: true } : { ok: false, reason: "declined_or_failed" };
  } catch { // no-excuse-ok: catch -- user decline and command failure share a safe result.
    return { ok: false, reason: "declined_or_failed" };
  }
}

export async function untrustPickerCa(
  caPath: string,
  fingerprintSha1: string,
  run: SecurityRunner = defaultSecurityRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: boolean }> {
  if (platform !== "darwin") return { ok: false };
  const keychain = loginKeychainPath();
  // Listed means the current picker CA is in the login keychain; unlisted means nothing to remove,
  // which is success, so a machine that never trusted it never sees a keychain prompt for it.
  const listed = async (): Promise<boolean> => {
    const found = await run(["find-certificate", "-a", "-Z", "-c", PICKER_CA_COMMON_NAME, keychain]);
    if (found.code === 1) return false;
    if (found.code !== 0) throw new Error("find-certificate failed");
    return hasFingerprint(found.stdout, fingerprintSha1);
  };
  try {
    if (!(await listed())) return { ok: true };
    const removed = await run(["remove-trusted-cert", caPath]);
    const deleted = await run(["delete-certificate", "-Z", fingerprintSha1, keychain]);
    return { ok: removed.code === 0 && deleted.code === 0 && !(await listed()) };
  } catch { // no-excuse-ok: catch -- failed removal must be visible to the caller.
    return { ok: false };
  }
}
