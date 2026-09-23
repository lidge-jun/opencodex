import { useI18n } from "../i18n/shared";

function formatSyncTime(value: string | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/*
 * How a saved catalog reaches Codex, folded to one line under the Models subtitle.
 * Standalone installs have two steps (save here, Codex loads it on restart). An `ocx connect`
 * client adds the hub sync in between; `catalogSyncedAt` exists only in that mode.
 * The honesty contract from #5031 stays: a sync time does not prove it includes the latest
 * hub save, and OpenCodex cannot see which list a running Codex uses.
 */
export function ModelCatalogDelivery({ connected, catalogSyncedAt }: { connected: boolean; catalogSyncedAt?: string }) {
  const { locale, t } = useI18n();
  const syncedAt = formatSyncTime(catalogSyncedAt, locale);
  const steps: Array<{ id: string; chip: string; title: string; body: string }> = connected
    ? [
      { id: "saved", chip: t("models.delivery.chip.savedHub"), title: t("models.delivery.savedHub.title"), body: t("models.delivery.savedHub.body") },
      {
        id: "synced",
        chip: syncedAt ? t("models.delivery.chip.synced", { time: syncedAt }) : t("models.delivery.chip.syncedUnknown"),
        title: t("models.delivery.synced.title"),
        body: syncedAt ? t("models.delivery.synced.bodyAt", { time: syncedAt }) : t("models.delivery.synced.bodyUnknown"),
      },
    ]
    : [{ id: "saved", chip: t("models.delivery.chip.saved"), title: t("models.delivery.saved.title"), body: t("models.delivery.saved.body") }];
  steps.push({ id: "loaded", chip: t("models.delivery.chip.loaded"), title: t("models.delivery.loaded.title"), body: t("models.delivery.loaded.body") });
  return (
    <details className="models-delivery">
      <summary>
        <span className="models-delivery-title">{t("models.delivery.title")}</span>
        <span className="models-delivery-flow">{steps.map(step => step.chip).join(" → ")}</span>
      </summary>
      <ol className="models-delivery-steps">
        {steps.map(step => (
          <li key={step.id} data-step={step.id}>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
      <p className="models-delivery-hint">{t("models.delivery.hint")}</p>
    </details>
  );
}
