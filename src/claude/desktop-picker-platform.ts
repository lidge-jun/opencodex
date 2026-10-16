/** Platforms with a Desktop egress profile and an OS trust adapter for the picker. */
export function supportsDesktopPicker(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}
