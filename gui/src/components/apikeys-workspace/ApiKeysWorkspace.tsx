/**
 * ApiKeysWorkspace — rail + main for the API tab. Overview hosts the existing
 * endpoint/auth/generate/models/usage panels; selecting a key opens detail.
 */
import { useEffect, useMemo, useState } from "react";
import { IconChevron, IconTrash } from "../../icons";
import { SectionTabs } from "../section-tabs";
import { sectionAnchorId } from "../../section-anchors";
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
import ClientConfigPanel from "./ClientConfigPanel";
import ApiKeysListPanel from "./ApiKeysListPanel";

export interface ApiKeysWorkspaceProps {
  keys: ApiKeyEntry[];
  /** Management API origin the client-config panel fetches from. */
  apiBase: string;
  /** Dataset-level. Absent means nothing is attributable yet — a different
   *  statement from a key whose counters read zero. */
  attributionSince?: string;
  historyTruncated?: boolean;
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
  /** Quiet revalidation / retry over rows already on screen — not a skeleton. */
  modelsRefreshing?: boolean;
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
  apiBase,
  attributionSince,
  historyTruncated,
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
  modelsRefreshing = false,
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

  /** The strip's items. Counts sit in `meta` so the strip reports scale, not just names. */
  const sectionTabs = useMemo(() => [
    { id: "keys", label: t("api.section.keys"), meta: keysLoading ? undefined : String(keys.length) },
    { id: "connect", label: t("api.section.connect") },
    { id: "endpoints", label: t("api.section.endpoints") },
    { id: "models", label: t("api.section.models"), meta: String(modelCount) },
    { id: "examples", label: t("api.section.examples") },
  ], [t, keys.length, keysLoading, modelCount]);

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
      {/* No side rail. Sections stay in the document and a pinned strip scrolls to
          one, the pattern Usage / Logs / Subagents already use. A rail plus a
          content pane was a second vertical band competing for the same width,
          and at 1280px it cost the content column 252px it could not spare. */}
      {!selected && <SectionTabs scope="api" items={sectionTabs} ariaLabel={t("api.workspace.sections")} />}
      <div className="apikeys-workspace-root">
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
                        <dt>{historyTruncated ? t("api.attribution.totalRequestsAvailable") : t("api.attribution.totalRequests")}</dt>
                        <dd>{selected.usage.totalRequests.toLocaleString(localeTag)}</dd>
                      </div>
                      <div className="awi-kv-row">
                        <dt>{t("api.attribution.lastUsed")}</dt>
                        <dd>{selected.usage.lastUsedAt
                          ? formatCreatedDate(selected.usage.lastUsedAt, localeTag)
                          : t("api.attribution.neverUsed")}</dd>
                      </div>
                      <div className="awi-kv-row">
                        <dt>{historyTruncated ? t("api.attribution.sinceAvailable") : t("api.attribution.since")}</dt>
                        <dd>{formatCreatedDate(attributionSince, localeTag)}</dd>
                      </div>
                    </dl>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="awi-overview">
              {/* One column, in reading order: identity (generate a key) →
                  transport (where to point a client) → reference (what the
                  endpoints accept) → inventory (what to call) → examples. Each
                  step is a precondition of the next, and the pinned strip above
                  scrolls to one instead of swapping the page. */}
              <div className="awi-overview-section">
                <div id={sectionAnchorId("api", "keys")} className="awi-section-anchor">
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
                  {/* The rail used to own key navigation. With it gone the list is a
                      table in its own section, which is also where a comparative
                      surface belongs: requests and last-used sort, a rail does not. */}
                  <ApiKeysListPanel
                    keys={keys}
                    keysLoading={keysLoading}
                    keysLoadFailed={keysLoadFailed}
                    attributionSince={attributionSince}
                    localeTag={localeTag}
                    busy={mutationPending}
                    onSelect={id => {
                      setSelectedId(id);
                      clearDeleteConfirm();
                      setRenaming(false);
                      setRenameFailed(false);
                      setDeleteFailed(false);
                    }}
                  />
                </div>
                {/* Transport before reference: "where do I point a client" is the
                    question a reader has before "what headers does it accept". */}
                <div id={sectionAnchorId("api", "connect")} className="awi-section-anchor">
                  <ClientConfigPanel apiBase={apiBase} baseUrl={endpoints.baseUrl} hasKeys={keys.length > 0} />
                </div>
                <div id={sectionAnchorId("api", "endpoints")} className="awi-section-anchor">
                  <ApiKeysEndpointsPanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} authMatrix={authMatrix} />
                </div>
                <div id={sectionAnchorId("api", "models")} className="awi-section-anchor">
                <ApiKeysModelsPanel
                  filteredModels={filteredModels}
                  modelsLoading={modelsLoading}
                  modelsRefreshing={modelsRefreshing}
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
                <div id={sectionAnchorId("api", "examples")} className="awi-section-anchor">
                  <ApiKeysUsagePanel endpoints={endpoints} claudeCodeEnabled={claudeCodeEnabled} />
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
