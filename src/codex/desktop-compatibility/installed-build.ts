import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { createHash } from "node:crypto";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import { resolveTrustedWindowsPowerShellExe } from "../../lib/windows-elevation";
import type { DesktopAppInstall } from "../desktop-app/types";
import { CLOSE_WINDOWS_PACKAGE_FILES, CODEX_EXECUTABLE_SIGNER, CODEX_PACKAGE_FAMILY, CODEX_STORE_PUBLISHER,
  MEASURE_WINDOWS_PACKAGE_FILES, OPEN_WINDOWS_PACKAGE_FILES, WINDOWS_PACKAGE_PROOF_FUNCTIONS } from "./windows-package-proof";
export { DESKTOP_PACKAGE_PATH_GUARD_SCRIPT } from "./windows-package-proof";

// Baseline with completed native acceptance evidence; admission is proof-based below,
// so this version never allows or denies an installed build by itself.
export const DESKTOP_COMPATIBILITY_ASSESSED_VERSION = "26.924.2738.0";
export const DESKTOP_COMPATIBILITY_ASSESSED_FAMILY = CODEX_PACKAGE_FAMILY;

/** Internal observation only; never returned by management status. */
export interface DesktopPackageObservation extends DesktopAppInstall {
  proof?: { packageFullName: string; publisherId: string; publisher: string; manifestName: string;
    manifestPublisher: string; manifestVersion: string; appId: string; executable: string;
    canonicalExecutable: string; manifestDigest: string; ancestryIdentity: string; executableIdentity: string;
    executableHash?: string; signatureKind?: string; signerSubject?: string; signerThumbprint?: string;
    contentIntegrity?: boolean };
}

/** The immutable native activation target, shared only inside the compatibility runtime. */
export interface VerifiedDesktopPackage extends DesktopAppInstall {
  readonly packageFullName: string;
  readonly executableHash: string;
  readonly executableIdentity: string;
  readonly manifestDigest: string;
  readonly ancestryIdentity: string;
  readonly signerThumbprint: string;
}

// Compatibility-only read. The verified image and manifest stay read-locked through publication;
// the observation is built before any file is opened, so a failed proof still reports its version.
export const DESKTOP_PACKAGE_PROOF_SCRIPT = [
  WINDOWS_PACKAGE_PROOF_FUNCTIONS,
  "$p=Get-DesktopPackage",
  "$observation=@{id=$p.PackageFamilyName;root=$p.InstallLocation;relaunch=$p.PackageFamilyName+'!App'}",
  "try {",
  OPEN_WINDOWS_PACKAGE_FILES,
  MEASURE_WINDOWS_PACKAGE_FILES,
  "$observation.proof=@{packageFullName=$p.PackageFullName;publisherId=$p.PublisherId;publisher=$p.Publisher;manifestName=[string]$manifest.Package.Identity.Name;manifestPublisher=[string]$manifest.Package.Identity.Publisher;manifestVersion=[string]$manifest.Package.Identity.Version;appId=[string]$entry.Id;executable=[string]$entry.Executable;canonicalExecutable=$exePath;manifestDigest=$digest;ancestryIdentity=$ancestry;executableIdentity=$executableIdentity;executableHash=$executableHash;signatureKind=[string]$p.SignatureKind;signerSubject=$signature.SignerCertificate.Subject;signerThumbprint=$signature.SignerCertificate.Thumbprint;contentIntegrity=$true}",
  "} catch { $observation.Remove('proof') } finally {", CLOSE_WINDOWS_PACKAGE_FILES, "}",
  "[pscustomobject]$observation|ConvertTo-Json -Depth 3 -Compress",
].join("\n");

/** Last completed probe outcome. Only public package facts: never paths, keys or account data.
 * `verified` is the official-package proof verdict at `completedAt`; `assessedVersion` stays the
 * baseline that holds native acceptance evidence, reported separately from admission. */
export interface DesktopBuildAssessment {
  assessedVersion: string;
  observedVersion: string | null;
  verified: boolean;
  completedAt: number;
}

const sha256 = /^[a-f0-9]{64}$/;
const thumbprint = /^[A-F0-9]{40}$/;

