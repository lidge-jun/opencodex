/**
 * The release body's code signing section (#7207).
 *
 * SignPath Foundation's terms require the code signing policy and the SignPath attribution on the download page. The
 * GitHub release page is where every Windows download is published, so every release body carries both. Under them, the
 * body states whether this release's Windows files were actually Authenticode-signed. That statement comes only from the
 * records the Windows release legs write (scripts/ci/windows-signing-outcome.sh): a file counts as signed only when its
 * leg's signing plan chose release-trust signing and the verified swap (scripts/ci/apply-signed-windows-artifact.ps1)
 * put the signed file in place, and only while the record's sha256 equals the digest of the asset this release publishes
 * (the verified release receipt). A record from an earlier attempt describes other bytes, so it is "not recorded", as is
 * a missing, unreadable or malformed one; none of them is ever "signed".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS_SIGNING_OUTCOME_SCHEMA = "ocx.windows-signing-outcome/2";

/** The Windows release files, by the leg that signs them, with the release asset each one ships in. */
export const WINDOWS_SIGNED_FILES = [
  { kind: "standalone", label: "`ocx.exe` in the standalone `bun-windows-x64` zip", asset: (version: string) => `ocx-${version}-bun-windows-x64.zip` },
  { kind: "desktop", label: "the MSI installer (and the executables it installs)", asset: (version: string) => `OpenCodex-${version}-windows-x64.msi` },
] as const;
export type WindowsSignedFileKind = typeof WINDOWS_SIGNED_FILES[number]["kind"];
export type WindowsFileSigning = "signed" | "unsigned" | "unknown";
/** The sha256 of each Windows asset this release publishes; a kind without one has no record that can describe it. */
export type PublishedWindowsDigests = Partial<Record<WindowsSignedFileKind, string>>;

const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ATTEMPT = /^[1-9][0-9]*$/;

export interface WindowsSigningOutcome {
  /** signed: every file signed; partial: some signed, some not; unsigned: none signed; unknown: no file has a record. */
  status: "signed" | "unsigned" | "partial" | "unknown";
  files: Record<WindowsSignedFileKind, WindowsFileSigning>;
}

export const CODE_SIGNING_ATTRIBUTION = [
  "## Code signing",
  "",
  "Windows binaries follow the [code signing policy](https://opencodex.me/reference/code-signing/).",
  "Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).",
].join("\n");

/** What the release states when no Windows leg left a record: nothing is claimed. */
export const UNRECORDED_WINDOWS_SIGNING: WindowsSigningOutcome = Object.freeze({
  status: "unknown" as const,
  files: Object.freeze({ standalone: "unknown" as const, desktop: "unknown" as const }),
});

function readJsonObject(file: string, limit: number): Record<string, unknown> | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  if (text.length > limit) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The published digests of this version's Windows assets, from the verified release receipt (`assets`: name to sha256)
 * that attach-release holds the release's files to. An absent, unreadable or other-version receipt yields none.
 */
export function readPublishedWindowsDigests(receiptPath: string | undefined, version: string): PublishedWindowsDigests {
  if (!receiptPath) return {};
  const receipt = readJsonObject(receiptPath, 4 * 1024 * 1024);
  if (!receipt || receipt.version !== version) return {};
  const assets = receipt.assets;
  if (!assets || typeof assets !== "object" || Array.isArray(assets)) return {};
  const digests: PublishedWindowsDigests = {};
  for (const file of WINDOWS_SIGNED_FILES) {
    const name = file.asset(version);
    const digest = Object.hasOwn(assets, name) ? (assets as Record<string, unknown>)[name] : undefined;
    if (typeof digest === "string" && SHA256.test(digest)) digests[file.kind] = digest;
  }
  return digests;
}

function readRecord(dir: string, kind: WindowsSignedFileKind, published: string | undefined): WindowsFileSigning {
  const record = readJsonObject(join(dir, kind + ".json"), 4096);
  if (!record || record.schema !== WINDOWS_SIGNING_OUTCOME_SCHEMA || record.kind !== kind || typeof record.signed !== "boolean") return "unknown";
  if (typeof record.attempt !== "string" || !RUN_ATTEMPT.test(record.attempt)) return "unknown";
  // The record speaks only for the bytes it hashed: a stale record from an earlier attempt, or one whose upload never
  // replaced it, names a different digest than the asset this release publishes.
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256) || !published || record.sha256 !== published) return "unknown";
  return record.signed ? "signed" : "unsigned";
}

/**
 * Read the records the Windows legs uploaded against the digests this release publishes; an absent directory or file, or
 * a record whose digest is not the published asset's, is "unknown" for that file.
 */
export function readWindowsSigningOutcomes(dir: string | undefined, published: PublishedWindowsDigests): WindowsSigningOutcome {
  if (!dir) return UNRECORDED_WINDOWS_SIGNING;
  const files = { standalone: readRecord(dir, "standalone", published.standalone), desktop: readRecord(dir, "desktop", published.desktop) };
  const states = Object.values(files);
  // partial only when at least one file is signed and another is not: a result with nothing signed never reads as partly
  // signed, and an unrecorded file never counts as signed.
  const status = states.every(state => state === "signed") ? "signed"
    : states.every(state => state === "unknown") ? "unknown"
    : states.some(state => state === "signed") ? "partial"
    : "unsigned";
  return { status, files };
}

const FILE_STATE_TEXT: Record<WindowsFileSigning, string> = {
  signed: "signed",
  unsigned: "not code-signed",
  unknown: "signing outcome not recorded; treat it as not code-signed",
};

/** The full code signing section for one release. */
export function codeSigningFooter(outcome: WindowsSigningOutcome = UNRECORDED_WINDOWS_SIGNING): string {
  let statement: string;
  if (outcome.status === "signed") {
    statement = "`ocx.exe` and the MSI installer (with the executables it installs) are Authenticode-signed with the SignPath Foundation certificate. The third-party keyring addons bundled in the standalone zip keep their upstream form.";
  } else if (outcome.status === "unsigned") {
    statement = "**The Windows files in this release are not code-signed.**";
  } else if (outcome.status === "unknown") {
    statement = "**The Windows files in this release are not code-signed.** The release run recorded no signing outcome for them.";
  } else {
    statement = ["**Not every Windows file in this release is code-signed.**", "",
      ...WINDOWS_SIGNED_FILES.map(file => `- ${file.label}: ${FILE_STATE_TEXT[outcome.files[file.kind]]}`)].join("\n");
  }
  return CODE_SIGNING_ATTRIBUTION + "\n\n" + statement;
}
