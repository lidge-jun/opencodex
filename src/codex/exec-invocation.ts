import { commandInvocation, type ResolveDeps, type SpawnInvocation } from "../lib/win-exec";

export function isSpawnableCodexCandidate(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return true;
  return /\.(cmd|bat|exe|com)$/i.test(path);
}

/**
 * Platform-safe Codex launcher invocation.
 *
 * Windows `.cmd`/`.bat` must go through `cmd.exe`, but never via `shell: true`
 * (Node does not escape cmd metacharacters there). Reuse the shared
 * `commandInvocation` helper (`ComSpec /d /s /c` + cross-spawn escaping).
 */
export function codexExecInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  deps: ResolveDeps = {},
): SpawnInvocation {
  return commandInvocation(command, args, platform, deps);
}
