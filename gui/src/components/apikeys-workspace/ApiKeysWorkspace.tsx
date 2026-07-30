/**
 * ApiKeysWorkspace — rail + main for the API tab. Overview hosts the existing
 * endpoint/auth/generate/models/usage panels; selecting a key opens detail.
 */
import { useEffect, useState } from "react";
import { IconChevron, IconTrash } from "../../icons";
import { useT } from "../../i18n/shared";
import type { ExternalModelRow } from "../../api-access-models";
import {
  formatCreatedDate,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTestState,
} from "../../pages/api-keys-utils";
import {
  ApiKeysEndpointsPanel,
  ApiKeysManagePanel,
  ApiKeysModelsPanel,
  ApiKeysUsagePanel,
} from "../../pages/api-keys-panels";

export interface ApiKeysWorkspaceProps {
  keys: ApiKeyEntry[];
  keysLoading: boolean;
  keysLoadFailed: boolean;
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
  localeTag?: string;
  newName: string;
  creating: boolean;
  newKey: string | null;
  copied: boolean;
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  modelQuery: string;
  copiedModelId: string | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  onNewNameChange: (value: string) => void;
  onCreate: () => void;
  onDismissNewKey: () => void;
  onCopyKey: () => void;
  onDelete: (id: string) => void;
  onModelQueryChange: (value: string) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow) => void;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: string) => string;
}

