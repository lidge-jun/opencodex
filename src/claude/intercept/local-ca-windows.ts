/** Strict local-CA policy layered on the shared Windows ACL hardener. */
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import { resolveCurrentWindowsPrincipal, WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS } from "../../lib/windows-user-principal";
import type { IcaclsResult } from "../../lib/windows-secret-acl";

type AclRunner = (path: string, timeoutMs: number) => IcaclsResult;
const MAX_ACL_BYTES = 64 * 1024;
const SID = /^S-1-(?:\d+-)+\d+$/i;

function nativeAclRunner(path: string, timeoutMs: number): IcaclsResult {
  // Encode the path as data, not PowerShell syntax. SID-form rules avoid localized account names.
  // .NET only: Get-Acl/ConvertTo-Json/ForEach-Object are module-autoloaded cmdlets, and
  // autoload resolves them through the per-profile module analysis cache. With a fresh or
  // redirected LOCALAPPDATA that rebuild scans every PSModulePath module and can exceed the
  // inspection budget (hosted Windows runners: 30 s timeouts during `ocx start`); it also lets
  // a module earlier on PSModulePath shadow the cmdlet. SIDs, ints and booleans need no escaping;
  // the JSON quote is [char]34 so the -Command argument carries no double quotes to re-parse.
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$s=[System.Security.Principal.SecurityIdentifier]",
    "$q=[char]34",
    "$c=[System.Security.AccessControl.AccessControlSections]'Owner,Access'",
    "if([System.IO.Directory]::Exists($p)){$a=[System.Security.AccessControl.DirectorySecurity]::new($p,$c)}else{$a=[System.Security.AccessControl.FileSecurity]::new($p,$c)}",
    "$r=foreach($x in $a.GetAccessRules($true,$true,$s)){'{'+$q+'sid'+$q+':'+$q+$x.IdentityReference.Value+$q+','+$q+'type'+$q+':'+[int]$x.AccessControlType+','+$q+'rights'+$q+':'+[long]$x.FileSystemRights+'}'}",
    "$o='{'+$q+'owner'+$q+':'+$q+$a.GetOwner($s).Value+$q+','+$q+'protected'+$q+':'+$(if($a.AreAccessRulesProtected){'true'}else{'false'})+','+$q+'rules'+$q+':['+(@($r) -join ',')+']}'",
    "[Console]::Out.Write($o)",
    "[Console]::Out.Flush()",
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
