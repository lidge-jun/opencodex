import type { Channel, Installer, InstallOwnership } from "./index";

export interface UpdateCheckDeps {
  currentVersion: () => string;
  detectInstall: () => Installer;
  detectInstallOwnership?: () => InstallOwnership;
  latestVersion: (tag: Channel) => string | null;
  miseUpdateCommand?: (ownership: InstallOwnership) => string | null;
}
