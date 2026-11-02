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
