// Ad-hoc signing of the prepared desktop sidecar on macOS.
//
// Bun's linker-signed standalone output is killed by macOS page validation
// (CODESIGNING "Invalid Page"), so the copied sidecar is resealed with an
// ad-hoc signature before Tauri bundles it. Only a macOS host preparing a
// bun-darwin-* target signs: a Mac cross-preparing a Linux or Windows sidecar
// must never run codesign on that file. Release builds re-sign the bundled
// binary with Developer ID afterwards; this step only has to leave a runnable
// input.

export const CODESIGN_PATH = "/usr/bin/codesign";

export function shouldAdHocSignSidecar(hostPlatform: string, bunTarget: string): boolean {
  return hostPlatform === "darwin" && bunTarget.startsWith("bun-darwin-");
}

export function adHocSignArgv(destination: string): string[] {
  return [CODESIGN_PATH, "-s", "-", "-f", destination];
}

export type SidecarSignSpawn = (argv: string[]) => { exitCode: number | null };

const inheritSpawn: SidecarSignSpawn = (argv) =>
  Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });

/** Returns 0 on success, otherwise the nonzero exit code the caller should exit with. */
export function adHocSignSidecar(destination: string, spawn: SidecarSignSpawn = inheritSpawn): number {
  const result = spawn(adHocSignArgv(destination));
  if (result.exitCode === 0) return 0;
  return result.exitCode ?? 1;
}
