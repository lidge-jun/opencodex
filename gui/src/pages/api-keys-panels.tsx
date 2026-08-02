import { IconCheck, IconPlus, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import { CopyableExample } from "./api-keys-copy";
export { ApiKeysEndpointsPanel } from "./api-keys-endpoints-panel";
import {
  externalModelId,
  gatewayInboundProtocols,
  type ExternalModelRow,
  type GatewayInboundProtocol,
} from "../api-access-models";
import {
  API_KEY_NAME_MAX_LENGTH,
  formatCreatedDate,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTests,
} from "./api-keys-utils";
import { DataSurfaceSkeleton } from "../components/data-surface";

export function ApiKeysManagePanel({
  keys,
  keysLoading = false,
  keysLoadFailed,
  newName,
  creating,
  newKey,
  copied,
  confirmDelete,
  localeTag,
  showKeyList = true,
  onNewNameChange,
  onCreate,
  onDismissNewKey,
  onCopyKey,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  keys: ApiKeyEntry[];
  keysLoading?: boolean;
  keysLoadFailed: boolean;
  newName: string;
  creating: boolean;
  newKey: string | null;
  copied: boolean;
  confirmDelete: string | null;
  localeTag?: string;
  /** When false, only generate / reveal-new-key UI is shown (workspace rail owns the list). */
  showKeyList?: boolean;
  onNewNameChange: (value: string) => void;
  onCreate: () => void;
  onDismissNewKey: () => void;
  onCopyKey: () => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      {newKey && (
        <div className="panel api-panel panel-accent api-newkey-panel">
          <h3 className="panel-title">{t("api.newKeyTitle")}</h3>
          <p className="muted small">{t("api.newKeyNote")}</p>
          <div className="api-form-row">
            <code className="api-code" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCopyKey}>
              {copied ? <><IconCheck /> {t("api.copied")}</> : t("api.copy")}
            </button>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={onDismissNewKey}>
            {t("api.dismiss")}
          </button>
        </div>
      )}

      <div className="panel api-panel api-generate-panel">
        <h3 className="panel-title">{t("api.generateTitle")}</h3>
        <div className="api-form-row">
          <input
            id="api-key-name"
            type="text"
            placeholder={t("api.keyNamePlaceholder")}
            aria-label={t("api.keyNamePlaceholder")}
            value={newName}
            maxLength={API_KEY_NAME_MAX_LENGTH}
            onChange={e => onNewNameChange(e.target.value)}
            className="input"
          />
          <button type="button" className="btn btn-primary" onClick={onCreate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
          </button>
        </div>
      </div>

      {showKeyList && (
        <div className="panel api-panel" style={{ marginTop: "1rem" }} aria-busy={keysLoading}>
          <h3 className="panel-title">
            {keysLoading ? t("api.activeKeysLoading") : t("api.activeKeys", { count: keys.length })}
          </h3>
          {keysLoading ? (
            <div className="api-active-keys-skeleton" role="status" aria-label={t("common.loading")} />
          ) : keys.length > 0 ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>{t("api.colName")}</th><th>{t("api.colKey")}</th><th>{t("api.colCreated")}</th><th></th></tr>
                </thead>
                <tbody>
                  {keys.map(k => (
                    <tr key={k.id}>
                      <td>{k.name}</td>
                      <td><code>{k.prefix}</code></td>
                      <td>{formatCreatedDate(k.createdAt, localeTag)}</td>
                      <td>
                        {confirmDelete === k.id ? (
                          <span className="api-actions">
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(k.id)}>{t("api.confirm")}</button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={onCancelDelete}>{t("common.cancel")}</button>
                          </span>
                        ) : (
                          <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.deleteAria")} onClick={() => onConfirmDelete(k.id)}><IconX /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : keysLoadFailed ? (
            <p className="muted">{t("api.keysLoadFailed")}</p>
          ) : (
            <p className="muted">{t("api.noKeys")}</p>
          )}
        </div>
      )}
    </>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsRefreshing = false,
  modelsLoadFailed,
  modelCount,
  hasModelData,
  modelQuery,
  copiedModelId,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onCopyModelId,
  onTestModel,
  onRetryModels,
  canTestModels,
  sourceLabel,
  protocolLabel,
}: {
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  /** In-flight refresh that must not blank last-good rows. */
  modelsRefreshing?: boolean;
  modelsLoadFailed: boolean;
  /** The whole catalog, before the search box narrowed it. "No models" and
   *  "no models matching this query" are different sentences. */
  modelCount: number;
  /** True once a catalog has loaded at least once, from network or cache.
   *  Distinguishes a server that really has no models from a failed cold load. */
  hasModelData: boolean;
  modelQuery: string;
  copiedModelId: string | null;
  modelTests: ModelTests;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow, protocol: GatewayInboundProtocol) => void;
  onRetryModels: () => void;
  /** The GUI only ever holds the one-time key from a create, so an authenticated
   *  test is available in that window and honestly disabled outside it. */
  canTestModels: boolean;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: GatewayInboundProtocol) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel api-models-panel">
      <div className="api-panel-head">
        <h3 className="panel-title">{t("api.modelsTitle")}</h3>
        <span className="muted mono text-label">{t("api.modelsCount", { count: filteredModels.length })}</span>
      </div>
      <p className="muted small">{t("api.modelsSubtitle")}</p>
      <input
        type="search"
        className="input"
        value={modelQuery}
        onChange={event => onModelQueryChange(event.target.value)}
        placeholder={t("api.modelsSearch")}
        aria-label={t("api.modelsSearch")}
      />
      {/* The retry sits beside the catalog it repairs, not in a page banner that
          outlives the panel. A failed refresh can coexist with last-good rows,
          so this is rendered alongside the table rather than instead of it. */}
      {modelsLoadFailed && (
        <div className="api-models-error">
          {/* The page-level notice this replaced was announced. Moving the
              message next to its retry must not also make it silent. */}
          <p className="muted small" role="alert">{t("api.modelsLoadFailed")}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetryModels}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {modelsRefreshing && !modelsLoading && (
        <p className="muted small" aria-live="polite">{t("api.modelsLoading")}</p>
      )}
      {modelsLoading ? (
        <DataSurfaceSkeleton label={t("api.modelsLoading")} rows={3} />
      ) : !hasModelData ? (
        // Failed cold: the error above is the whole story. Adding "no models"
        // here would assert an empty catalog we never managed to read.
        null
      ) : filteredModels.length === 0 ? (
        <p className="muted small api-models-empty">
          {modelCount === 0
            ? t("api.modelsEmpty")
            : t("api.modelsNoMatch", { query: modelQuery.trim() })}
        </p>
      ) : (
        <div className="api-models-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("api.colModel")}</th>
                <th>{t("api.colSource")}</th>
                <th>{t("api.colProtocols")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map(model => {
                const modelId = externalModelId(model);
                const protocols = gatewayInboundProtocols(claudeCodeEnabled);
                return (
                  <tr key={modelId}>
                    <td>
                      <div className="api-model-cell">
                        <code>{modelId}</code>
                        {model.displayName !== model.id && <span className="muted small">{model.displayName}</span>}
                      </div>
                    </td>
                    <td>{sourceLabel(model)}</td>
                    <td>
                      {/* The chips are the protocol list: each one names a
                          protocol and tests it. A separate read-only column
                          repeated them and cost the width that pushed these
                          buttons out of the visible table entirely. */}
                      <div className="api-model-actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onCopyModelId(modelId); }}>
                          {copiedModelId === modelId ? t("api.modelCopied") : t("api.copyModelId")}
                        </button>
                        {/* One chip per protocol. A single button posting a chat
                            body proved nothing about the Responses chip beside it. */}
                        {protocols.map(protocol => {
                          const result = modelTests[modelId]?.[protocol];
                          const state = result?.state ?? "idle";
                          return (
                            <span key={protocol} className="api-model-test-chip">
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={state === "testing" || !canTestModels}
                                title={canTestModels ? undefined : t("api.auth.testNeedsFreshKey")}
                                onClick={() => { onTestModel(model, protocol); }}
                              >
                                {t("api.auth.testProtocol", { protocol: protocolLabel(protocol) })}
                              </button>
                              {state !== "idle" && (
                                <span
                                  className={`api-test-note api-test-note--${state}`}
                                  role="status"
                                  aria-live="polite"
                                  aria-atomic="true"
                                >
                                  {state === "testing"
                                    ? t("api.testingModel")
                                    : state === "ok"
                                      ? t("api.testSucceeded")
                                      : result?.detail ?? t("api.testFailed")}
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ApiKeysUsagePanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  const sampleInput = JSON.stringify(t("api.usageSampleInput"));

  const chatExample = `curl ${endpoints.chatCompletions} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`;

  const responsesExample = `curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": ${sampleInput}
  }'`;

  const messagesExample = `curl ${endpoints.messages} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`;

  return (
    // Not a disclosure. These are the answer to "how do I call this?", and a
    // closed <details> answered it only for someone who already suspected the
    // examples were in there.
    <section className="panel api-panel awi-usage-panel">
      <h3 className="panel-title">{t("api.workspace.usageExamples")}</h3>
      <div className="awi-usage-panel-body">
        <div className="awi-usage-example">
          <h4 className="awi-usage-example-title">{t("api.usageChatTitle")}</h4>
          <CopyableExample text={chatExample} />
        </div>

        <div className="awi-usage-example">
          <h4 className="awi-usage-example-title">{t("api.usageResponsesTitle")}</h4>
          <CopyableExample text={responsesExample} />
        </div>

        {claudeCodeEnabled && (
          <div className="awi-usage-example">
            <h4 className="awi-usage-example-title">{t("api.usageMessagesTitle")}</h4>
            <CopyableExample text={messagesExample} />
          </div>
        )}
      </div>
    </section>
  );
}
