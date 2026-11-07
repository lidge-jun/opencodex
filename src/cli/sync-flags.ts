import { isRouteClientId, type RouteClientId } from "../link/route-intent";
export type SyncFanoutFlags = { ok: true; localOnly: boolean; json: boolean; overwriteClient?: RouteClientId } | { ok: false; message: string };

export function parseSyncFanoutFlags(args: readonly string[]): SyncFanoutFlags {
  for (const flag of ["--local-only", "--json", "--overwrite-conflict"]) {
    if (args.filter(arg => arg === flag).length > 1 || args.some(arg => arg.startsWith(`${flag}=`))) {
      return { ok: false, message: `ocx sync accepts ${flag} once without a value.` };
    }
  }
  const selectors = args.flatMap((arg, index) => arg === "--overwrite-client" ? [args[index + 1]] : arg.startsWith("--overwrite-client=") ? [arg.slice(19)] : []);
  if (selectors.length > 1 || (selectors.length && (!args.includes("--overwrite-conflict") || !isRouteClientId(selectors[0])))) {
    return { ok: false, message: "--overwrite-client needs one supported client and --overwrite-conflict." };
  }
  return { ok: true, localOnly: args.includes("--local-only"), json: args.includes("--json"),
    ...(selectors.length ? { overwriteClient: selectors[0] as RouteClientId } : {}) };
}
