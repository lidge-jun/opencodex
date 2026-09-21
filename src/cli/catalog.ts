import { handleRestartScopeAfterWrite, readRestartScope } from "./restart-scope";
import { pullRemoteCatalog, RemoteCatalogError } from "../codex/catalog/remote";
import { hasHelpFlag, printSubcommandUsage } from "./help";

export interface CatalogPullEnvelope {
  schemaVersion: 1;
  ok: boolean;
  status: "updated" | "unchanged" | "failed";
  catalogWritten: boolean;
  cacheSynced: boolean;
  codexRestarted: boolean;
  /**
   * Whether the desktop app was actually restarted. Only ever true for a completed
   * relaunch: a handoff is not a success, because the restart has not happened yet when
   * this envelope is written and a script reading true would proceed on a promise.
   * Separate from codexRestarted so a script reading the existing field is not silently
   * handed a different answer.
   */
  desktopAppRestarted?: boolean;
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
  const restartScope = readRestartScope(args, console);
  const authEnv = optionValue(args, "--auth-env");
  const positionals = args.filter((arg, index) => {
    if (arg === "--auth-env") return false;
    if (index > 0 && args[index - 1] === "--auth-env") return false;
    return !arg.startsWith("-");
  });
  // A closed set: an unknown flag is a usage error, so the new scope flags have to be
  // listed here or catalog pull would reject the very flags sync accepts.
  const knownFlags = new Set([
    "--json", "--restart-codex", "--restart-desktop-app", "--restart-app-server-only", "--auth-env",
  ]);
  const unknown = args.find((arg, index) => arg.startsWith("-") && !knownFlags.has(arg) && args[index - 1] !== "--auth-env");
  const validEnvName = authEnv === undefined || /^[A-Za-z_][A-Za-z0-9_]*$/.test(authEnv);
  if (positionals[0] !== "pull" || positionals.length !== 2 || unknown || !validEnvName
    || args.includes("--auth-env") !== (authEnv !== undefined)) {
    const envelope: CatalogPullEnvelope = {
      schemaVersion: 1, ok: false, status: "failed", catalogWritten: false,
      cacheSynced: false, codexRestarted: false, code: "usage",
    };
    if (json) console.log(JSON.stringify(envelope));
    else console.error("Usage: ocx catalog pull <https-url> [--auth-env <NAME>] [--json] [--restart-codex] [--restart-app-server-only]");
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
    let desktopAppRestarted = false;
    let restartIncomplete = false;
    if (result.catalogWritten) {
      const processLog = json
        ? { log: (...values: unknown[]) => console.error(...values), error: (...values: unknown[]) => console.error(...values) }
        : console;
      const outcome = await handleRestartScopeAfterWrite(restartScope, processLog);
      const processResult = outcome.appServers;
      const restart = processResult?.restart;
      desktopAppRestarted = outcome.desktopApp?.relaunch === "started";
      // A desktop restart that was asked for and did not relaunch is an incomplete
      // restart, exactly like a surviving app-server. Without this the pull reports
      // ok: true while the picker the operator was fixing is still stale.
      // "Desktop app is not running" is the same nothing-to-do the app-server half
      // already treats as success, so it must not read as an incomplete restart.
      if (restartScope.desktopApp && !desktopAppRestarted
        && outcome.desktopApp?.reason !== "no_targets") {
        restartIncomplete = true;
      }
      if (restart) {
        // A partial stop is not a restart. `restartCodexAppServers` reports failures and
        // survivors without throwing, so counting `stopped` alone reported success while a
        // stale app-server was still serving the previous catalog from memory.
        codexRestarted = restart.failed.length === 0
          && restart.surviving.length === 0
          && restart.stopped.length === (processResult?.processes.length ?? -1);
        // Do not ASSIGN here: the desktop half may already have set this, and assigning
        // would discard a failed desktop restart whenever any app-server was signalled.
        if (!codexRestarted) restartIncomplete = true;
      }
    }
    if (restartIncomplete) {
      // The catalog and cache landed; only the restart did not finish. Saying the pull failed
      // and wrote nothing would be a second false report, so the envelope keeps the real
      // write state and `ok` carries the failure.
      const envelope: CatalogPullEnvelope = {
        schemaVersion: 1, ok: false, status: result.status,
        catalogWritten: result.catalogWritten, cacheSynced: result.cacheSynced,
        codexRestarted: false,
        ...(restartScope.desktopApp ? { desktopAppRestarted } : {}),
        modelCount: result.modelCount, code: "restart_incomplete",
      };
      if (json) console.log(JSON.stringify(envelope));
      else console.error("Remote Codex catalog installed, but a Codex app-server is still running the previous catalog.");
      return 1;
    }
    const envelope: CatalogPullEnvelope = {
      schemaVersion: 1, ok: true, status: result.status,
      catalogWritten: result.catalogWritten, cacheSynced: result.cacheSynced,
      codexRestarted,
        ...(restartScope.desktopApp ? { desktopAppRestarted } : {}), modelCount: result.modelCount,
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
