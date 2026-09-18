import { useI18n, type TKey } from "../i18n/shared";

function formatFetchTime(value: string | undefined, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ModelCatalogStateSummary({
  subtitleKey,
  catalogSyncedAt,
}: {
  subtitleKey: TKey;
  catalogSyncedAt?: string;
}) {
  const { locale, t } = useI18n();
  if (subtitleKey !== "models.subtitle") return <p className="page-sub">{t(subtitleKey)}</p>;
  const fetchedAt = formatFetchTime(catalogSyncedAt, locale);
  const rows: Array<[string, string]> = [
    [t("models.catalogState.saved"), t("models.catalogState.savedDetail")],
    [t("models.catalogState.fetched"), fetchedAt
      ? t("models.catalogState.fetchedAt", { time: fetchedAt })
      : t("models.catalogState.fetchedUnknown")],
    [t("models.catalogState.active"), t("models.catalogState.activeUnverified")],
  ];
  return <>
    <p className="page-sub">{t(subtitleKey)}</p>
    <dl className="card" aria-label={t("models.catalogState.label")} style={{ margin: "-10px 0 22px", maxWidth: "var(--prose-measure)" }}>
      {rows.map(([label, detail], index) => <div key={label} className="card-row" style={{ alignItems: "flex-start", gap: 12, borderBottom: index < rows.length - 1 ? "1px solid var(--border-soft)" : undefined }}>
        <dt style={{ flex: "0 1 180px", fontWeight: "var(--weight-semibold)" }}>{label}</dt>
        <dd className="card-sub" style={{ flex: "1 1 280px", margin: 0, padding: 0 }}>{detail}</dd>
      </div>)}
    </dl>
  </>;
}
