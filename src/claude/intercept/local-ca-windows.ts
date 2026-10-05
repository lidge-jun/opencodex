/** Strict local-CA policy layered on the shared Windows ACL hardener. */
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { resolveCurrentWindowsPrincipal, WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS } from "../../lib/windows-user-principal";
import type { IcaclsResult } from "../../lib/windows-secret-acl";

type AclRunner = (path: string, timeoutMs: number) => IcaclsResult;
const MAX_ACL_BYTES = 64 * 1024;
const SID = /^S-1-(?:\d+-)+\d+$/i;

function nativeAclRunner(path: string, timeoutMs: number): IcaclsResult {
  // Encode the path as data, not PowerShell syntax. SID-form rules avoid localized account names.
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$a=Get-Acl -LiteralPath $p",
    "$s=[System.Security.Principal.SecurityIdentifier]",
    "$r=@($a.GetAccessRules($true,$true,$s)|ForEach-Object {@{sid=$_.IdentityReference.Value;type=[int]$_.AccessControlType;rights=[long]$_.FileSystemRights}})",
    "@{owner=$a.GetOwner($s).Value;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Depth 4 -Compress",
  ].join(";");
  const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, windowsHide: true,
  });
  return { success: result.success, exitCode: result.exitCode, timedOut: result.exitedDueToTimeout ?? false, stdout: result.stdout.toString("utf8") };
}

let aclRunner: AclRunner = nativeAclRunner;
/** Native-result fault injection; production always uses the trusted bounded runner. */
export function setLocalCaWindowsAclRunnerForTests(next: AclRunner | null): void {
  aclRunner = next ?? nativeAclRunner;
}

export function assertLocalCaWindowsAcl(path: string, inspection: "owner" | "private" | "inherited" = "private"): void {
  try {
    const deadline = Date.now() + WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS;
    const current = resolveCurrentWindowsPrincipal(deadline - Date.now()).replace(/^\*/, "").toUpperCase();
    if (!SID.test(current)) throw new Error("invalid effective SID");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("ACL inspection deadline");
    const result = aclRunner(path, remaining);
    if (!result.success || result.timedOut || result.exitCode !== 0 || Buffer.byteLength(result.stdout) > MAX_ACL_BYTES) throw new Error("ACL inspection failed");
    const acl: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    if (!acl || typeof acl !== "object" || !("owner" in acl) || !("protected" in acl) || !("rules" in acl)
      || typeof acl.owner !== "string" || acl.owner.toUpperCase() !== current
      || typeof acl.protected !== "boolean" || !Array.isArray(acl.rules)) throw new Error("unsafe ACL owner or shape");
    // Newly created empty entries can inherit broad grants. Verify the owner
    // before hardening, then require the complete private policy before use.
    if (inspection === "owner") return;
    if (inspection === "private" && !acl.protected) throw new Error("unprotected DACL");
    const allowed = new Set([current, "S-1-5-18", "S-1-5-32-544"]);
    if (acl.rules.length === 0) throw new Error("empty DACL");
    for (const rule of acl.rules) {
      if (!rule || typeof rule !== "object" || typeof rule.sid !== "string" || !SID.test(rule.sid)
        || ![0, 1].includes(rule.type) || !Number.isSafeInteger(rule.rights) || rule.rights < 0 || rule.rights > 0xffffffff) throw new Error("ambiguous ACL rule");
      // Reject every unexpected nonzero Allow ACE, including inherited and tamper-only grants.
      // Deny ACEs confer no access. SYSTEM and built-in Administrators are the only exceptions.
      if (rule.type === 0 && rule.rights !== 0 && !allowed.has(rule.sid.toUpperCase())) throw new Error("unexpected ACL principal");
    }
  } catch {
    // Never expose path, raw ACL output, account names or native diagnostic text.
    throw Object.assign(new Error("Local CA Windows owner/ACL inspection failed"), { code: "local_ca_path_unsafe" });
  }
}
