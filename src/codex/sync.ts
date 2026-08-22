import { currentExternalCodexModelProvider, injectCodexConfig } from "./inject";
import { printProjectCodexConfigWarnings, groupProjectCodexConfigWarningsByPath, type ProjectCodexConfigWarning } from "./project-config-warnings";
import { refreshCodexModelCatalog } from "./refresh";
import { applyProxyEnv, loadConfig } from "../config";
import type { OcxConfig } from "../types";
import { collectOrcaCodexHomeDiagnostic } from "./home";
import { summarizeComboCatalogOmissions, type ComboCatalogOmission } from "./catalog/aggregation";
import { shouldSyncCodexOnStart } from "./desired-state";
import { admitCodexWrite, type CodexAdmission } from "./admission";
import type { CodexCatalogSyncOptions } from "./catalog/sync";

export interface CodexSyncResult {
  /**
   * `skipped` is policy truth, never evidence that Codex was written.
   * `catalog-only` means an explicit sync refreshed the catalog/cache while
   * Codex injection stayed OFF; config and history were not touched.
   */
  status: "applied" | "skipped" | "catalog-only" | "refused";
  ok: boolean;
  skippedReason?: "desired_disabled";
  /** Present when unattended convergence refused another service's native home. */
  authority?: "service-home";
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  comboOmissions?: ComboCatalogOmission[];
  nativeSubagentDefaultsWarning?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
  projectConfigGrouped?: { path: string; issues: string[]; bypass: string }[];
}

export interface CodexSyncOptions {
  /**
   * Explicit `ocx sync` is also the refresh path for side profiles that consume
   * the OpenCodex catalog without injection. When set, the sync still refreshes
   * the catalog and models cache even if the Codex integration toggle is OFF or
   * an external `model_provider` owns config.toml. Config/history injection is
   * skipped in those cases, so the behavior is harmless to a native home.
   */
  catalogEvenWhenNotInjected?: boolean;
}

type CodexSyncAdmission = Extract<CodexAdmission, { kind: "refused" }> | { readonly kind: "admitted" };

interface CodexSyncDeps {
  refreshCodexModelCatalog: typeof refreshCodexModelCatalog;
  injectCodexConfig: typeof injectCodexConfig;
  /** The sync entry only needs this admission's service-home verdict. */
  admitCodexWrite?: () => CodexSyncAdmission;
  currentExternalCodexModelProvider?: typeof currentExternalCodexModelProvider;
  collectCodexHomeDiagnostic?: typeof collectOrcaCodexHomeDiagnostic;
}

const defaultDeps: CodexSyncDeps = {
  refreshCodexModelCatalog,
  injectCodexConfig,
};

function reportCodexHomeTarget(
  log: Pick<Console, "log" | "error"> | null,
  collectDiagnostic: typeof collectOrcaCodexHomeDiagnostic,
): void {
  if (!log) return;
  const target = collectDiagnostic();
  log.log(`   Target Codex home: ${target.effectiveCodexHome}`);
  if (target.warning) {
    log.error(`WARNING: ${target.warning}`);
    log.error(`Action: ${target.action}`);
  }
}

