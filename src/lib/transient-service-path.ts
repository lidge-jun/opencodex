import { delimiter, posix, win32 } from "node:path";

/** Shell-local version-manager bins disappear when the installing shell exits. */
export function isTransientServiceLauncherPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathTools = platform === "win32" ? win32 : posix;
  return pathTools.normalize(path).replace(/\\/g, "/").split("/").some(component =>
    /^(?:asdf|fnm|mise|nvm|volta)_multishells?$/i.test(component));
}

export function filterTransientServicePath(
  path: string,
  pathDelimiter = delimiter,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.split(pathDelimiter).filter(entry => !isTransientServiceLauncherPath(entry, platform)).join(pathDelimiter);
}
