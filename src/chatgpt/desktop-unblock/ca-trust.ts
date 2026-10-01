import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSecurityRunner, loginKeychainPath, type SecurityRunner } from "../../claude/intercept/picker-trust";

/**
 * Whether macOS trusts the intercept CA the ChatGPT listener's leaf is issued from.
 *
 * Without that trust every request the app sends to chatgpt.com fails certificate
 * verification, which the app does not report: account, usage and settings pages just stay
 * empty. `ocx chatgpt status` surfaces this state so the cause is visible. Trust is matched by
 * the CA's SHA-1 fingerprint in the user's exported trust settings, so a different or
 * regenerated certificate with the same name never counts.
 */

export type ChatgptCaTrust = "trusted" | "untrusted" | "missing" | "unknown" | "unsupported";

export function certificateSha1(pem: string): string {
  return new X509Certificate(pem).fingerprint.replace(/:/g, "").toUpperCase();
}

export async function inspectChatgptCaTrust(
  caPath: string,
  run: SecurityRunner = defaultSecurityRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<ChatgptCaTrust> {
  if (platform !== "darwin") return "unsupported";
  if (!existsSync(caPath)) return "missing";
  let dir: string | undefined;
  try {
    const sha1 = certificateSha1(readFileSync(caPath, "utf8"));
    dir = mkdtempSync(join(tmpdir(), "ocx-chatgpt-trust-"));
    const file = join(dir, "trust-settings.plist");
    const exported = await run(["trust-settings-export", file]);
    if (exported.code !== 0) {
      // A user domain with no trust settings at all cannot be exported; that is plain "untrusted".
      return /no trust settings/i.test(`${exported.stdout}${exported.stderr}`) ? "untrusted" : "unknown";
    }
    return readFileSync(file, "utf8").includes(`<key>${sha1}</key>`) ? "trusted" : "untrusted";
  } catch { // no-excuse-ok: catch -- unreadable certificate or trust settings are no evidence of trust.
    return "unknown";
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** The command that restores trust; it prompts for the login password, so only the user runs it. */
export function chatgptCaTrustCommand(caPath: string): string {
  return `security add-trusted-cert -r trustRoot -p ssl -k "${loginKeychainPath()}" "${caPath}"`;
}
