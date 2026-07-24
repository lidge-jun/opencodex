import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCheck, IconPlus, IconX } from "../icons";
import { useI18n, LOCALES } from "../i18n/shared";

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

interface ApiEndpointInfo {
  baseUrl: string;
  responses: string;
  chatCompletions: string;
  messages: string;
  models: string;
}

interface ExternalModelRow {
  id: string;
  displayName: string;
  provider: string;
  namespaced?: string;
  disabled?: boolean;
  native?: boolean;
  custom?: boolean;
}

type ModelTestState = "idle" | "testing" | "ok" | "error";

const DEFAULT_ENDPOINTS: ApiEndpointInfo = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

function deriveApiEndpoints(endpoint: string): ApiEndpointInfo {
  const responses = endpoint || DEFAULT_ENDPOINTS.responses;
  const match = responses.match(/^(.*)\/v1\/responses\/?$/);
  const baseUrl = match ? `${match[1]}/v1` : responses.replace(/\/responses\/?$/, "");
  return {
    baseUrl,
    responses,
    chatCompletions: `${baseUrl}/chat/completions`,
    messages: `${baseUrl}/messages`,
    models: `${baseUrl}/models`,
  };
}

function externalModelId(model: ExternalModelRow): string {
  return model.namespaced ?? `${model.provider}/${model.id}`;
}

function modelProtocols(model: ExternalModelRow): string[] {
  if (model.provider === "anthropic") return ["messages", "chat"];
  if (model.provider === "openai" || model.native) return ["responses", "chat"];
  return ["chat"];
}

