import { useDataSurface } from "../data-surface";
import { useT } from "../i18n/shared";
import { Notice, Select } from "../ui";
import { advisorModelValues, type AdvisorModelRow } from "../advisor-models";

export function AdvisorModelSelect({ apiBase, value, disabled, onChange }: {
  apiBase: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const resource = useDataSurface<AdvisorModelRow[]>(
    `advisor-models:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/models`, { signal });
      if (!response.ok) throw new Error(String(response.status));
      const rows: unknown = await response.json();
      if (!Array.isArray(rows) || !rows.every(row => row && typeof row.namespaced === "string" && row.namespaced.length > 0)) {
        throw new Error("Invalid model catalog");
      }
      return rows as AdvisorModelRow[];
    },
    { isEmpty: rows => rows.length === 0 },
  );
  const { state } = resource;
  const values = advisorModelValues(state.data ?? []);
  const unavailable = value !== "" && !values.includes(value);
  const options = [
    { value: "", label: t("advisor.modelClear") },
    ...(unavailable ? [{ value, label: value }] : []),
    ...values.map(model => ({ value: model, label: model })),
  ];
  return (
    <div aria-busy={state.showSkeleton || state.refreshing}>
      <Select id="advisor-model" value={value} options={options}
        label={t("advisor.model")} describedBy="advisor-model-hint"
        disabled={disabled || state.showSkeleton} onChange={onChange} />
      <p id="advisor-model-hint" className="muted setting-hint">{t("advisor.modelHint")}</p>
      {state.showSkeleton && <Notice tone="warn">{t("common.loading")}</Notice>}
      {state.showError && !state.showSkeleton && (
        <Notice tone="err">
          {t("advisor.modelsLoadFailed")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled}
            onClick={() => resource.refresh()}>{t("common.retry")}</button>
        </Notice>
      )}
      {!state.showSkeleton && !state.showError && values.length === 0 && (
        <Notice tone="warn">
          {t("advisor.modelsEmpty")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" disabled={disabled}
            onClick={() => resource.refresh()}>{t("common.retry")}</button>
        </Notice>
      )}
      {!state.showSkeleton && !state.showError && unavailable && <Notice tone="warn">{t("advisor.modelUnavailable")}</Notice>}
    </div>
  );
}
