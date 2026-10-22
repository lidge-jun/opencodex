import { detectInstallOwnership, type InstallOwnership } from "../update";

/** How this ocx is installed, from the updater's own ownership detector. */
export type InstallMethod = "bun" | "npm" | "pnpm" | "mise" | "source" | "standalone" | "unknown";

/**
 * `ocx status --json` `install`. Additive within `schemaVersion: 1`.
 *
 * The verdict is the one `ocx update` acts on (`src/update/install-detection.mjs`), read
 * from the running package's own location — PATH is never consulted, because a machine can
 * carry several package managers at once. `evidence` names what decided it without adding
 * a path: the package layout, mise's backend record (tool alias and backend only), the
 * compiled standalone binary, or nothing when detection itself failed.
 */
export type InstallDetectionStatus = {
  method: InstallMethod;
  evidence: {
    basis: "package-layout" | "mise-backend-record" | "standalone-binary" | "unavailable";
    mise?: { tool: string; backend: string };
    error?: "metadata_unreadable" | "metadata_inconsistent" | "detection_failed";
  };
};

export function installDetectionStatus(
  detect: () => InstallOwnership = detectInstallOwnership,
): InstallDetectionStatus {
  let ownership: InstallOwnership;
  try {
    ownership = detect();
  } catch {
    return { method: "unknown", evidence: { basis: "unavailable", error: "detection_failed" } };
  }
  switch (ownership.installer) {
    case "standalone":
      return { method: "standalone", evidence: { basis: "standalone-binary" } };
    case "mise":
      if (ownership.owner) {
        return {
          method: "mise",
          evidence: { basis: "mise-backend-record", mise: { tool: ownership.owner.tool, backend: ownership.owner.backend } },
        };
      }
      return { method: "mise", evidence: { basis: "mise-backend-record", error: ownership.error ?? "metadata_unreadable" } };
    case "bun":
    case "npm":
    case "pnpm":
    case "source":
      return { method: ownership.installer, evidence: { basis: "package-layout" } };
    default:
      return { method: "unknown", evidence: { basis: "unavailable", error: "detection_failed" } };
  }
}
