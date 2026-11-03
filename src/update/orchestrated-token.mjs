import { createHash } from "node:crypto";

/** Hash only the explicitly bound fields in a fixed order, never a runtime proof key. */
export function createUpdatePlanToken(input) {
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
