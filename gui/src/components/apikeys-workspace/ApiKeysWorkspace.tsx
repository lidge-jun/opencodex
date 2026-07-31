/**
 * ApiKeysWorkspace — rail + main for the API tab. Overview hosts the existing
 * endpoint/auth/generate/models/usage panels; selecting a key opens detail.
 */
import { useEffect, useState } from "react";
import { IconChevron, IconTrash } from "../../icons";
import { useT } from "../../i18n/shared";
import type { ExternalModelRow, GatewayInboundProtocol } from "../../api-access-models";
import {
  API_KEY_NAME_MAX_LENGTH,
  formatCreatedDate,
  type ApiAuthMatrixRow,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTests,
} from "../../pages/api-keys-utils";
import {
  ApiKeysEndpointsPanel,
  ApiKeysManagePanel,
  ApiKeysModelsPanel,
  ApiKeysUsagePanel,
} from "../../pages/api-keys-panels";

export interface ApiKeysWorkspaceProps {
  keys: ApiKeyEntry[];
  /** Dataset-level. Absent means nothing is attributable yet — a different
   *  statement from a key whose counters read zero. */
  attributionSince?: string;
  authMatrix: ApiAuthMatrixRow[];
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
  modelCount: number;
  hasModelData: boolean;
  modelQuery: string;
  copiedModelId: string | null;
  modelTests: ModelTests;
  canTestModels: boolean;
  onNewNameChange: (value: string) => void;
  onCreate: () => void;
  onDismissNewKey: () => void;
  onCopyKey: () => void;
  onDelete: (id: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onModelQueryChange: (value: string) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow, protocol: GatewayInboundProtocol) => void;
  onRetryModels: () => void;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: GatewayInboundProtocol) => string;
}

