/**
 * Release-record parsing and installer verification for the headless Desktop updater (#8246).
 *
 * The GUI updater (`tauri-plugin-updater` 2.14.1, `verify_signature`) checks the minisign
 * signature with the embedded key and, when the trusted comment names a version, that it equals
 * the announced one. This verifier is never weaker: it requires the prehashed minisign form the
 * release signer emits and both signatures over the exact trusted-comment bytes, binds the
 * announced version and the Windows x64 MSI target through the exact asset URL and the signed
 * `file:` name, and checks the bytes are an MSI container before any of them reach msiexec.
 */
import { decodePublicKey, verifyMinisignBytes } from "../update/minisign.mjs";
import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import { DESKTOP_ACQUIRE_LIMITS, DESKTOP_UPDATER_PUBKEY, DESKTOP_WINDOWS_PLATFORM, desktopInstallerUrl } from "./trust";

export type DesktopRefusalCode =
  | "feed_malformed"
  | "feed_version"
  | "feed_target_missing"
  | "feed_target_ambiguous"
  | "feed_source"
  | "signature_missing"
  | "signature_invalid"
  | "signed_version"
  | "signed_target"
  | "oversize"
  | "not_msi";

export class DesktopUpdateRefusal extends Error {
  constructor(readonly code: DesktopRefusalCode, message: string) {
    super(message);
    this.name = "DesktopUpdateRefusal";
  }
}

export interface DesktopCandidate {
  version: string;
  url: string;
  signature: string;
}

const MAX_SIGNATURE_CHARS = 5464;
const MSI_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Parse the published latest.json and select the Windows x64 MSI it announces. */
export function parseDesktopFeed(bytes: Uint8Array): DesktopCandidate {
  let feed: Record<string, unknown> | null;
  try { feed = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch { throw new DesktopUpdateRefusal("feed_malformed", "the update feed is not valid JSON"); }
  if (!feed) throw new DesktopUpdateRefusal("feed_malformed", "the update feed is not a JSON object");
  const version = feed.version;
  if (typeof version !== "string" || !parseStrictSemver(version)) {
    throw new DesktopUpdateRefusal("feed_version", "the update feed names no valid version");
  }
  const platforms = record(feed.platforms);
  const entry = record(platforms?.[DESKTOP_WINDOWS_PLATFORM]);
  if (!platforms || !entry) throw new DesktopUpdateRefusal("feed_target_missing", `the update feed has no ${DESKTOP_WINDOWS_PLATFORM} installer`);
  // The GUI updater would prefer an installer-specific key; refuse rather than pick between two.
  const specific = record(platforms[`${DESKTOP_WINDOWS_PLATFORM}-msi`]);
  if (specific && (specific.url !== entry.url || specific.signature !== entry.signature)) {
    throw new DesktopUpdateRefusal("feed_target_ambiguous", "the update feed names two different Windows installers");
  }
  const expected = desktopInstallerUrl(version);
  if (entry.url !== expected) {
    throw new DesktopUpdateRefusal("feed_source", `the Windows installer is not served from the expected release asset ${expected}`);
  }
  const signature = entry.signature;
  if (typeof signature !== "string" || !signature || signature.length > MAX_SIGNATURE_CHARS) {
    throw new DesktopUpdateRefusal("signature_missing", "the Windows installer has no usable signature");
  }
  return { version, url: expected, signature };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** File names the release signer may have signed for this version's Windows x64 MSI. */
function signedFileMatches(file: string, version: string): boolean {
  // The release signs the full version in the name, prereleases included (only the WiX
  // ProductVersion inside the package is reduced to the numeric core).
  return new RegExp(`^OpenCodex_${escapeRegExp(version)}_x64_[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\\.msi$`).test(file);
}

/**
 * Verify downloaded installer bytes against the candidate. Throws {@link DesktopUpdateRefusal} on
 * any mismatch; the bytes are installable only when this returns.
 */
export function verifyDesktopInstaller(
  bytes: Uint8Array,
  candidate: DesktopCandidate,
  publicKeyBase64: string = DESKTOP_UPDATER_PUBKEY,
): { keyId: string; trustedComment: string } {
  if (bytes.byteLength > DESKTOP_ACQUIRE_LIMITS.maxArtifactBytes) {
    throw new DesktopUpdateRefusal("oversize", "the installer exceeds the size cap");
  }
  const key = decodePublicKey(Buffer.from(publicKeyBase64, "base64").toString("utf8"));
  let verified: { keyId: string; trustedComment: string };
  try { verified = verifyMinisignBytes(bytes, candidate.signature, key); }
  catch (error) {
    throw new DesktopUpdateRefusal("signature_invalid", `the installer signature did not verify: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = verified.trustedComment.split("\t");
  const signedVersion = fields.find(field => field.startsWith("version:"))?.slice("version:".length);
  if (signedVersion !== undefined && signedVersion.replace(/^v/, "") !== candidate.version) {
    throw new DesktopUpdateRefusal("signed_version", `the signature is for version ${signedVersion}, not ${candidate.version}`);
  }
  const file = fields.find(field => field.startsWith("file:"))?.slice("file:".length);
  if (!file || !signedFileMatches(file, candidate.version)) {
    throw new DesktopUpdateRefusal("signed_target", "the signature does not name this version's Windows x64 MSI");
  }
  if (bytes.byteLength < MSI_MAGIC.length || MSI_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new DesktopUpdateRefusal("not_msi", "the signed file is not a Windows Installer package");
  }
  return { keyId: verified.keyId, trustedComment: verified.trustedComment };
}

/** How a published version relates to the installed one; only "newer" is installed. */
export function compareToInstalled(installed: string, candidate: string): "newer" | "same" | "older" | "unknown" {
  const left = parseStrictSemver(installed);
  const right = parseStrictSemver(candidate);
  if (!left || !right) return "unknown";
  const order = compareStrictSemver(right, left);
  return order > 0 ? "newer" : order < 0 ? "older" : "same";
}