export default function ApiKeysWorkspace({
  keys,
  keysLoading,
  keysLoadFailed,
  endpoints,
  claudeCodeEnabled,
  localeTag,
  newName,
  creating,
  newKey,
  copied,
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  copiedModelId,
  modelTests,
  onNewNameChange,
  onCreate,
  onDismissNewKey,
  onCopyKey,
  onDelete,
  onModelQueryChange,
  onCopyModelId,
  onTestModel,
  sourceLabel,
  protocolLabel,
}: ApiKeysWorkspaceProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Armed after a short delay so a double-click / retained focus cannot confirm immediately. */
  const [confirmArmed, setConfirmArmed] = useState(false);

  const selected = selectedId ? (keys.find(k => k.id === selectedId) ?? null) : null;

  const clearDeleteConfirm = () => {
    setConfirmDelete(false);
    setConfirmArmed(false);
  };

  const showOverview = () => {
    setSelectedId(null);
    clearDeleteConfirm();
  };

  useEffect(() => {
    // Every path that closes confirmation goes through clearDeleteConfirm(), which
    // already resets confirmArmed, so resetting again here was a redundant cascade.
    if (!confirmDelete) return;
    const timer = window.setTimeout(() => setConfirmArmed(true), 300);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const handleRequestDelete = () => {
    if (!selected) return;
    setConfirmDelete(true);
  };

  const handleConfirmDelete = () => {
    if (!selected || !confirmArmed) return;
    onDelete(selected.id);
    clearDeleteConfirm();
    setSelectedId(null);
  };

  return (
    <div className="apikeys-workspace-shell">
      <div className="apikeys-workspace-root">
        <aside className="apikeys-workspace-rail" aria-label={t("api.title")}>
          <div className="apikeys-workspace-rail-header">
            <span className="apikeys-workspace-rail-title">
              {keysLoading ? t("api.activeKeysLoading") : t("api.activeKeys", { count: keys.length })}
            </span>
          </div>
          <div className="apikeys-workspace-rail-list">
            <button
              type="button"
              className={`apikeys-workspace-rail-row${selectedId === null ? " apikeys-workspace-rail-row--selected" : ""}`}
              onClick={showOverview}
              aria-current={selectedId === null ? "page" : undefined}
            >
              <span className="apikeys-workspace-rail-name">{t("api.workspace.overview")}</span>
            </button>
            {keysLoading ? (
              <span className="apikeys-workspace-rail-empty">{t("common.loading")}</span>
            ) : keys.length === 0 ? (
              <span className="apikeys-workspace-rail-empty">
                {keysLoadFailed ? t("api.keysLoadFailed") : t("api.workspace.noKeysHint")}
              </span>
            ) : (
              keys.map(k => (
                <button
                  key={k.id}
                  type="button"
                  className={`apikeys-workspace-rail-row${selectedId === k.id ? " apikeys-workspace-rail-row--selected" : ""}`}
                  onClick={() => { setSelectedId(k.id); clearDeleteConfirm(); }}
                  aria-current={selectedId === k.id ? "page" : undefined}
                >
                  <span className="apikeys-workspace-rail-name">{k.name}</span>
                  <span className="apikeys-workspace-rail-meta">
                    {k.prefix} · {formatCreatedDate(k.createdAt, localeTag)}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="apikeys-workspace-main" aria-label={t("api.workspace.details")}>
          {selected ? (
            <div className="awi-detail">
              <div className="awi-detail-toolbar">
                <button type="button" className="awi-back" onClick={showOverview}>
                  <IconChevron className="awi-back-chevron" aria-hidden="true" />
                  {t("modal.back")}
                </button>
              </div>
              <div className="awi-detail-body">
                <div className="awi-detail-head">
                  <h2 className="awi-detail-title">{selected.name}</h2>
                  <span className="awi-detail-actions">
                    {confirmDelete ? (
                      <>
                        <button
                          key="confirm-delete"
                          type="button"
                          className="btn btn-danger btn-sm awi-confirm-delete"
                          onClick={handleConfirmDelete}
                          disabled={!confirmArmed}
                        >
                          <IconTrash /> {t("api.confirm")}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={clearDeleteConfirm}>
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        key="request-delete"
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={handleRequestDelete}
                        aria-label={t("api.deleteAria")}
                      >
                        <IconTrash /> {t("api.workspace.deleteKey")}
                      </button>
                    )}
                  </span>
                </div>
                {confirmDelete && (
                  <p className="muted awi-delete-hint">{t("api.workspace.deleteConfirm")}</p>
                )}
                <div className="awi-section">
                  <h3 className="awi-section-title">{t("api.workspace.keyDetails")}</h3>
                  <dl className="awi-kv">
                    <div className="awi-kv-row">
                      <dt>{t("api.colName")}</dt>
                      <dd>{selected.name}</dd>
                    </div>
                    <div className="awi-kv-row">
                      <dt>{t("api.workspace.keyPrefix")}</dt>
                      <dd><code>{selected.prefix}</code></dd>
                    </div>
                    <div className="awi-kv-row">
                      <dt>{t("api.colCreated")}</dt>
                      <dd>{formatCreatedDate(selected.createdAt, localeTag)}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>
          ) : (
            <div className="awi-overview">
              <div className="awi-overview-left">
                <ApiKeysManagePanel
                  keys={keys}
                  keysLoading={keysLoading}
                  keysLoadFailed={keysLoadFailed}
                  newName={newName}
                  creating={creating}
                  newKey={newKey}
                  copied={copied}
                  confirmDelete={null}
                  localeTag={localeTag}
                  showKeyList={false}
                  onNewNameChange={onNewNameChange}
                  onCreate={onCreate}
                  onDismissNewKey={onDismissNewKey}
                  onCopyKey={onCopyKey}
                  onConfirmDelete={() => {}}
                  onCancelDelete={() => {}}
                  onDelete={() => {}}
                />
                <ApiKeysEndpointsPanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
                <ApiKeysUsagePanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
              </div>
              <div className="awi-overview-right">
                <ApiKeysModelsPanel
                  filteredModels={filteredModels}
                  modelsLoading={modelsLoading}
                  modelsLoadFailed={modelsLoadFailed}
                  modelQuery={modelQuery}
                  copiedModelId={copiedModelId}
                  modelTests={modelTests}
                  claudeCodeEnabled={claudeCodeEnabled}
                  onModelQueryChange={onModelQueryChange}
                  onCopyModelId={onCopyModelId}
                  onTestModel={onTestModel}
                  sourceLabel={sourceLabel}
                  protocolLabel={protocolLabel}
                />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
