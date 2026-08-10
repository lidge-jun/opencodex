import { type Dispatch, type SetStateAction } from "react";
import { IconChevron, IconSearch } from "../icons";
import type { TFn } from "../i18n/shared";
import { EmptyState } from "../ui";
import { formatProviderDisplayName } from "../provider-icons";
import type { ModelInfo } from "./dashboard-shared";

export function DashboardModelsSection({
  t,
  models,
  modelsLoading,
  modelQuery,
  setModelQuery,
  filteredGroups,
  expandedProviders,
  setExpandedProviders,
}: {
  t: TFn;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelQuery: string;
  setModelQuery: (v: string) => void;
  filteredGroups: Array<[string, ModelInfo[]]>;
  expandedProviders: Set<string>;
  setExpandedProviders: Dispatch<SetStateAction<Set<string>>>;
}) {
  return (
    <>
      <div className="h-section">
        {t("dash.availableModels")} <span className="count">{models.length}</span>
        {modelsLoading && <span className="spin" style={{ marginLeft: 4 }} />}
      </div>
      {models.length === 0 && !modelsLoading ? (
        <EmptyState title={t("dash.noModels")} />
      ) : (
        <>
          <div className="pws-search-wrap">
            <IconSearch className="pws-search-icon" width={14} height={14} aria-hidden="true" />
            <input
              type="search"
              className="input pws-search-input"
              placeholder={t("models.search")}
              value={modelQuery}
              onChange={e => setModelQuery(e.target.value)}
              aria-label={t("models.search")}
            />
          </div>
          {filteredGroups.length === 0 ? (
            <p className="muted text-control" style={{ margin: "4px 0" }}>{t("dash.modelsNoResults")}</p>
          ) : (
            <div className="dash-model-acc">
              {filteredGroups.map(([provider, rows]) => {
                const q = modelQuery.trim().toLowerCase();
                const open = q !== "" || expandedProviders.has(provider);
                return (
                  <div key={provider} className="dash-model-group">
                    <button
                      type="button"
                      className="dash-model-head"
                      onClick={() => setExpandedProviders(prev => { const next = new Set(prev); if (next.has(provider)) next.delete(provider); else next.add(provider); return next; })}
                      aria-expanded={open}
                    >
                      <IconChevron width={12} height={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s", color: "var(--muted)" }} aria-hidden="true" />
                      <span className="font-semibold">{formatProviderDisplayName(provider, t)}</span>
                      <span className="count">{rows.length}</span>
                    </button>
                    {open && (
                      <div className="dash-model-chips">
                        {rows.map(m => (
                          <code key={`${m.provider}/${m.id}`} className="dash-model-chip">{m.id}</code>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
