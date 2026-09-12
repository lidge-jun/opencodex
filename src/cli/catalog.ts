import { afterCatalogWriteHandleAppServers } from "../codex/app-server-processes";
import { pullRemoteCatalog, RemoteCatalogError } from "../codex/catalog/remote";
import { hasHelpFlag, printSubcommandUsage } from "./help";

export interface CatalogPullEnvelope {
  schemaVersion: 1;
  ok: boolean;
  status: "updated" | "unchanged" | "failed";
  catalogWritten: boolean;
  cacheSynced: boolean;
  codexRestarted: boolean;
  modelCount?: number;
  code?: string;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function handleCatalogCommand(args: string[]): Promise<number> {
  if (hasHelpFlag(args)) { printSubcommandUsage("catalog"); return 0; }
  const json = args.includes("--json");
  const restartCodex = args.includes("--restart-codex");
  const authEnv = optionValue(args, "--auth-env");
  const positionals = args.filter((arg, index) => {
    if (arg === "--auth-env") return false;
    if (index > 0 && args[index - 1] === "--auth-env") return false;
    return !arg.startsWith("-");
  });
  const knownFlags = new Set(["--json", "--restart-codex", "--auth-env"]);
  const unknown = args.find((arg, index) => arg.startsWith("-") && !knownFlags.has(arg) && args[index - 1] !== "--auth-env");
  const validEnvName = authEnv === undefined || /^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv);
  if (positionals[0] !== "pull" || positionals.length !== 2 || unknown || !validEnvName
    || args.includes("--auth-env") !== (authEnv !== undefined)) {
    const envelope: CatalogPullEnvelope = {
      schemaVersion: 1, ok: false, status: "failed", catalogWritten: false,
      cacheSynced: false, codexRestarted: false, code: "usage",
    };
    if (json) console.log(JSON.stringify(envelope));
    else console.error("Usage: ocx catalog pull <https-url> [--auth-env <NAME>] [--json] [--restart-codex]");
    return 2;
  }
  let token: string | undefined;
  if (authEnv !== undefined) {
    token = process.env[authEnv];
    if (token === undefined) {
      const envelope: CatalogPullEnvelope = {
        schemaVersion: 1, ok: false, status: "failed", catalogWritten: false,
        cacheSynced: false, codexRestarted: false, code: "auth_env_missing",
      };
      if (json) console.log(JSON.stringify(envelope));
      else console.error(`Catalog authentication environment variable ${authEnv} is not set.`);
      return 1;
    }
  }
  try {
    const result = await pullRemoteCatalog(positionals[1]!, { token });
    let codexRestarted = false;
    if (result.catalogWritten) {
      const processLog = json
        ? { log: (...values: unknown[]) => console.error(...values), error: (...values: unknown[]) => console.error(...values) }
        : console;
      const processResult = afterCatalogWriteHandleAppServers({ restart: restartCodex, log: processLog });
      codexRestarted = (processResult.restart?.stopped.length ?? 0) > 0;
    }
    const envelope: CatalogPullEnvelope = {
      schemaVersion: 1, ok: true, status: result.status,
      catalogWritten: result.catalogWritten, cacheSynced: result.cacheSynced,
      codexRestarted, modelCount: result.modelCount,
    };
    if (json) console.log(JSON.stringify(envelope));
    else if (result.status === "unchanged") console.log("Remote Codex catalog is unchanged; no files or processes were touched.");
    else console.log(`Remote Codex catalog installed (${result.modelCount} models) and models_cache.json synchronized.`);
    return 0;
  } catch (error) {
    const code = error instanceof RemoteCatalogError ? error.code : "write_failed";
    const envelope: CatalogPullEnvelope = {
      schemaVersion: 1, ok: false, status: "failed", catalogWritten: false,
      cacheSynced: false, codexRestarted: false, code,
    };
    if (json) console.log(JSON.stringify(envelope));
    else console.error(error instanceof RemoteCatalogError ? error.message : "Remote catalog installation failed");
    return code === "lock_busy" ? 3 : 1;
  }
}
