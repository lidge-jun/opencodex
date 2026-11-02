import { createHash } from "node:crypto";

export interface UpdatePlanTokenInput {
  currentVersion: string;
  targetVersion: string | null;
  installer: string;
  cliRoot: string;
  servingRoot: string | null;
  runtimeOwner: string;
  runtime: { pid: number; port: number; hostname: string; command: readonly string[] } | null;
}

/** Hash only the explicitly bound fields in a fixed order, never a runtime proof key. */
export function createUpdatePlanToken(input: UpdatePlanTokenInput): string {
  const runtime = input.runtime === null ? null : {
    pid: input.runtime.pid,
    port: input.runtime.port,
    hostname: input.runtime.hostname,
    command: [...input.runtime.command],
  };
  const canonical = {
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
    installer: input.installer,
    cliRoot: input.cliRoot,
    servingRoot: input.servingRoot,
    runtimeOwner: input.runtimeOwner,
    runtime,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
}
