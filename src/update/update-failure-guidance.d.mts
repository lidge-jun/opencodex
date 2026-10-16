export function manualUpdateFailureGuidance(command: {
  bin: string;
  args: string[];
  owner?: import("./pnpm-global-install.mjs").PnpmGlobalOwner;
  platform?: NodeJS.Platform;
}): string[];
export function npmUpdateFailureGuidance(failure: {
  phase?: string;
  rolledBack?: boolean;
  pkgName: string;
  version?: string;
  tag?: string;
}): { previousVersionKept: boolean; lines: string[] };
export const GUI_UPDATE_FAILURE_NEXT_STEP: string;
