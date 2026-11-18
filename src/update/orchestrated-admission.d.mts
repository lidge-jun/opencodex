import type { observeOrchestratedPlan } from "./orchestrated-entry";
import type { OrchestratedUpdateArgs } from "./orchestrated-arguments.mjs";
export declare function decideOrchestratedApply(plan: Awaited<ReturnType<typeof observeOrchestratedPlan>>, request: Extract<OrchestratedUpdateArgs, { ok: true }>, now: number):
  | { kind: "proceed" } | { kind: "done"; exitCode: 0 | 10; result: { schema: "ocx.update.result/1"; applied: boolean; fromVersion: string; toVersion: string | null; installer: string; restarted: boolean; healthy: boolean; rolledBack: boolean; error?: string } };
