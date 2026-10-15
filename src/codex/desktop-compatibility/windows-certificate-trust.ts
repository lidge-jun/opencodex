import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import type { StoredDesktopAuthority } from "./certificate-store";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import { isServerAuthOnlyCertificate } from "../../claude/intercept/local-ca";

export type DesktopCertificateTrust = "trusted" | "not-trusted" | "unknown";
export type TrustOperation = "inspect" | "trust" | "remove";
export type CertificateTrustRunner = (operation: TrustOperation, certificateDer: string, fingerprint: string) => Promise<DesktopCertificateTrust>;

const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json",
  "$bytes=[Convert]::FromBase64String($inputData.certificate)",
  "$cert=[Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)",
  "$sha=[Security.Cryptography.SHA256]::Create()",
  "try {$fingerprint=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','')}finally{$sha.Dispose()}",
  "if($fingerprint -cne $inputData.fingerprint){throw 'Certificate changed'}",
  "$store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')",
  "$mode=if($inputData.operation -eq 'inspect'){[Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly}else{[Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite}",
  "try {",
  " $store.Open($mode)",
  " $foundCertificates=@($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,$cert.Thumbprint,$false))",
  " foreach($certificateMatch in $foundCertificates){if([Convert]::ToBase64String($certificateMatch.RawData) -cne [Convert]::ToBase64String($bytes)){throw 'Certificate mismatch'}}",
  " if($inputData.operation -eq 'trust'){if($foundCertificates.Count -eq 0){$store.Add($cert)}}",
  " elseif($inputData.operation -eq 'remove'){foreach($certificateMatch in $foundCertificates){$store.Remove($certificateMatch)}}",
  " elseif($inputData.operation -ne 'inspect'){throw 'Unknown operation'}",
  " $present=@($store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,$cert.Thumbprint,$false)).Count -gt 0",
  " if($present){[Console]::Out.Write('trusted')}else{[Console]::Out.Write('not-trusted')}",
  "}finally{$store.Close();$store.Dispose();$cert.Dispose()}",
].join("\n");

const run: CertificateTrustRunner = (operation, certificateDer, fingerprint) => {
  if (process.platform !== "win32") return Promise.resolve("unknown");
  if (operation !== "inspect" && isTestHomeGuardArmed()) return Promise.resolve("unknown");
  return new Promise(resolve => {
    const child = execFile(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
      timeout: operation === "inspect" ? 10_000 : 120_000, maxBuffer: 4096, windowsHide: true, encoding: "utf8",
    }, (error, stdout) => resolve(!error && (stdout.trim() === "trusted" || stdout.trim() === "not-trusted")
      ? stdout.trim() as DesktopCertificateTrust : "unknown"));
    child.stdin?.on("error", () => { /* completion and readback decide the result */ });
    child.stdin?.end(JSON.stringify({ operation, certificate: certificateDer, fingerprint }));
  });
};

/** Public status cannot create a certificate, decrypt a key or alter OS trust. */
export async function inspectWindowsCertificateTrust(certPem: string, expectedFingerprint: string, runner: CertificateTrustRunner = run): Promise<DesktopCertificateTrust> {
  const certificate = new X509Certificate(certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(":", "");
  if (!certificate.ca || fingerprint !== expectedFingerprint || !/^[A-F0-9]{64}$/.test(expectedFingerprint)) {
    throw new Error("desktop_compatibility_certificate_mismatch");
  }
  return runner("inspect", certificate.raw.toString("base64"), fingerprint).catch(() => "unknown" as const);
}

/** Mutations require the store-validated private key, not unverified public status metadata. */
export function createWindowsCertificateTrust(authority: StoredDesktopAuthority, expectedFingerprint: string, runner: CertificateTrustRunner = run) {
  const certificate = new X509Certificate(authority.authority.certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(":", "");
  if (fingerprint !== expectedFingerprint || !certificate.ca || !certificate.checkPrivateKey(authority.authority.privateKey)
    || !certificate.verify(authority.authority.publicKey) || !/^OpenCodex Codex Desktop [0-9a-f-]{36}$/.test(authority.commonName)
    || !certificate.subject.split("\n").includes(`CN=${authority.commonName}`)) throw new Error("desktop_compatibility_certificate_mismatch");
  const encoded = certificate.raw.toString("base64");
  const inspect = () => runner("inspect", encoded, fingerprint).catch(() => "unknown" as const);
  let pending: Promise<DesktopCertificateTrust> | null = null;
  const change = (operation: "trust" | "remove") => {
    if (pending) return Promise.reject(new Error("desktop_compatibility_trust_busy"));
    if (operation === "trust" && Date.parse(certificate.validTo) <= Date.now()) return Promise.reject(new Error("desktop_compatibility_authority_expired"));
    if (operation === "trust" && !isServerAuthOnlyCertificate(certificate)) return Promise.reject(new Error("desktop_compatibility_authority_renewal_required"));
    pending = (async () => {
      const before = await inspect();
      if (before === "unknown") return before;
      if (before === (operation === "trust" ? "trusted" : "not-trusted")) return before;
      try { await runner(operation, encoded, fingerprint); } catch { /* read the exact store after an uncertain action */ }
      return inspect();
    })().finally(() => { pending = null; });
    return pending;
  };
  return { inspect, trust: () => change("trust"), remove: () => change("remove") };
}
