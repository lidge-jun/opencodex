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
  const snapshot = createPickerModelSnapshot(async () => {
    await ensureRegistry();
    return options.loadRoutes();
  }, join(claudeInterceptStateDir(options.configDir), CLI_PICKER_MODELS_FILE), buildCliPickerModels);
  const coldWaitMs = options.coldWaitMs ?? CLI_PICKER_COLD_WAIT_MS;
  const bounded = async (work: Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, coldWaitMs); })]);
    clearTimeout(timer);
  };
  return async (req, kind) => {
    if (!cliCatalogEligible(kind, req.headers.get("user-agent"), options.desiredClients())) return null;
    if (snapshot.current() === null) {
      await bounded(snapshot.refresh());
    } else {
      snapshot.refreshIfStale(CLI_PICKER_MODELS_MAX_AGE_MS);
    }
    const current = snapshot.current();
    if (!current) return null;
    // A persisted snapshot can outlive the registry it was built against (a restart starts with an
    // empty one): wait, within the same bound, for the shared build before re-checking, since an
    // empty answer here is what the CLI would cache for the next hour.
    if (routableCliPickerModels(current.models).length < current.models.length) await bounded(ensureRegistry());
    return routableCliPickerModels(current.models);
  };
}
