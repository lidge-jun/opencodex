import { currentExternalCodexModelProvider, injectCodexConfig } from "./inject";
import { printProjectCodexConfigWarnings, groupProjectCodexConfigWarningsByPath, type ProjectCodexConfigWarning } from "./project-config-warnings";
import { refreshCodexModelCatalog } from "./refresh";
import { applyProxyEnv, loadConfig } from "../config";
import type { OcxConfig } from "../types";

export interface CodexSyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
  projectConfigGrouped?: { path: string; issues: string[]; bypass: string }[];
}

interface CodexSyncDeps {
  refreshCodexModelCatalog: typeof refreshCodexModelCatalog;
  injectCodexConfig: typeof injectCodexConfig;
  currentExternalCodexModelProvider?: typeof currentExternalCodexModelProvider;
}

const defaultDeps: CodexSyncDeps = {
  refreshCodexModelCatalog,
  injectCodexConfig,
};

export async function syncModelsToCodex(
  port?: number,
  config: OcxConfig = loadConfig(),
  log: Pick<Console, "log" | "error"> | null = console,
  deps: CodexSyncDeps = defaultDeps,
): Promise<CodexSyncResult> {
  const p = port ?? config.port ?? 10100;
  const externalProvider = (deps.currentExternalCodexModelProvider ?? currentExternalCodexModelProvider)();
  if (externalProvider) {
    const result = await deps.injectCodexConfig(p, config, {});
    log?.log(result.message);
    return {
      ok: result.success,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      cacheSynced: false,
      message: result.message,
    };
  }

  applyProxyEnv(config); // `ocx ensure`/`ocx sync` fetch provider models outside the server process
  let added = 0;
  let catalogPath: string | null = null;
  let catalogPathForInjection: string | null | undefined;
  let catalogExists = false;
  let cacheSynced = false;
  let warning: string | undefined;

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
    added = cat.added;
    catalogExists = cat.catalogExists;
    cacheSynced = cat.cacheSynced;
    catalogPathForInjection = cat.catalogExists ? cat.path : null;
    catalogPath = catalogPathForInjection;
    if (cat.added > 0) {
      log?.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (!cat.catalogExists) {
      warning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.";
      log?.error(warning);
    }
  } catch (e) {
    warning = `catalog sync skipped: ${e instanceof Error ? e.message : String(e)}`;
    log?.error(warning);
  }

  const result = await deps.injectCodexConfig(p, config, { catalogPath: catalogPathForInjection });
  log?.log(result.message);
  const projectConfigWarnings = printProjectCodexConfigWarnings(log, { cwd: process.cwd() });
  return {
    ok: result.success,
    added,
    catalogPath,
    catalogExists,
    cacheSynced,
    message: result.message,
    ...(warning ? { warning } : {}),
    ...(projectConfigWarnings.length > 0 ? {
      projectConfigWarnings,
      projectConfigGrouped: groupProjectCodexConfigWarningsByPath(projectConfigWarnings),
    } : {}),
  };
}