export default function ApiKeysWorkspace({
  keys,
  attributionSince,
  authMatrix,
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
  modelCount,
  hasModelData,
  modelQuery,
  copiedModelId,
  modelTests,
  canTestModels,
  onNewNameChange,
  onCreate,
  onDismissNewKey,
  onCopyKey,
  onDelete,
  onRename,
  onModelQueryChange,
  onCopyModelId,
  onTestModel,
  onRetryModels,
  sourceLabel,
  protocolLabel,
}: ApiKeysWorkspaceProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Armed after a short delay so a double-click / retained focus cannot confirm immediately. */
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  /** Scoped to the open editor: a page-level banner outlives the key it is about
   *  and can end up attached to whichever key the user selects next. */
  const [renameFailed, setRenameFailed] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const selected = selectedId ? (keys.find(k => k.id === selectedId) ?? null) : null;
  const mutationPending = deleting || renamePending;

  const clearDeleteConfirm = () => {
    setConfirmDelete(false);
    setConfirmArmed(false);
  };

  const showOverview = () => {
    setSelectedId(null);
    clearDeleteConfirm();
    setRenaming(false);
    setRenameFailed(false);
    setDeleteFailed(false);
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

  const handleConfirmDelete = async () => {
    if (!selected || !confirmArmed || deleting) return;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      // Navigate only on a real deletion. Clearing the selection first meant a
      // failure surfaced as a page-level banner detached from the key it was
      // about, with the pane already gone.
      if (await onDelete(selected.id)) {
        clearDeleteConfirm();
        setSelectedId(null);
      } else {
        setDeleteFailed(true);
      }
    } finally {
      setDeleting(false);
    }
  };

  const startRename = () => {
    if (!selected) return;
    setRenameDraft(selected.name);
    setRenameFailed(false);
    setRenaming(true);
  };

  const submitRename = async () => {
    if (!selected || renamePending) return;
    const next = renameDraft.trim();
    if (!next || next === selected.name) {
      setRenaming(false);
      return;
    }
    setRenamePending(true);
    setRenameFailed(false);
    try {
      // Pessimistic: a failure keeps the form and the draft, because retyping a
      // name the user already typed is the rudest possible recovery.
      if (await onRename(selected.id, next)) setRenaming(false);
      else setRenameFailed(true);
    } finally {
      setRenamePending(false);
    }
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
              disabled={mutationPending}
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
                  // Navigation is blocked while a mutation is in flight: its
                  // result is bound to the key it was issued for, and letting the
                  // selection move would land the outcome on a bystander.
                  disabled={mutationPending}
                  onClick={() => {
                    setSelectedId(k.id);
                    clearDeleteConfirm();
                    setRenaming(false);
                    setRenameFailed(false);
                    setDeleteFailed(false);
                  }}
                  aria-current={selectedId === k.id ? "page" : undefined}
                >
                  <span className="apikeys-workspace-rail-name">{k.name}</span>
                  <span className="apikeys-workspace-rail-meta">
                    {/* Prefix moved to detail: it reads the same on every row, so
                        the rail carries what actually differs between keys. */}
                    {!attributionSince
                      ? t("api.attribution.unavailable")
                      : k.usage.ambiguous
                        ? t("api.attribution.railAmbiguous")
                        : `${t("api.attribution.railRequests", { count: k.usage.requests7d })} · ${
                          k.usage.lastUsedAt
                            ? t("api.attribution.railLastUsed", { date: formatCreatedDate(k.usage.lastUsedAt, localeTag) })
                            : t("api.attribution.railNeverUsed")
                        }`}
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
                <button type="button" className="awi-back" onClick={showOverview} disabled={mutationPending}>
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
                          onClick={() => { void handleConfirmDelete(); }}
                          disabled={!confirmArmed || deleting}
                        >
                          <IconTrash /> {deleting ? t("api.key.deleting") : t("api.confirm")}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={clearDeleteConfirm} disabled={deleting}>
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          key="rename"
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={startRename}
                          disabled={renaming}
                        >
                          {t("api.key.rename")}
                        </button>
                        <button
                          key="request-delete"
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={handleRequestDelete}
                          aria-label={t("api.deleteAria")}
                        >
                          <IconTrash /> {t("api.workspace.deleteKey")}
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {confirmDelete && (
                  <p className="muted awi-delete-hint">{t("api.workspace.deleteConfirm")}</p>
                )}
                {deleteFailed && (
                  <p className="awi-delete-error" role="alert">{t("api.deleteFailed")}</p>
                )}
                {renaming && (
                  <div className="awi-rename">
                    <label className="awi-rename-label" htmlFor="awi-key-name">{t("api.key.name")}</label>
                    <input
                      id="awi-key-name"
                      className="input"
                      type="text"
                      value={renameDraft}
                      maxLength={API_KEY_NAME_MAX_LENGTH}
                      disabled={renamePending}
                      onChange={event => setRenameDraft(event.target.value)}
                      onKeyDown={event => {
                        // Enter still saves, without relying on implicit form
                        // submission (which browsers and test DOMs disagree on).
                        if (event.key === "Enter") { event.preventDefault(); void submitRename(); }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => { void submitRename(); }}
                      disabled={renamePending}
                    >
                      {renamePending ? t("api.key.renaming") : t("api.key.saveName")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setRenaming(false)}
                      disabled={renamePending}
                    >
                      {t("common.cancel")}
                    </button>
                    {renameFailed && (
                      <p className="awi-rename-error" role="alert">{t("api.key.renameFailed")}</p>
                    )}
                  </div>
                )}
                <div className="awi-section">
                  <h3 className="awi-section-title">{t("api.workspace.keyDetails")}</h3>
                  <dl className="awi-kv">
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
                <div className="awi-section">
                  <h3 className="awi-section-title">{t("api.attribution.title")}</h3>
                  {/* Branch on the DATASET field, not on `usage`: a key with zero
                      requests under a live dataset really was used zero times,
                      which is not the same as having nothing to attribute. */}
                  {!attributionSince ? (
                    <p className="muted">{t("api.attribution.unavailableDetail")}</p>
                  ) : selected.usage.ambiguous ? (
                    <p className="muted">{t("api.attribution.ambiguous")}</p>
                  ) : (
                    <dl className="awi-kv">
                      <div className="awi-kv-row">
                        <dt>{t("api.attribution.requests7d")}</dt>
                        <dd>{selected.usage.requests7d.toLocaleString(localeTag)}</dd>
                      </div>
                      <div className="awi-kv-row">
                        <dt>{t("api.attribution.totalRequests")}</dt>
                        <dd>{selected.usage.totalRequests.toLocaleString(localeTag)}</dd>
                      </div>
                      <div className="awi-kv-row">
                        <dt>{t("api.attribution.lastUsed")}</dt>
                        <dd>{selected.usage.lastUsedAt
                          ? formatCreatedDate(selected.usage.lastUsedAt, localeTag)
                          : t("api.attribution.neverUsed")}</dd>
                      </div>
                      <div className="awi-kv-row">
                        <dt>{t("api.attribution.since")}</dt>
                        <dd>{formatCreatedDate(attributionSince, localeTag)}</dd>
                      </div>
                    </dl>
                  )}
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
                <ApiKeysEndpointsPanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} authMatrix={authMatrix} />
                <ApiKeysUsagePanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
              </div>
              <div className="awi-overview-right">
                <ApiKeysModelsPanel
                  filteredModels={filteredModels}
                  modelsLoading={modelsLoading}
                  modelsLoadFailed={modelsLoadFailed}
                  modelCount={modelCount}
                  hasModelData={hasModelData}
                  modelQuery={modelQuery}
                  copiedModelId={copiedModelId}
                  modelTests={modelTests}
                  claudeCodeEnabled={claudeCodeEnabled}
                  onModelQueryChange={onModelQueryChange}
                  onCopyModelId={onCopyModelId}
                  onTestModel={onTestModel}
                  onRetryModels={onRetryModels}
                  canTestModels={canTestModels}
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
