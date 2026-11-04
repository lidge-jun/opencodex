import type { PnpmGlobalOwner, RunPnpmCandidate } from "./pnpm-global-install.mjs";

export declare function verifyOrchestratedPnpmInstall(options: {
  owner: PnpmGlobalOwner;
  activeRoot: string;
  version: string;
  runPnpm: RunPnpmCandidate;
}): boolean;
