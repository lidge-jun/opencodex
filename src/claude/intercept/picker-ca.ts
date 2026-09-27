import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withClientLifecycleSync } from "../../client/lifecycle-lock";
import {
  createCertificateAuthority,
  issueServerLeaf,
  type LocalInterceptCa,
  type PemKeyPair,
} from "./local-ca";

/** Separate root for Desktop traffic: its critical DNS constraint is checked on every reload. */
export const PICKER_HOST = "claude.ai";
export const PICKER_CA_COMMON_NAME = "opencodex Claude Desktop Picker CA";
export const PICKER_STATE_DIR = "claude-picker";

export interface PickerCa extends LocalInterceptCa { fingerprint: string }

const processAuthorities = new Map<string, PickerCa>();

export function pickerStateDir(configDir: string): string { return join(configDir, PICKER_STATE_DIR); }
export function pickerCaCertPath(configDir: string): string { return join(pickerStateDir(configDir), "ca.pem"); }
export function pickerLeafCertPath(configDir: string): string { return join(pickerStateDir(configDir), "leaf.pem"); }
export function pickerCaOwnerPath(configDir: string): string { return join(pickerStateDir(configDir), "ca-owner.json"); }
function pickerCaLockPath(configDir: string): string { return join(pickerStateDir(configDir), "ca.lock.sqlite"); }

export function pickerCaFingerprints(certPem: string): { sha1: string; sha256: string } {
  const der = new X509Certificate(certPem).raw;
  return {
    sha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
    sha256: createHash("sha256").update(der).digest("hex").toUpperCase(),
  };
}

/** Atomically publish a public certificate; these files carry no key material. */
function publishPem(path: string, pem: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, pem, { mode: 0o644 });
  try { chmodSync(tmp, 0o644); } catch { /* best-effort on platforms without POSIX modes */ }
  renameSync(tmp, path);
}

/**
 * Publish this process's authority and record which pid owns it, so another process that shares
 * the config directory can distinguish "the file went missing or stale" from "a live peer rotated
 * the authority" — only the former may be overwritten.
 */
function publishAuthority(configDir: string, ca: PickerCa): void {
  publishPem(pickerCaCertPath(configDir), ca.certPem);
  publishPem(pickerCaOwnerPath(configDir), JSON.stringify({ pid: process.pid, sha256: ca.fingerprint }) + "\n");
}

function foreignProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signallable by us; ESRCH means it is gone.
    return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * True when the published certificate belongs to a different live process's authority. The owner
 * record is only trusted while it describes the certificate actually on disk: a stale or
 * third-party `ca-owner.json` cannot shield a file that was tampered with after the owner wrote it.
 */
function foreignLiveOwner(configDir: string, published: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(pickerCaOwnerPath(configDir), "utf8")) as unknown;
    if (owner === null || typeof owner !== "object") return false;
    const { pid, sha256 } = owner as { pid?: unknown; sha256?: unknown };
    if (typeof pid !== "number" || typeof sha256 !== "string") return false;
    if (sha256 !== pickerCaFingerprints(published).sha256) return false;
    return foreignProcessAlive(pid);
  } catch {
    return false;
  }
}

/**
 * `check` runs under a cross-process lock keyed to the picker state dir so the read-decide-publish
 * sequence cannot interleave with a peer's. A refused lock fails closed: `fallback` may republish
 * only when no live foreign owner exists, and a genuinely foreign certificate is never clobbered.
 */
function underPickerCaLock<T>(configDir: string, check: () => T): T | undefined {
  try {
    return withClientLifecycleSync(check, { lockPath: pickerCaLockPath(configDir) });
  } catch {
    return undefined;
  }
}

/**
 * Drop the legacy exportable signing key, if one exists in the picker state dir. Releases before
 * the process-scoped authority persisted `ca.key` next to `ca.pem`; the removal is deliberately
 * unconditional so a later failed rotation can never leave that key behind.
 */
export function discardPickerCaKey(configDir: string): void {
  rmSync(join(pickerStateDir(configDir), "ca.key"), { force: true });
}

export function ensurePickerCa(configDir: string): PickerCa {
  const dir = pickerStateDir(configDir);
  // The signing key must never survive this process: another process under the same user could
  // otherwise steal it and later take over the predictable loopback proxy. Drop a key left (or
  // restored) by an older release on every call, including cache hits.
  discardPickerCaKey(configDir);
  const path = pickerCaCertPath(configDir);
  const cached = processAuthorities.get(dir);
  if (cached) {
    // The published certificate is this authority's public face. If it went missing, republish;
    // if a *live* peer rotated it, defer to the owner record — republishing a certificate another
    // process still serves would re-point trust inspection at an authority that process controls.
    const republishUnlessForeignOwned = (): void => {
      let published: string | null = null;
      try { published = readFileSync(path, "utf8"); } catch { /* missing or unreadable: republish */ }
      if (published === cached.certPem) return;
      if (published !== null && foreignLiveOwner(configDir, published)) return;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      publishAuthority(configDir, cached);
    };
    if (underPickerCaLock(configDir, republishUnlessForeignOwned) === undefined) {
      republishUnlessForeignOwned();
    }
    return cached;
  }
  const ca = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
  const pickerCa = { ...ca, fingerprint: pickerCaFingerprints(ca.certPem).sha256 };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // This process is a fresh authority: publish unconditionally. A peer whose cert we just
  // replaced will observe the divergence against our live owner record and stop republishing.
  const publish = (): void => { publishAuthority(configDir, pickerCa); };
  if (underPickerCaLock(configDir, publish) === undefined) publish();
  processAuthorities.set(dir, pickerCa);
  return pickerCa;
}

/** Fingerprint of this process's authority only — null until ensurePickerCa has run. */
export function publishedPickerCaSha256(configDir: string): string | null {
  const cached = processAuthorities.get(pickerStateDir(configDir));
  return cached ? pickerCaFingerprints(cached.certPem).sha256 : null;
}

/** Persist only the public leaf, so trust inspection verifies this exact local issuer. */
export function issuePickerLeaf(ca: PickerCa, configDir: string): PemKeyPair {
  const leaf = issueServerLeaf(ca, PICKER_CA_COMMON_NAME, [PICKER_HOST]);
  mkdirSync(pickerStateDir(configDir), { recursive: true, mode: 0o700 });
  publishPem(pickerLeafCertPath(configDir), leaf.certPem);
  return leaf;
}
