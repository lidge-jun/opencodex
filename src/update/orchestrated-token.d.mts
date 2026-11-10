export interface UpdatePlanTokenInput {
  currentVersion: string;
  targetVersion: string | null;
  installer: string;
  cliRoot: string;
  servingRoot: string | null;
  runtimeOwner: string;
  runtime: { pid: number; port: number; hostname: string; command: readonly string[] } | null;
}
export declare function createUpdatePlanToken(input: UpdatePlanTokenInput): string;
