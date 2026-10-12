import type { ExportModel } from "../clients/config-export";
import { guardAsideProfileIO, listAsideProfiles } from "../clients/aside-profiles";
import { loadConfig } from "../config";
import { listAsideProfileStores } from "../integrations/aside-profile-context";
import { isIntegrationClientId, type IntegrationClientId } from "../integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../integrations/store";
import { disableIntegrationCoordinated, type WriteOutcome } from "../integrations/writer";
import { loadExportModels } from "../server/management/model-rows";
import type { OcxConfig } from "../types";

export interface UninstallIntegrationCleanupDeps {
  createStore: () => IntegrationStateStore;
  loadConfig: () => OcxConfig;
  loadModels: (config: OcxConfig) => Promise<ExportModel[]>;
  disable: (input: Parameters<typeof disableIntegrationCoordinated>[0]) => Promise<WriteOutcome>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const defaults: UninstallIntegrationCleanupDeps = {
  createStore: () => createIntegrationStateStore(),
  loadConfig,
  loadModels: config => loadExportModels(config),
  disable: input => disableIntegrationCoordinated(input),
};

export interface UninstallIntegrationCleanupResult {
  attempted: number;
  changed: number;
}

/**
 * Remove every contribution we can still prove we own before uninstall deletes that proof.
 * A single refusal aborts config removal: preserving recovery state is safer than leaving an
 * external client pointed at a proxy that no longer exists.
 */
export async function cleanupOwnedIntegrationsBeforeUninstall(
  deps: UninstallIntegrationCleanupDeps = defaults,
): Promise<UninstallIntegrationCleanupResult> {
  const store = deps.createStore();
  const records = store.readRecordsStrict();
  const rawIds = Object.keys(records);
  for (const id of rawIds) {
    if (!isIntegrationClientId(id)) {
      throw new Error(`integration cleanup refused: ownership names unknown client ${id}`);
    }
  }
  type CleanupTarget = Pick<Parameters<typeof disableIntegrationCoordinated>[0], "clientId" | "store" | "io" | "resolvedPaths">
    & { store: IntegrationStateStore; profileId?: number };
  const targets: CleanupTarget[] = (rawIds as IntegrationClientId[]).sort()
    .map(clientId => ({ clientId, store }));
  // Read every child before any mutation. A broken child must not look like no ownership.
  for (const child of listAsideProfileStores(store)) {
    const childRecords = child.store.readRecordsStrict();
    if (Object.keys(childRecords).some(id => id !== "aside")) {
      throw new Error("integration cleanup refused: Aside profile storage names another client");
    }
    if (childRecords.aside) targets.push({ clientId: "aside", ...child });
  }
  if (targets.length === 0) return { attempted: 0, changed: 0 };

  const asideTargets = targets.filter(target => target.clientId === "aside");
  if (asideTargets.length > 0) {
    const profiles = listAsideProfiles(deps.env, deps.home);
    const claimedProfiles = new Set<number>();
    for (const target of asideTargets) {
      const record = target.store.readRecordsStrict().aside;
      const profile = profiles.find(candidate => candidate.configPath === record?.configPath
        && (target.profileId === undefined || target.profileId === candidate.id));
      if (!profile || claimedProfiles.has(profile.id)) {
        throw new Error("integration cleanup refused: Aside profile ownership is missing or mismatched");
      }
      claimedProfiles.add(profile.id);
      target.resolvedPaths = { configPath: profile.configPath, detectDir: profile.detectDir };
      // io() closes over the raw store; route bookkeeping back through its guarded facade.
      target.io = guardAsideProfileIO(profile, {
        ...target.store.io(),
        appendJournal: entry => target.store.appendJournal(entry),
        putRecord: record => target.store.putRecord(record),
        dropRecord: clientId => target.store.dropRecord(clientId),
      }, profiles);
    }
  }

  const config = deps.loadConfig();
  const models = await deps.loadModels(config);
  let changed = 0;
  for (const { clientId, store: targetStore, io, resolvedPaths } of targets) {
    const result = await deps.disable({
      clientId,
      models,
      config,
      port: config.port,
      store: targetStore,
      ...(io ? { io } : {}),
      ...(resolvedPaths ? { resolvedPaths } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.home ? { home: deps.home } : {}),
    });
    if (!result.ok) {
      throw new Error(`integration cleanup refused for ${clientId}: ${result.message}`
        + (result.residual ? "; recovery did not complete; inspect the client file and retained snapshots before retrying" : ""));
    }
    if (targetStore.readRecordsStrict()[clientId]) {
      throw new Error(`integration cleanup did not retire ownership for ${clientId}`);
    }
    if (result.changed) changed++;
  }
  // A profile can gain ownership while catalog loading or an earlier disable awaited its lock.
  if ([store, ...listAsideProfileStores(store).map(child => child.store)]
    .some(current => Object.keys(current.readRecordsStrict()).length > 0)) {
    throw new Error("integration cleanup refused: ownership changed before removal");
  }
  return { attempted: targets.length, changed };
}
