/**
 * The release body's code signing section (#7207).
 *
 * SignPath Foundation's terms require the code signing policy and the SignPath attribution on the download page. The
 * GitHub release page is where every Windows download is published, so every release body carries both. Under them, the
 * body states whether this release's Windows files were actually Authenticode-signed. That statement comes only from the
 * records the Windows release legs write (scripts/ci/windows-signing-outcome.sh): a file counts as signed only when its
 * leg's signing plan chose release-trust signing and the verified swap (scripts/ci/apply-signed-windows-artifact.ps1)
 * put the signed file in place. A missing, unreadable or malformed record is "not recorded", never "signed".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS_SIGNING_OUTCOME_SCHEMA = "ocx.windows-signing-outcome/1";

/** The Windows release files, by the leg that signs them. */
export const WINDOWS_SIGNED_FILES = [
  { kind: "standalone", label: "`ocx.exe` in the standalone `bun-windows-x64` zip" },
  { kind: "desktop", label: "the MSI installer (and the executables it installs)" },
] as const;
export type WindowsSignedFileKind = typeof WINDOWS_SIGNED_FILES[number]["kind"];
export type WindowsFileSigning = "signed" | "unsigned" | "unknown";

export interface WindowsSigningOutcome {
  /** signed: every file signed; unsigned: none signed; partial: anything mixed; unknown: no file has a record. */
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

function readRecord(dir: string, kind: WindowsSignedFileKind): WindowsFileSigning {
  let text: string;
  try { text = readFileSync(join(dir, kind + ".json"), "utf8"); } catch { return "unknown"; }
  if (text.length > 4096) return "unknown";
  let value: unknown;
  try { value = JSON.parse(text); } catch { return "unknown"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const record = value as Record<string, unknown>;
  if (record.schema !== WINDOWS_SIGNING_OUTCOME_SCHEMA || record.kind !== kind || typeof record.signed !== "boolean") return "unknown";
  return record.signed ? "signed" : "unsigned";
}

/** Read the records the Windows legs uploaded; an absent directory or file is "unknown" for that file. */
export function readWindowsSigningOutcomes(dir: string | undefined): WindowsSigningOutcome {
  if (!dir) return UNRECORDED_WINDOWS_SIGNING;
  const files = { standalone: readRecord(dir, "standalone"), desktop: readRecord(dir, "desktop") };
  const states = Object.values(files);
  const status = states.every(state => state === "signed") ? "signed"
    : states.every(state => state === "unsigned") ? "unsigned"
    : states.every(state => state === "unknown") ? "unknown"
    : "partial";
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
    statement = "The Windows files in this release, `ocx.exe` and the MSI installer, are Authenticode-signed with the SignPath Foundation certificate.";
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
