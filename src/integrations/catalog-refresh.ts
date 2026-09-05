import { redactSecretString } from "../lib/redact";
import type { ExportModel } from "../clients/config-export";
import type { IntegrationClientId } from "./registry";
import {
  refreshOwnedIntegration,
  type OwnedIntegrationRefreshInput,
  type OwnedIntegrationRefreshOutcome,
} from "./owned-refresh";

/** Refresh only previously connected clients; a refused file never blocks its peers. */
export async function refreshOwnedCatalogIntegrations(
  input: Omit<OwnedIntegrationRefreshInput, "clientId">,
  clientIds: readonly IntegrationClientId[] = ["pi", "aside"],
): Promise<OwnedIntegrationRefreshOutcome[]> {
  let models: Promise<readonly ExportModel[]> | undefined;
  const loadModels = () => models ??= Promise.resolve().then(() =>
    typeof input.models === "function" ? input.models() : input.models);
  const outcomes: OwnedIntegrationRefreshOutcome[] = [];
  for (const clientId of clientIds) {
    try {
      const result = await refreshOwnedIntegration({ ...input, clientId, models: loadModels });
      if (result) outcomes.push(result);
    } catch (error) {
      outcomes.push({
        client: clientId,
        ok: false,
        reason: redactSecretString(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return outcomes;
}
