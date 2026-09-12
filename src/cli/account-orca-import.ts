import type { importOrcaAccounts } from "../codex/orca-import";

const USAGE = "Usage: ocx account import-orca --source <orca-data-directory> --registry <orca-data.json> [--apply] [--json]";

export interface OrcaImportCommandDeps {
  importAccounts?: typeof importOrcaAccounts;
}

/** Local-only: never sends source paths or credentials to a management listener. */
export async function cmdOrcaImport(args: string[], deps: OrcaImportCommandDeps = {}): Promise<number> {
  let sourceDir: string | undefined;
  let registryPath: string | undefined;
  let apply = false;
  const wantsJson = args.includes("--json");
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (seen.has(arg) || !["--source", "--registry", "--apply", "--json"].includes(arg)) {
      console.error(USAGE);
      return 1;
    }
    seen.add(arg);
    if (arg === "--source" || arg === "--registry") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        console.error(USAGE);
        return 1;
      }
      if (arg === "--source") sourceDir = value;
      else registryPath = value;
    } else if (arg === "--apply") apply = true;
  }
  if (!sourceDir || !registryPath) {
    console.error(USAGE);
    return 1;
  }
  try {
    const run = deps.importAccounts ?? (await import("../codex/orca-import")).importOrcaAccounts;
    const result = await run({ sourceDir, registryPath, apply });
    if (wantsJson) console.log(JSON.stringify({
      mode: result.mode, discovered: result.discovered, eligible: result.eligible,
      imported: result.imported, duplicates: result.duplicates, invalid: result.invalid,
    }));
    else {
      console.log(`Orca: ${result.discovered} discovered, ${result.eligible} eligible, ${result.imported} imported, ${result.duplicates} duplicates, ${result.invalid} invalid.`);
      console.log(apply
        ? "Start the proxy and use Refresh quotas in Codex Auth to validate new accounts. Orca retains refresh ownership."
        : "Preview only. Stop the proxy before repeating with --apply. Orca authentication files stay read-only.");
    }
    return result.invalid > 0 ? 1 : 0;
  } catch {
    // Filesystem/JSON exceptions may contain source paths or token fragments.
    const error = "Orca import failed. Check the source, destination config, and stopped proxy; no successful completion is confirmed.";
    if (wantsJson) console.log(JSON.stringify({ error: "orca_import_failed" }));
    else console.error(error);
    return 1;
  }
}
