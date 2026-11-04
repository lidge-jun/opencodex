export type Outcome = ({ phase: "preflight" | "mutating" | "overrun" }
  | { phase: "installed"; activeRoot: string; recoveryFailed?: boolean; error?: string }
  | { phase: "refused"; error?: string }
  | { phase: "failed"; error?: string; rollbackPerformed?: boolean }) & { terminationConfirmed?: boolean };
export interface OutcomeInput {
  fromVersion: string;
  toVersion: string | null;
  installer: "npm" | "pnpm" | "bun" | "mise" | "desktop-app" | "source" | "unknown";
  childExited: boolean;
  childExitCode: number | null;
  outcome: Outcome | null;
  previousVerified: boolean;
  targetVerified: boolean;
  runtimeHealthy: boolean;
  restarted: boolean;
}
export declare function classifyOrchestratedOutcome(input: OutcomeInput): {
  exitCode: 0 | 10 | 11 | 12;
  result: { schema: "ocx.update.result/1"; applied: boolean; fromVersion: string; toVersion: string | null;
    installer: OutcomeInput["installer"]; restarted: boolean; healthy: boolean; rolledBack: boolean; error?: string };
};
