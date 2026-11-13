import { isRouteClientId, type RouteClientId } from "../link/route-intent";
import type { ChildRestartRequest } from "../link/ssh-argv";

export type SyncFanoutFlags = {
  ok: true; localOnly: boolean; json: boolean;
  overwriteClient?: RouteClientId;
  /** null: every link (today's behaviour). Otherwise the deduplicated ids given with --child. */
  children: readonly string[] | null;
  restartChildren: ChildRestartRequest | null;
} | { ok: false; message: string };

const LINK_ID = /^lnk_[0-9a-f]{16}$/;

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
  const children: string[] = [];
  let restart: ChildRestartRequest | null = null, restartSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--child" || arg.startsWith("--child=")) {
      const value = arg === "--child" ? args[++i] : arg.slice("--child=".length);
      if (value === undefined || !LINK_ID.test(value)) return { ok: false, message: "--child needs a link id of the form lnk_ followed by 16 hex digits (see ocx link status)." };
      if (!children.includes(value)) children.push(value);
    } else if (arg === "--restart-children" || arg.startsWith("--restart-children=")) {
      if (restartSeen) return { ok: false, message: "ocx sync accepts --restart-children once." };
      restartSeen = true;
      const value = arg === "--restart-children" ? "app-server" : arg.slice("--restart-children=".length);
      if (value !== "app-server" && value !== "codex") return { ok: false, message: "--restart-children accepts app-server (default) or codex." };
      restart = value;
    }
  }
  const localOnly = args.includes("--local-only");
  if (localOnly && (children.length > 0 || restartSeen)) return { ok: false, message: "--local-only disables fan-out; it cannot be combined with --child or --restart-children." };
  if (restart === "codex" && !args.includes("--yes")) {
    return { ok: false, message: "--restart-children=codex quits and relaunches the Codex app on each selected Child and ends its conversations; pass --yes." };
  }
  return { ok: true, localOnly, json: args.includes("--json"), children: children.length ? children : null, restartChildren: restart,
    ...(selectors.length ? { overwriteClient: selectors[0] as RouteClientId } : {}) };
}
