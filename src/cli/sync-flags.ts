export type SyncFanoutFlags = { ok: true; localOnly: boolean; json: boolean } | { ok: false; message: string };

export function parseSyncFanoutFlags(args: readonly string[]): SyncFanoutFlags {
  for (const flag of ["--local-only", "--json"]) {
    if (args.filter(arg => arg === flag).length > 1 || args.some(arg => arg.startsWith(`${flag}=`))) {
      return { ok: false, message: `ocx sync accepts ${flag} once without a value.` };
    }
  }
  return { ok: true, localOnly: args.includes("--local-only"), json: args.includes("--json") };
}
