/**
 * "Saved, but some client catalogs did not refresh" after a model visibility write. The write
 * itself succeeded, so this is a warning, never an error; it lists each client that failed.
 */
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import type { ClientCatalogRefreshFailure } from "../model-visibility";
import { describeIntegrationRefusalParts } from "../pages/integrations/refusal-copy";

export function IntegrationRefreshWarning({ failures }: { failures: readonly ClientCatalogRefreshFailure[] }) {
  const t = useT();
  if (failures.length === 0) return null;
  return (
    <div className="models-integration-warning">
      <Notice tone="warn">
        {t("models.integrationRefreshWarning")}
        <ul>{failures.map(row => <li key={row.client + ":" + (row.profileId ?? "all")}>
          {row.client}{row.profileId === undefined ? "" : ":" + row.profileId}: {describeIntegrationRefusalParts(t, {
            clientId: row.client, message: row.reason === "integration_mutation_busy" ? t("integrations.error.busy") : row.reason,
            reason: row.refusalReason, snapshotPath: row.snapshotPath, residual: row.residual,
          })}
        </li>)}</ul>
      </Notice>
    </div>
  );
}

