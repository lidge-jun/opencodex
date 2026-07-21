/**
 * ProviderModels — the models tab: searchable wrapping model chips with
 * default/selected flags and copy-to-clipboard ids. Uses a wrap layout so
 * short lists fill horizontal space instead of a tall single-column stack.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { filterModels } from "../../provider-workspace/report";

export default function ProviderModels({
  item,
  availableModels,
  selectedModels,
  modelsLoading = false,
  modelsLoadFailed = false,
  needsReauth = false,
  onRetryModels,
  onOpenAccounts,
}: {
  item: WorkspaceItem;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  /** Active OAuth account needs a fresh login before live discovery works. */
  needsReauth?: boolean;
  onRetryModels?: () => void;
  onOpenAccounts?: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const configuredModels = useMemo(() => item.models ?? [], [item.models]);
  const models = useMemo(
    () => filterModels(availableModels, item.defaultModel, query, configuredModels),
    [availableModels, item.defaultModel, query, configuredModels],
  );

  useEffect(() => () => {
    if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
  }, []);

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedId(modelId);
      if (copyResetRef.current != null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => {
        setCopiedId(prev => (prev === modelId ? null : prev));
        copyResetRef.current = null;
      }, 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const emptyBase = availableModels.length === 0 && configuredModels.length === 0 && !item.defaultModel;
  const showingConfiguredFallback = availableModels.length === 0 && configuredModels.length > 0;
  // Aggregators (OpenRouter etc.) can return thousands of ids; capping the mounted
  // chips keeps the tab responsive. Filtering narrows the list, so the cap only
  // bites on the unfiltered full catalog.
  const CHIP_RENDER_CAP = 300;
  const capped = models.length > CHIP_RENDER_CAP;
  const visibleModels = capped ? models.slice(0, CHIP_RENDER_CAP) : models;

  return (
    <div className="pws-section">
      <div className="pws-section-head">
        <h3 className="pws-section-title">{t("pws.tab.models")}</h3>
        {models.length > 0 && (
          <span className="muted">{t("pws.modelsAvailable", { count: models.length })}</span>
        )}
      </div>
      {needsReauth && (
        <div className="pws-inline-error" role="status">
          <span>{t("pws.modelsNeedsReauth")}</span>
          {onOpenAccounts && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAccounts}>
              {t("pws.tab.accounts")}
            </button>
          )}
        </div>
      )}
      {showingConfiguredFallback && !needsReauth && (
        <p className="muted text-label" style={{ marginBottom: 10 }}>{t("pws.modelsConfiguredFallback")}</p>
      )}
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
      ) : (
        <div className="pws-model-list" role="list">
          {visibleModels.map(modelId => {
            const isDefault = modelId === item.defaultModel;
            const isSelected = selectedSet.has(modelId);
            const copied = copiedId === modelId;
            return (
              <div key={modelId} className="pws-model-chip" role="listitem">
                <button
                  type="button"
                  className="pws-model-chip-main"
                  onClick={() => { void copyModelId(modelId); }}
                  title={modelId}
                  aria-label={copied ? t("pws.modelCopied") : t("pws.copyModelId")}
                >
                  <span className="pws-model-id">{modelId}</span>
                </button>
                {isDefault ? <span className="badge badge-muted pws-model-flag">{t("prov.defaultBadge")}</span> : null}
                {isSelected ? <span className="badge badge-accent pws-model-flag">{t("pws.selected")}</span> : null}
              </div>
            );
          })}
        </div>
      )}
      {capped && (
        <p className="muted text-label" style={{ marginTop: 10 }}>
          {t("pws.modelsTruncated", { shown: String(CHIP_RENDER_CAP), total: String(models.length) })}
        </p>
      )}
    </div>
  );
}
