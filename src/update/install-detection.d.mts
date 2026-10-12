export type DetectedInstall = "bun" | "mise" | "npm" | "pnpm" | "source";

export interface MiseInstallOwner {
  tool: string;
  backend: string;
  installPath: string;
  toolRoot: string;
}

export type InstallOwnership =
  | { installer: Exclude<DetectedInstall, "mise"> }
  | {
      installer: "mise";
      owner: MiseInstallOwner | null;
      error?: "metadata_unreadable" | "metadata_inconsistent";
    };

export interface InstallDetectionDeps {
  exists?: (path: string) => boolean;
  probe?: (path: string) => "present" | "absent" | "unreadable";
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
}

export declare function detectInstallFromPath(
  packagePath: string,
  deps?: InstallDetectionDeps,
): DetectedInstall;

export declare function detectInstallOwnershipFromPath(
  packagePath: string,
  deps?: InstallDetectionDeps,
): InstallOwnership;
