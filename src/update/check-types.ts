import type { Channel, Installer, InstallOwnership } from "./index";

export interface UpdateCheckDeps {
  currentVersion: () => string;
  detectInstall: () => Installer;
  detectInstallOwnership?: () => InstallOwnership;
  latestVersion: (tag: Channel) => string | null;
  /** True when this process runs from a release directory deployed by an external updater. */
  managedReleaseDirectory?: () => boolean;
  miseUpdateCommand?: (ownership: InstallOwnership) => string | null;
}
