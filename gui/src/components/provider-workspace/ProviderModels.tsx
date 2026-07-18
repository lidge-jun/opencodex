/**
 * ProviderModels — the models tab (WP090): searchable, virtualized model list
 * with default/selected flags and copy-to-clipboard ids.
 */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useT } from "../../i18n";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { filterModels } from "../../provider-workspace/report";

export default function ProviderModels({
  item,
  availableModels,
  selectedModels,
  modelsLoading = false,
  modelsLoadFailed = false,
  onRetryModels,
}: {
  item: WorkspaceItem;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  onRetryModels?: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const models = useMemo(
    () => filterModels(availableModels, item.defaultModel, query),
    [availableModels, item.defaultModel, query],
  );

  const virtualize = models.length > 40;
  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const virtualizer = useVirtualizer({
    count: virtualize ? models.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedId(modelId);
      window.setTimeout(() => setCopiedId(prev => (prev === modelId ? null : prev)), 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const renderRow = (modelId: string, style?: CSSProperties) => {
    const isDefault = modelId === item.defaultModel;
    const isSelected = selectedSet.has(modelId);
    return (
      <div key={modelId} className="pws-model-row" style={style}>
        <span className="pws-model-id" title={modelId}>{modelId}</span>
        <span className="pws-model-meta">
          {isDefault ? <span className="pws-model-flag">{t("prov.defaultBadge")}</span> : null}
          {isSelected ? <span className="pws-model-flag pws-model-flag--selected">{t("pws.selected")}</span> : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { void copyModelId(modelId); }}
            aria-label={t("pws.copyModelId")}
          >
            {copiedId === modelId ? t("pws.modelCopied") : t("pws.copyModelId")}
          </button>
        </span>
      </div>
    );
  };

  const emptyBase = availableModels.length === 0 && !item.defaultModel;

  return (
    <div className="pws-section">
      <div className="pws-section-head">
        <h3 className="pws-section-title">{t("pws.tab.models")}</h3>
        {models.length > 0 && (
          <span className="muted">{t("pws.modelsAvailable", { count: models.length })}</span>
        )}
      </div>
      {!emptyBase && (
        <input
          type="search"
          className="input pws-model-search"
          placeholder={t("pws.modelSearchPlaceholder")}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label={t("pws.modelSearchPlaceholder")}
        />
      )}
      {modelsLoading && emptyBase ? (
        <p className="muted" role="status">{t("pws.modelsLoading")}</p>
      ) : modelsLoadFailed && emptyBase ? (
        <div role="alert" className="pws-inline-error">
          <span>{t("pws.modelsLoadFailed")}</span>
          {onRetryModels && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryModels}>
              {t("pws.retry")}
            </button>
          )}
        </div>
      ) : emptyBase ? (
        <p className="muted">{t("pws.noModels")}</p>
      ) : models.length === 0 ? (
        <p className="muted" role="status">{t("pws.noModelMatch")}</p>
      ) : virtualize ? (
        <div ref={listRef} className="pws-model-list pws-model-list--virtual">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map(row => (
              renderRow(models[row.index]!, {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: row.size,
                // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings
                transform: `translateY(${String(row.start)}px)`,
              })
            ))}
          </div>
        </div>
      ) : (
        <div className="pws-model-list">{models.map(id => renderRow(id))}</div>
      )}
    </div>
  );
}
