export type OrchestratedUpdateArgs = { ok: false } | {
  ok: true;
  mode: "plan" | "apply";
  tag?: "latest" | "preview";
  version?: string;
  expectPlan?: string;
  notAfter?: number;
};
export declare function parseOrchestratedUpdateArgs(argv: readonly string[]): OrchestratedUpdateArgs;
export declare function isOrchestratedUpdateArgv(argv: readonly string[]): boolean;
export type OrchestratedChildArgs = { ok: false } | { ok: true; version: string; expect: string; resultPath: string; resultCapability: string; notAfter?: number };
export declare function parseOrchestratedChildArgs(argv: readonly string[], env: Record<string, string | undefined>): OrchestratedChildArgs;