export async function syncModelsToCodex(
  port?: number,
  config: OcxConfig = loadConfig(),
  log: Pick<Console, "log" | "error"> | null = console,
  deps: CodexSyncDeps = defaultDeps,
  options: CodexSyncOptions = {},
): Promise<CodexSyncResult> {
  // `config` can be the server's startup object. The decision, however, is a
  // durable user switch and must be read again at this production boundary: a
  // PUT OFF while provider discovery is in flight cannot be allowed to commit
  // through an older captured object.
  const desiredDisabled = !shouldSyncCodexOnStart(loadConfig());
  const catalogEvenWhenNotInjected = options.catalogEvenWhenNotInjected === true;
  if (desiredDisabled && !catalogEvenWhenNotInjected) {
    return {
      status: "skipped",
      skippedReason: "desired_disabled",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: "Codex integration is OFF; no Codex config, catalog, cache, or history was changed.",
    };
  }
  // Catalog gathering precedes injection and can itself write the native
  // catalog/cache. It therefore needs the same unattended service-home veto as
  // the injector, before it gets a chance to create any artifact.
  const admission = (deps.admitCodexWrite ?? admitCodexWrite)();
  if (admission.kind === "refused" && admission.authority === "service-home") {
    return {
      status: "refused",
      authority: "service-home",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: admission.message,
    };
  }
  const p = port ?? config.port ?? 10100;
  const externalProvider = (deps.currentExternalCodexModelProvider ?? currentExternalCodexModelProvider)();

  if (desiredDisabled && catalogEvenWhenNotInjected) {
    // Explicit `ocx sync` with the integration OFF: refresh the catalog/cache so
    // side profiles that route to the proxy keep their model list current, but
    // never touch config, journal, or history.
    applyProxyEnv(config);
    const refreshed = await refreshCatalogForSync(config, deps, { allowWhenDesiredDisabled: true }, log);
    const message = refreshed.catalogWritten || refreshed.cacheSynced
      ? "Codex integration is OFF; catalog and models cache refreshed, Codex config untouched."
      : "Codex integration is OFF; catalog refresh skipped, Codex config untouched.";
    return {
      status: "catalog-only",
      ok: true,
      ...refreshed,
      message,
      ...(refreshed.comboOmissions.length > 0 ? { comboOmissions: refreshed.comboOmissions } : {}),
    };
  }

  if (externalProvider) {
    if (catalogEvenWhenNotInjected) {
      // External providers own config.toml, and the injector removes the OpenCodex
      // journal for external providers (inject.ts). This explicit catalog-only sync
      // must not touch config, journal, or history, so refresh the catalog/cache and
      // return without injection.
      applyProxyEnv(config);
      const refreshed = await refreshCatalogForSync(config, deps, undefined, log);
      const message = refreshed.catalogWritten || refreshed.cacheSynced
        ? "External provider owns config.toml; catalog and models cache refreshed, Codex config/journal untouched."
        : "External provider owns config.toml; catalog refresh skipped, Codex config/journal untouched.";
      return {
        status: "catalog-only",
        ok: true,
        ...refreshed,
        message,
        ...(refreshed.comboOmissions.length > 0 ? { comboOmissions: refreshed.comboOmissions } : {}),
      };
    }
    const result = await deps.injectCodexConfig(p, config, {});
    if (result.success) log?.log(result.message);
    else log?.error(result.message);
    reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
    return {
      status: "applied",
      ok: result.success,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: result.message,
      ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    };
  }

  // Injection has deterministic refusal paths (for example an ambiguous marker-owned TOML
  // table) that do not depend on provider discovery. Exercise the SAME transformation and
  // coordination eligibility before catalog gathering: a known-bad config must not turn a
  // working catalog/cache into the partial result of an otherwise unnecessary refresh.
  const preflight = await deps.injectCodexConfig(p, config, { validateOnly: true });
  if (!preflight.success) {
    log?.error(preflight.message);
    reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
    return {
      status: "applied",
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: preflight.message,
      ...(preflight.nativeSubagentDefaultsWarning
        ? { nativeSubagentDefaultsWarning: preflight.nativeSubagentDefaultsWarning }
        : {}),
    };
  }

  applyProxyEnv(config); // `ocx ensure`/`ocx sync` fetch provider models outside the server process
  let added = 0;
  let catalogPath: string | null = null;
  let catalogPathForInjection: string | null | undefined;
  let catalogExists = false;
  let catalogWritten = false;
  let cacheSynced = false;
  let warning: string | undefined;
  let comboOmissions: ComboCatalogOmission[] = [];

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
    added = cat.added;
    catalogExists = cat.catalogExists;
    catalogWritten = cat.catalogWritten;
    cacheSynced = cat.cacheSynced;
    catalogPathForInjection = cat.catalogExists ? cat.path : null;
    catalogPath = catalogPathForInjection;
    comboOmissions = cat.comboOmissions ?? [];
    if (cat.added > 0) {
      log?.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (!cat.catalogExists) {
      warning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.";
      log?.error(warning);
    }
    if (comboOmissions.length > 0) {
      // Individual omission lines already went through console.warn during gather;
      // keep a single summary on the sync logger to avoid duplicate stderr noise.
      const summary = summarizeComboCatalogOmissions(comboOmissions);
      log?.error(summary);
      warning = warning ? `${warning} ${summary}` : summary;
    }
  } catch (e) {
    warning = `catalog sync skipped: ${e instanceof Error ? e.message : String(e)}`;
    log?.error(warning);
  }

  const result = await deps.injectCodexConfig(p, config, { catalogPath: catalogPathForInjection });
  if (result.status === "skipped") {
    return {
      status: "skipped",
      // The apply direction's only under-lock policy skip is desired OFF.
      skippedReason: "desired_disabled",
      ok: true,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: result.message,
    };
  }
  if (result.success) log?.log(result.message);
  else log?.error(result.message);
  reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
  const projectConfigWarnings = printProjectCodexConfigWarnings(log, { cwd: process.cwd() });
  return {
    status: "applied",
    ok: result.success,
    added,
    catalogPath,
    catalogExists,
    catalogWritten,
    cacheSynced,
    message: result.message,
    ...(warning ? { warning } : {}),
    ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    ...(projectConfigWarnings.length > 0 ? {
      projectConfigWarnings,
      projectConfigGrouped: groupProjectCodexConfigWarningsByPath(projectConfigWarnings),
    } : {}),
  };
}

async function refreshCatalogForSync(
  config: OcxConfig,
  deps: CodexSyncDeps,
  catalogOptions: CodexCatalogSyncOptions | undefined,
  log: Pick<Console, "log" | "error"> | null,
): Promise<{
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  comboOmissions: ComboCatalogOmission[];
  warning?: string;
}> {
  let added = 0;
  let catalogPath: string | null = null;
  let catalogExists = false;
  let catalogWritten = false;
  let cacheSynced = false;
  let warning: string | undefined;
  let comboOmissions: ComboCatalogOmission[] = [];
  try {
    const cat = await deps.refreshCodexModelCatalog(config, undefined, catalogOptions);
    added = cat.added;
    catalogExists = cat.catalogExists;
    catalogWritten = cat.catalogWritten;
    cacheSynced = cat.cacheSynced;
    catalogPath = cat.catalogExists ? cat.path : null;
    comboOmissions = cat.comboOmissions ?? [];
    if (cat.added > 0) {
      log?.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (!cat.catalogExists) {
      warning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.";
      log?.error(warning);
    }
    if (comboOmissions.length > 0) {
      const summary = summarizeComboCatalogOmissions(comboOmissions);
      log?.error(summary);
      warning = warning ? `${warning} ${summary}` : summary;
    }
  } catch (e) {
    warning = `catalog sync skipped: ${e instanceof Error ? e.message : String(e)}`;
    log?.error(warning);
  }
  return { added, catalogPath, catalogExists, catalogWritten, cacheSynced, comboOmissions, ...(warning ? { warning } : {}) };
}
