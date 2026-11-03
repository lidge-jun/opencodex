import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectNodeOrchestratedIdentity } from "./orchestrated-entry";
import { proxyIdentityAt } from "../server/proxy-liveness";

// A direct Bun entry keeps the probe outside ordinary CLI startup and repair paths.
export async function runIdentityProbe(args: string[], cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")) {
  if (args.length !== 1 || args[0] !== "__update-orchestrated-identity") return 1;
  try {
    const installer = process.env.OCX_IDENTITY_INSTALLER;
    const target = process.env.OCX_IDENTITY_TARGET;
    if ((installer || target) && (!(installer === "npm" || installer === "pnpm") || !target)) return 1;
    const identity = await inspectNodeOrchestratedIdentity(cliRoot, target, installer as "npm" | "pnpm" | undefined);
    const health = identity.kind === "live" ? await proxyIdentityAt(identity.runtime.port,
      { hostname: identity.runtime.hostname, expectedPid: identity.runtime.pid }) : null;
    console.log(JSON.stringify({ ...identity, healthVersion: health?.version ?? null }));
    return 0;
  } catch { return 1; }
}
if (import.meta.main) process.exitCode = await runIdentityProbe(process.argv.slice(2), process.env.OCX_IDENTITY_CLI_ROOT);
