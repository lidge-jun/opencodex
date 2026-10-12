/**
 * The Claude Code CLI picker's model source for the intercept listener's `cliCatalog` hook.
 *
 * Independent of Desktop picker mode: it needs only the intercept pair and CLI first-party intent.
 * Discovery runs lazily, on the first eligible catalog request, and the result is persisted so a
 * restart answers immediately. A cold start waits briefly for the Desktop 3P registry (the aliases
 * must decode before they are advertised) and for one discovery; past that bound the catalog relays
 * unchanged rather than holding the CLI's own request open.
 */
import { join } from "node:path";
import type { OcxConfig } from "../../types";
import { desktop3pRegistrySize } from "../desktop-3p";
import type { ClaudeFirstPartyDesired } from "../first-party-settings";
import { cliCatalogEligible, type CliCatalogKind } from "./cli-catalog";
import { claudeInterceptStateDir } from "./local-ca";
import type { PickerModelEntry } from "./picker-bootstrap";
import { buildCliPickerModels, createPickerModelSnapshot, routableCliPickerModels, type PickerRouteInput } from "./picker-models";

export const CLI_PICKER_MODELS_FILE = "cli-picker-models.json";
export const CLI_PICKER_MODELS_MAX_AGE_MS = 5 * 60_000;
/** The CLI times its catalog fetch out after a few seconds; a cold build must answer well inside it. */
export const CLI_PICKER_COLD_WAIT_MS = 2_500;

export interface CliCatalogProviderOptions {
  configDir: string;
  loadRoutes: () => Promise<PickerRouteInput>;
  desiredClients: () => ClaudeFirstPartyDesired;
  /** Resolves once Desktop 3P aliases decode; defaults to the shared startup build. */
  ensureRegistry?: () => Promise<void>;
  /** Whether the registry holds aliases; defaults to the installed Desktop 3P registry. */
  registryReady?: () => boolean;
  coldWaitMs?: number;
}

async function defaultEnsureRegistry(): Promise<void> {
  const [{ ensureDesktop3pRegistry }, { loadConfig }] = await Promise.all([
    import("../desktop-3p-startup"),
    import("../../config"),
  ]);
  await ensureDesktop3pRegistry(loadConfig as () => OcxConfig);
}

export function createCliCatalogProvider(options: CliCatalogProviderOptions): (req: Request, kind: CliCatalogKind) => Promise<readonly PickerModelEntry[] | null> {
  const ensureRegistry = options.ensureRegistry ?? defaultEnsureRegistry;
  const registryReady = options.registryReady ?? (() => desktop3pRegistrySize() > 0);
  const snapshot = createPickerModelSnapshot(async () => {
    await ensureRegistry();
    // A failed build resolves into its retry cooldown with an empty registry. Building rows then
    // would persist an empty list over the last good snapshot, so fail the refresh instead and keep it.
    if (!registryReady()) throw new Error("Desktop 3P registry unavailable");
    return options.loadRoutes();
  }, join(claudeInterceptStateDir(options.configDir), CLI_PICKER_MODELS_FILE), buildCliPickerModels);
  const coldWaitMs = options.coldWaitMs ?? CLI_PICKER_COLD_WAIT_MS;
  // Every wait in one request shares a single deadline, so the whole answer stays inside coldWaitMs.
  const bounded = async (work: () => Promise<unknown>, deadline: number): Promise<void> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); })]);
    clearTimeout(timer);
  };
  return async (req, kind) => {
    if (!cliCatalogEligible(kind, req.headers.get("user-agent"), options.desiredClients())) return null;
    const deadline = Date.now() + coldWaitMs;
    if (snapshot.current() === null) {
      await bounded(() => snapshot.refresh(), deadline);
    } else {
      snapshot.refreshIfStale(CLI_PICKER_MODELS_MAX_AGE_MS);
    }
    const current = snapshot.current();
    if (!current) return null;
    // A persisted snapshot can outlive the registry it was built against: a restart starts with an
    // empty registry, and a provider change retires routes the snapshot still lists. An answer
    // missing those rows is what the CLI would cache for the next hour, so first wait for the shared
    // registry build, and if rows still do not decode, rebuild the snapshot from the current routes
    // before answering, all within the request's one deadline.
    const stale = (models: readonly PickerModelEntry[]): boolean => routableCliPickerModels(models).length < models.length;
    if (stale(current.models)) await bounded(ensureRegistry, deadline);
    if (stale(snapshot.current()!.models)) await bounded(() => snapshot.refresh(), deadline);
    return routableCliPickerModels(snapshot.current()!.models);
  };
}
