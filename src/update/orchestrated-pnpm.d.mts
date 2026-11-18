import type { PnpmGlobalOwner, RunPnpmCandidate } from "./pnpm-global-install.mjs";
import type { OrchestratedExpect } from "./orchestrated-session.mjs";

export declare function canonicalOrchestratedPnpmOwner(owner: PnpmGlobalOwner): NonNullable<OrchestratedExpect["pnpmOwner"]>;
export declare function matchesOrchestratedPnpmOwner(expected: OrchestratedExpect["pnpmOwner"], owner: PnpmGlobalOwner | undefined): boolean;

export declare function verifyOrchestratedPnpmInstall(options: {
  owner: PnpmGlobalOwner;
  activeRoot: string;
  version: string;
  runPnpm: RunPnpmCandidate;
}): boolean;
