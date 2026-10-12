import { writeFileSync } from "node:fs";

/** MSI cannot express SemVer prerelease precedence. Keep public application and
 * updater versions intact and override only WiX ProductVersion with the core.
 * The pinned Tauri template permits equal-core replacement; manual MSI installs
 * therefore do not prevent same-core channel downgrades. */
export function windowsInstallerVersion(version: string): string {
  if (version.length > 128) throw new Error("Public version exceeds the installer metadata bound");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")) {
    throw new Error("A valid public SemVer is required for the Windows installer");
  }
  const parts = [match[1]!, match[2]!, match[3]!].map(Number);
  if (parts.some((part, index) => !Number.isSafeInteger(part) || part > (index < 2 ? 255 : 65_535))) {
    throw new Error("Windows installer version exceeds MSI numeric limits");
  }
  return parts.join(".");
}

export function windowsInstallerConfig(version: string) {
  return { bundle: { windows: { wix: { version: windowsInstallerVersion(version) } } } };
}

if (import.meta.main) {
  const [version, output] = process.argv.slice(2);
  if (!version || !output) throw new Error("Usage: windows-installer-config <version> <output.json>");
  writeFileSync(output, `${JSON.stringify(windowsInstallerConfig(version))}\n`, { mode: 0o600 });
}
