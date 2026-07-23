export function isSpawnableCodexCandidate(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return true;
  return /\.(cmd|bat|exe|com)$/i.test(path);
}

export function codexExecInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; shell: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return { file: `"${command.replace(/"/g, "")}"`, shell: true };
  }
  return { file: command, shell: false };
}