function formatCreatedDate(iso: string, localeTag?: string): string {
  return new Date(iso).toLocaleDateString(localeTag);
}

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [endpoints, setEndpoints] = useState<ApiEndpointInfo>(DEFAULT_ENDPOINTS);
  const [models, setModels] = useState<ExternalModelRow[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<Record<string, { state: ModelTestState; detail?: string }>>({});
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`);
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys ?? []);
        setEndpoints({
          baseUrl: data.baseUrl ?? deriveApiEndpoints(data.endpoint ?? "").baseUrl,
          responses: data.responsesEndpoint ?? data.endpoint ?? DEFAULT_ENDPOINTS.responses,
          chatCompletions: data.chatCompletionsEndpoint ?? deriveApiEndpoints(data.endpoint ?? "").chatCompletions,
          messages: data.messagesEndpoint ?? deriveApiEndpoints(data.endpoint ?? "").messages,
          models: data.modelsEndpoint ?? deriveApiEndpoints(data.endpoint ?? "").models,
        });
      }
    } catch { /* proxy down */ }
  }, [apiBase]);

  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/models`);
      if (!res.ok) return;
      const data = await res.json() as unknown;
      if (!Array.isArray(data)) return;
      const rows = data
        .filter((row): row is ExternalModelRow => typeof row === "object" && row !== null && typeof (row as ExternalModelRow).id === "string")
        .map(row => ({
          id: row.id,
          displayName: row.displayName ?? row.id,
          provider: row.provider,
          namespaced: row.namespaced,
          disabled: row.disabled,
          native: row.native,
          custom: row.custom,
        }))
        .filter(row => !row.disabled)
        .sort((a, b) => externalModelId(a).localeCompare(externalModelId(b)));
      setModels(rows);
    } finally {
      setModelsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchKeys();
      void fetchModels();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeys, fetchModels]);

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return models;
    return models.filter(model => {
      const id = externalModelId(model).toLowerCase();
      return id.includes(query)
        || model.displayName.toLowerCase().includes(query)
        || model.provider.toLowerCase().includes(query);
    });
  }, [modelQuery, models]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName || "default" }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewKey(data.key);
        setNewName("");
        fetchKeys();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`${apiBase}/api/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setConfirmDelete(null);
    fetchKeys();
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyModelId = async (modelId: string) => {
    await navigator.clipboard.writeText(modelId);
    setCopiedModelId(modelId);
    window.setTimeout(() => setCopiedModelId(current => (current === modelId ? null : current)), 2000);
  };

  const sourceLabel = (model: ExternalModelRow): string => {
    if (model.native) return t("api.sourceNative");
    if (model.provider === "combo") return t("api.sourceCombo");
    if (model.custom) return t("api.sourceCustom");
    return model.provider;
  };

  const protocolLabel = (protocol: string): string => {
    if (protocol === "responses") return t("api.protocolResponses");
    if (protocol === "messages") return t("api.protocolMessages");
    return t("api.protocolChatCompletions");
  };

  const testModel = async (model: ExternalModelRow) => {
    const modelId = externalModelId(model);
    setModelTests(current => ({ ...current, [modelId]: { state: "testing" } }));
    try {
      const res = await fetch(endpoints.chatCompletions, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        setModelTests(current => ({
          ...current,
          [modelId]: { state: "error", detail: detail.slice(0, 160) || String(res.status) },
        }));
        return;
      }
      setModelTests(current => ({ ...current, [modelId]: { state: "ok" } }));
    } catch (error) {
      setModelTests(current => ({
        ...current,
        [modelId]: { state: "error", detail: error instanceof Error ? error.message : t("api.testFailed") },
      }));
    }
  };

  // Subtitle carries two inline <code> chips; split the localized string on both tokens.
  const subtitleParts = t("api.subtitle").split(/\{authHeader\}|\{altHeader\}/);

  return (
    <section className="api-page">
      <div className="page-head">
        <h2>{t("api.title")}</h2>
      </div>
      <p className="page-sub">
        {subtitleParts[0]}
        <code>Authorization: Bearer ocx_...</code>
        {subtitleParts[1]}
        <code>x-opencodex-api-key</code>
        {subtitleParts[2]}
      </p>

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
          <div>
            <span className="muted small">{t("api.messagesEndpoint")}</span>
            <code className="api-code api-code-inline">{endpoints.messages}</code>
          </div>
          <div>
            <span className="muted small">{t("api.modelsEndpoint")}</span>
            <code className="api-code api-code-inline">{endpoints.models}</code>
          </div>
        </div>
        <p className="muted small">{t("api.endpointNote")}</p>
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.authTitle")}</h3>
        <ul className="api-auth-list muted small">
          <li>{t("api.authChatCompletions")}</li>
          <li>{t("api.authResponses")}</li>
          <li>{t("api.authMessages")}</li>
          <li>{t("api.authLoopback")}</li>
        </ul>
      </div>

      {newKey && (
        <div className="panel api-panel panel-accent" style={{ marginTop: "1rem" }}>
          <h3 className="panel-title">{t("api.newKeyTitle")}</h3>
          <p className="muted small">{t("api.newKeyNote")}</p>
          <div className="api-form-row">
            <code className="api-code" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <button type="button" className="btn btn-sm btn-ghost" onClick={copyKey}>
              {copied ? <><IconCheck /> {t("api.copied")}</> : t("api.copy")}
            </button>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setNewKey(null)}>
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
            onChange={e => setNewName(e.target.value)}
            className="input"
          />
          <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
          </button>
        </div>
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.activeKeys", { count: keys.length })}</h3>
        {keys.length === 0 ? (
          <p className="muted">{t("api.noKeys")}</p>
        ) : (
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
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => handleDelete(k.id)}>{t("api.confirm")}</button>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-sm btn-ghost" aria-label={t("api.deleteAria")} onClick={() => setConfirmDelete(k.id)}><IconX /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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
          onChange={event => setModelQuery(event.target.value)}
          placeholder={t("api.modelsSearch")}
          aria-label={t("api.modelsSearch")}
        />
        {modelsLoading ? (
          <p className="muted small" style={{ marginTop: "0.75rem" }}>{t("api.modelsLoading")}</p>
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
                      <td>{modelProtocols(model).map(protocolLabel).join(", ")}</td>
                      <td>
                        <div className="api-model-actions">
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { void copyModelId(modelId); }}>
                            {copiedModelId === modelId ? t("api.copied") : t("api.copyModelId")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            disabled={testState === "testing"}
                            onClick={() => { void testModel(model); }}
                          >
                            {testState === "testing" ? t("api.testingModel") : t("api.testModel")}
                          </button>
                        </div>
                            {testState === "ok" && <p className="muted small api-test-note">{t("api.testSucceeded")}</p>}
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

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageChatTitle")}</h3>
        <pre className="api-code">{`curl ${endpoints.chatCompletions} \\
  -H "Authorization: Bearer ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'`}</pre>
      </div>

      <div className="panel api-panel" style={{ marginTop: "1rem" }}>
        <h3 className="panel-title">{t("api.usageResponsesTitle")}</h3>
        <pre className="api-code">{`curl ${endpoints.responses} \\
  -H "x-opencodex-api-key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Hello, world!"
  }'`}</pre>
      </div>
    </section>
  );
}
