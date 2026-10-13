import { execFile } from "node:child_process";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";

const MAX_INPUT = 65_536;
const MAX_OUTPUT = 131_072;
const PURPOSE = "opencodex/codex-desktop-compatibility/authority/v1";
const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$r=[Console]::In.ReadToEnd()|ConvertFrom-Json",
  "$data=[Convert]::FromBase64String($r.data)",
  `if($data.Length -eq 0 -or $data.Length -gt ${MAX_INPUT}){throw 'Invalid data size'}`,
  `$entropy=[Text.Encoding]::UTF8.GetBytes('${PURPOSE}')`,
  "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if($r.operation -eq 'protect'){",
  " $out=[Security.Cryptography.ProtectedData]::Protect($data,$entropy,$scope)",
  "}elseif($r.operation -eq 'unprotect'){",
  " $out=[Security.Cryptography.ProtectedData]::Unprotect($data,$entropy,$scope)",
  "}else{throw 'Invalid operation'}",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("\n");

export interface AuthorityKeyProtection {
  protect(cleartext: Uint8Array): Promise<Uint8Array>;
  unprotect(ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** The payload travels on stdin, never in process arguments, environment or logs. */
function runDpapi(operation: "protect" | "unprotect", data: Uint8Array): Promise<Uint8Array> {
  if (process.platform !== "win32") return Promise.reject(new Error("desktop_compatibility_windows_required"));
  if (data.byteLength === 0 || data.byteLength > MAX_INPUT) return Promise.reject(new Error("desktop_compatibility_key_size"));
  return new Promise((resolve, reject) => {
    const child = execFile(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      timeout: 10_000, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8",
    }, (error, stdout) => {
      // Do not include PowerShell stderr, command output or the input in a propagated error.
      if (error || !/^[A-Za-z0-9+/]+={0,2}$/.test(stdout.trim())) {
        reject(new Error("desktop_compatibility_key_protection_failed")); return;
      }
      const bytes = Buffer.from(stdout.trim(), "base64");
      if (bytes.length === 0 || bytes.length > MAX_INPUT) {
        reject(new Error("desktop_compatibility_key_size")); return;
      }
      resolve(bytes);
    });
    child.stdin?.on("error", () => { /* execFile's completion reports the failed child. */ });
    child.stdin?.end(JSON.stringify({ operation, data: Buffer.from(data).toString("base64") }));
  });
}

/** CurrentUser protects against other OS identities, not other processes of the same user. */
export const windowsAuthorityKeyProtection: AuthorityKeyProtection = {
  protect: bytes => runDpapi("protect", bytes),
  unprotect: bytes => runDpapi("unprotect", bytes),
};
