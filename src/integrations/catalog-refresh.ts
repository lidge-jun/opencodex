import { siblingOfLivePort } from "../codex/sibling-start";
import { redactSecretString } from "../lib/redact";
import type { ExportModel } from "../clients/config-export";
import type { IntegrationClientId } from "./registry";
import type { CoordinatedIntegrationOptions, WriteOutcome } from "./writer";
import {
  refreshOwnedIntegration,
  type OwnedIntegrationRefreshInput,
  type OwnedIntegrationRefreshOutcome,
} from "./owned-refresh";

/** Refresh only previously connected clients; a refused file never blocks its peers. */
export async function refreshOwnedCatalogIntegrations(
  input: Omit<OwnedIntegrationRefreshInput, "clientId">,
  clientIds: readonly IntegrationClientId[] = ["pi", "aside", "raycast", "omo", "commandcode", "droid", "opencode", "kilo"],
  options: { refreshOnly?: boolean; admit?: () => boolean } = {},
): Promise<OwnedIntegrationRefreshOutcome[]> {
  // Client files are shared with the live proxy a sibling instance runs beside; their entries
  // point at the owner's port, and refreshing them here would re-point them at this one.
  if (siblingOfLivePort() !== null) return [];
  let models: Promise<readonly ExportModel[]> | undefined;
  const loadModels = () => models ??= Promise.resolve().then(() =>
    typeof input.models === "function" ? input.models() : input.models);
  const outcomes: OwnedIntegrationRefreshOutcome[] = [];
  const admit = options.admit;
  const writeOptions: CoordinatedIntegrationOptions | undefined = admit ? {
    guard: (frozen): WriteOutcome | null => admit() ? null : {
      ok: false, reason: "superseded_store", state: "current", clientId: frozen.clientId,
      message: "Background refresh superseded",
    },
  } : undefined;
  for (const clientId of clientIds) {
    if (admit?.() === false) break;
    try {
      if (clientId === "aside") {
        const { refreshAsideProfiles } = await import("./aside-profiles");
        const asideOptions = options.refreshOnly === undefined ? writeOptions
          : { ...writeOptions, refreshOnly: options.refreshOnly };
        const bound = { ...input, models: loadModels };
        outcomes.push(...await (asideOptions === undefined
          ? refreshAsideProfiles(bound) : refreshAsideProfiles(bound, asideOptions)));
        continue;
      }
      const bound = { ...input, clientId, models: loadModels };
      const result = await (writeOptions === undefined
        ? refreshOwnedIntegration(bound) : refreshOwnedIntegration(bound, writeOptions));
      if (result) outcomes.push(result);
    } catch (error) {
      const busy = error !== null && typeof error === "object"
        && "code" in error && error.code === "integration_mutation_busy";
      outcomes.push({
        client: clientId,
        ok: false,
        reason: busy ? "integration_mutation_busy"
          : redactSecretString(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return outcomes;
}
