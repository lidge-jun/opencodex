import { IconCheck, IconPlus, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import {
  externalModelId,
  gatewayInboundProtocols,
  type ExternalModelRow,
} from "../api-access-models";
import {
  formatCreatedDate,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTestState,
} from "./api-keys-utils";

export function ApiKeysEndpointsPanel({
  endpoints,
  claudeCodeEnabled,
}: {
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel">
      <h3 className="panel-title">{t("api.endpointsTitle")}</h3>
      <div className="api-endpoints">
        <div>
          <span className="muted small">{t("api.baseUrl")}</span>
          <code className="api-code api-code-inline">{endpoints.baseUrl}</code>
        </div>
        <div>
          <span className="muted small">{t("api.responsesEndpoint")}</span>
          <code className="api-code api-code-inline">{endpoints.responses}</code>
        </div>
        <div>
          <span className="muted small">{t("api.chatCompletionsEndpoint")}</span>
          <code className="api-code api-code-inline">{endpoints.chatCompletions}</code>
        </div>
        {claudeCodeEnabled && (
          <div>
            <span className="muted small">{t("api.messagesEndpoint")}</span>
            <code className="api-code api-code-inline">{endpoints.messages}</code>
          </div>
        )}
        <div>
          <span className="muted small">{t("api.modelsEndpoint")}</span>
          <code className="api-code api-code-inline">{endpoints.models}</code>
        </div>
      </div>
      <p className="muted small">{t("api.endpointNote")}</p>
    </div>
  );
}

export function ApiKeysAuthPanel({ claudeCodeEnabled }: { claudeCodeEnabled: boolean }) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel" style={{ marginTop: "1rem" }}>
      <h3 className="panel-title">{t("api.authTitle")}</h3>
      <ul className="api-auth-list muted small">
        <li>{t("api.authChatCompletions")}</li>
        <li>{t("api.authResponses")}</li>
        {claudeCodeEnabled && <li>{t("api.authMessages")}</li>}
        <li>{t("api.authLoopback")}</li>
      </ul>
      <p className="muted small">{t("api.authBaseUrlNote")}</p>
    </div>
  );
}

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
        <div className="panel api-panel panel-accent" style={{ marginTop: "1rem" }}>
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

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.generateTitle")}</h3>
        <div className="api-form-row">
          <input
            id="api-key-name"
            type="text"
            placeholder={t("api.keyNamePlaceholder")}
            aria-label={t("api.keyNamePlaceholder")}
            value={newName}
            onChange={e => onNewNameChange(e.target.value)}
            className="input"
          />
          <button type="button" className="btn btn-primary" onClick={onCreate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
          </button>
        </div>
      </div>

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
    </>
  );
}

export function ApiKeysModelsPanel({
  filteredModels,
  modelsLoading,
  modelsLoadFailed,
  modelQuery,
  copiedModelId,
  modelTests,
  claudeCodeEnabled,
  onModelQueryChange,
  onCopyModelId,
  onTestModel,
  sourceLabel,
  protocolLabel,
}: {
  filteredModels: ExternalModelRow[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  modelQuery: string;
  copiedModelId: string | null;
  modelTests: Record<string, { state: ModelTestState; detail?: string }>;
  claudeCodeEnabled: boolean;
  onModelQueryChange: (value: string) => void;
  onCopyModelId: (modelId: string) => void;
  onTestModel: (model: ExternalModelRow) => void;
  sourceLabel: (model: ExternalModelRow) => string;
  protocolLabel: (protocol: string) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="panel api-panel" style={{ marginTop: "1rem" }}>
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
      {modelsLoading ? (
        <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsLoading")}</p>
      ) : modelsLoadFailed ? (
        <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsLoadFailed")}</p>
      ) : filteredModels.length === 0 ? (
        <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsEmpty")}</p>
      ) : (
        <div className="tbl-wrap" style={{ marginTop: "0.75rem" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("api.colModel")}</th>
                <th>{t("api.colSource")}</th>
                <th>{t("api.colProtocols")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.map(model => {
                const modelId = externalModelId(model);
                const testState = modelTests[modelId]?.state ?? "idle";
                return (
                  <tr key={modelId}>
                    <td>
                      <div className="api-model-cell">
                        <code>{modelId}</code>
                        {model.displayName !== model.id && <span className="muted small">{model.displayName}</span>}
                      </div>
                    </td>
                    <td>{sourceLabel(model)}</td>
                    <td>{gatewayInboundProtocols(claudeCodeEnabled).map(protocolLabel).join(", ")}</td>
                    <td>
                      <div className="api-model-actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onCopyModelId(modelId); }}>
                          {copiedModelId === modelId ? t("api.modelCopied") : t("api.copyModelId")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={testState === "testing"}
                          onClick={() => { onTestModel(model); }}
                        >
                          {testState === "testing" ? t("api.testingModel") : t("api.testModel")}
                        </button>
                      </div>
                      {testState === "ok" && <p className="muted small api-test-note api-test-note--ok">{t("api.testSucceeded")}</p>}
                      {testState === "error" && <p className="muted small api-test-note api-test-note--error">{modelTests[modelId]?.detail ?? t("api.testFailed")}</p>}
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

  return (
    <>
      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageChatTitle")}</h3>
        <pre className="api-code">{`curl ${endpoints.chatCompletions} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageResponsesTitle")}</h3>
        <pre className="api-code">{`curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": ${sampleInput}
  }'`}</pre>
      </div>

      {claudeCodeEnabled && (
        <div className="panel api-panel" style={{ marginTop: "1rem" }}>
          <h3 className="panel-title">{t("api.usageMessagesTitle")}</h3>
          <pre className="api-code">{`curl ${endpoints.messages} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": ${sampleInput}}]
  }'`}</pre>
        </div>
      )}
    </>
  );
}
