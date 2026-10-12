/**
 * Standalone binary target metadata — the single source for the standalone build
 * matrix. scripts/build-standalone.ts builds from this list, the release workflow's
 * package-standalone matrix must stay equal to it, and the pre-publication
 * verifier derives its expected standalone assets from it.
 */
export const standaloneTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

export function isStandaloneTarget(value: string): boolean {
  return (standaloneTargets as readonly string[]).includes(value);
}

export function standaloneExecutableName(target: string): string {
  return target.startsWith("bun-windows-") ? "ocx.exe" : "ocx";
}

export function standaloneArchiveExtension(target: string): string {
  return target.startsWith("bun-windows-") ? "zip" : "tar.gz";
}

export function standaloneArchiveName(version: string, target: string): string {
  return `ocx-${version}-${target}.${standaloneArchiveExtension(target)}`;
}
