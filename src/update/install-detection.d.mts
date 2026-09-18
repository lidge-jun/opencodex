export type DetectedInstall = "bun" | "npm" | "pnpm" | "source";

export declare function detectInstallFromPath(
  packagePath: string,
  deps?: { exists?: (path: string) => boolean; realpath?: (path: string) => string },
): DetectedInstall;