function assessInstalledPackage(install: DesktopPackageObservation) {
  const name = win32.basename(install.root);
  const parts = /^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_(x64|arm64|x86|neutral)_([A-Za-z0-9.-]*)_([A-Za-z0-9]+)$/.exec(name);
  const identified = install.id === DESKTOP_COMPATIBILITY_ASSESSED_FAMILY && install.relaunch === `${install.id}!App`
    && !!parts && `OpenAI.Codex_${parts[4]}` === install.id;
  const observedVersion = identified ? parts![1] : null;
  const proof = install.proof;
  const executableHash = proof?.executableHash, signerThumbprint = proof?.signerThumbprint;
  // Official-package proof admits a build; the observed version stays inside the
  // hashed identity, so an update still revokes a prior trial before correction.
  const verified = identified && !!proof
    && /^[A-Za-z]:\\/.test(install.root) && win32.normalize(install.root) === install.root
    && proof.packageFullName === name && proof.publisherId === "2p2nqsd0c76g0"
    && proof.publisher === CODEX_STORE_PUBLISHER && proof.signatureKind === "Store"
    && proof.contentIntegrity === true && proof.signerSubject === CODEX_EXECUTABLE_SIGNER
    && proof.manifestName === "OpenAI.Codex" && proof.manifestPublisher === proof.publisher
    && proof.manifestVersion === observedVersion && proof.appId === "App"
    && typeof proof.executable === "string" && proof.executable.replaceAll("/", "\\").toLowerCase() === "app\\chatgpt.exe"
    && proof.canonicalExecutable === win32.join(install.root, "app", "ChatGPT.exe")
    && sha256.test(proof.manifestDigest) && sha256.test(proof.ancestryIdentity)
    && /^\d{1,16}:\d{1,20}:\d{1,20}$/.test(proof.executableIdentity)
    && typeof executableHash === "string" && sha256.test(executableHash)
    && typeof signerThumbprint === "string" && thumbprint.test(signerThumbprint);
  if (!verified) return { observedVersion, identity: null, build: null };
  const build: VerifiedDesktopPackage = { id: install.id, root: install.root, relaunch: install.relaunch,
    packageFullName: proof.packageFullName, executableHash, executableIdentity: proof.executableIdentity,
    manifestDigest: proof.manifestDigest, ancestryIdentity: proof.ancestryIdentity, signerThumbprint };
  return { observedVersion, build, identity: createHash("sha256").update(JSON.stringify(build)).digest("hex") };
}

/** Resolve only after the exact asynchronous child has closed, including abort/timeout. */
function queryInstalledPackage(signal: AbortSignal): Promise<DesktopPackageObservation | null> {
  if (process.platform !== "win32" || isTestHomeGuardArmed() || signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let completed = false, closed = false, result: DesktopPackageObservation | null = null;
    const finish = () => { if (completed && closed) { signal.removeEventListener("abort", abort); resolve(result); } };
    const child = execFile(resolveTrustedWindowsPowerShellExe(), ["-NoProfile", "-NonInteractive", "-Command", DESKTOP_PACKAGE_PROOF_SCRIPT], {
      timeout: 10000, maxBuffer: 65536, encoding: "utf8", windowsHide: true,
    }, (error, stdout) => {
      try {
        const value = error ? null : JSON.parse(stdout);
        if (value && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string"
          && typeof value.root === "string" && typeof value.relaunch === "string"
          && (value.proof === undefined || (value.proof && typeof value.proof === "object" && !Array.isArray(value.proof)))) result = value;
      } catch { /* An unverifiable package never inherits a completed success. */ }
      completed = true; finish();
    });
    const abort = () => { try { child.kill(); } catch { /* Keep ownership until execFile reports close. */ } };
    child.once("close", () => { closed = true; finish(); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Coalesce concurrent fresh probes; never cache a positive verdict across requests. */
export function createInstalledBuildProbe(query: (signal: AbortSignal) => Promise<DesktopPackageObservation | null> = queryInstalledPackage) {
  let pending: Promise<boolean> | null = null, controller: AbortController | null = null, closed = false;
  let lastResult: DesktopBuildAssessment | null = null;
  let identity: string | null = null, build: VerifiedDesktopPackage | null = null, revision = 0;
  const record = (install: DesktopPackageObservation | null) => {
    const outcome = install ? assessInstalledPackage(install) : { observedVersion: null, identity: null, build: null };
    if (outcome.identity !== identity) { identity = outcome.identity; revision++; }
    build = outcome.build;
    lastResult = { assessedVersion: DESKTOP_COMPATIBILITY_ASSESSED_VERSION, observedVersion: outcome.observedVersion,
      verified: build !== null, completedAt: Date.now() };
    return build !== null;
  };
  return {
    check(): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (pending) return pending;
      const current = new AbortController(); controller = current;
      pending = Promise.resolve().then(() => current.signal.aborted ? null : query(current.signal))
        .then(install => closed || current.signal.aborted ? false : record(install))
        .catch(() => closed || current.signal.aborted ? false : record(null))
        .finally(() => { pending = null; controller = null; });
      return pending;
    },
    /** Last completed check only: an aborted or in-flight query never rewrites it. */
    lastResult(): DesktopBuildAssessment | null { return lastResult ? { ...lastResult } : null; },
    /** Private consent fence: a completed A->B->A proof is distinct from unchanged A. */
    binding() { return { identity, revision, build: build && { ...build } }; },
    async close(): Promise<void> { closed = true; identity = null; build = null; revision++; controller?.abort(); await pending; },
  };
}

// Reports the official-package proof verdict, not equality with the assessed baseline.
export async function isAssessedDesktopInstalled(): Promise<boolean> {
  const probe = createInstalledBuildProbe();
  try { return await probe.check(); } finally { await probe.close(); }
}
