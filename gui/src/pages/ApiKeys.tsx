import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "../ui";
import { useI18n, LOCALES } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import {
  classifyExternalModel,
  externalModelId,
  type ExternalModelRow,
} from "../api-access-models";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import ApiKeysWorkspace from "../components/apikeys-workspace/ApiKeysWorkspace";
import {
  DEFAULT_ENDPOINTS,
  deriveApiEndpoints,
  type ApiEndpointInfo,
  type ApiKeyEntry,
  type ModelTestState,
} from "./api-keys-utils";

interface KeysResponse {
  keys?: ApiKeyEntry[];
  endpoint?: string;
  baseUrl?: string;
  responsesEndpoint?: string;
  chatCompletionsEndpoint?: string;
  messagesEndpoint?: string;
  modelsEndpoint?: string;
  claudeCodeEnabled?: boolean;
}

interface CreateKeyResponse {
  key?: unknown;
}

type CachedKeysShape = {
  keys: ApiKeyEntry[];
  endpoints: ApiEndpointInfo;
  claudeCodeEnabled: boolean;
};

/** Seed copyable endpoints only when apiBase has a usable origin/host. */
function seedEndpointsFromApiBase(apiBase: string): ApiEndpointInfo {
  const trimmed = apiBase.replace(/\/$/, "");
  if (!trimmed) return DEFAULT_ENDPOINTS;
  try {
    const url = new URL(trimmed);
    if (!url.host) return DEFAULT_ENDPOINTS;
    return deriveApiEndpoints(`${trimmed}/v1/responses`);
  } catch {
    return DEFAULT_ENDPOINTS;
  }
}

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const keysCacheKey = `ocx.apikeys.list.v1:${apiBase}`;
  const modelsCacheKey = `ocx.apikeys.models.v1:${apiBase}`;
  const cachedKeys = readSessionListCache<CachedKeysShape>(keysCacheKey);
  const cachedModels = readSessionListCache<ExternalModelRow[]>(modelsCacheKey);
  const hasModelsCacheRef = useRef(Boolean(cachedModels));
  const [keys, setKeys] = useState<ApiKeyEntry[]>(() => cachedKeys?.keys ?? []);
  const [endpoints, setEndpoints] = useState<ApiEndpointInfo>(() =>
    cachedKeys?.endpoints ?? seedEndpointsFromApiBase(apiBase),
  );
  const [claudeCodeEnabled, setClaudeCodeEnabled] = useState(() => cachedKeys?.claudeCodeEnabled ?? true);
  const [keysLoading, setKeysLoading] = useState(() => !cachedKeys);
  const [keysLoadFailed, setKeysLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [models, setModels] = useState<ExternalModelRow[]>(() => cachedModels ?? []);
  const [modelsLoading, setModelsLoading] = useState(() => !cachedModels);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<Record<string, { state: ModelTestState; detail?: string }>>({});
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const creatingRef = useRef(false);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`);
      const data = await readJsonIfOk<KeysResponse>(res);
      if (!data) {
        // Keep last-good keys/endpoints/Claude setting; only mark the refresh failed.
        setKeysLoadFailed(true);
        return;
      }
      const derived = deriveApiEndpoints(data.endpoint ?? "");
      const nextKeys = data.keys ?? [];
      const nextEndpoints = {
        baseUrl: data.baseUrl ?? derived.baseUrl,
        responses: data.responsesEndpoint ?? data.endpoint ?? DEFAULT_ENDPOINTS.responses,
        chatCompletions: data.chatCompletionsEndpoint ?? derived.chatCompletions,
        messages: data.messagesEndpoint ?? derived.messages,
        models: data.modelsEndpoint ?? derived.models,
      };
      const nextClaude = data.claudeCodeEnabled !== false;
      setKeys(nextKeys);
      setEndpoints(nextEndpoints);
      setClaudeCodeEnabled(nextClaude);
      // Prefixes only — never the secret key material.
      writeSessionListCache(keysCacheKey, {
        keys: nextKeys,
        endpoints: nextEndpoints,
        claudeCodeEnabled: nextClaude,
      });
      setKeysLoadFailed(false);
    } catch {
      setKeysLoadFailed(true);
    } finally {
      setKeysLoading(false);
    }
  }, [apiBase, keysCacheKey]);

  const fetchModels = useCallback(async () => {
    if (!hasModelsCacheRef.current) setModelsLoading(true);
    setModelsLoadFailed(false);
    try {
      const res = await fetch(`${apiBase}/v1/models`);
      if (!res.ok) {
        if (!hasModelsCacheRef.current) setModels([]);
        setModelsLoadFailed(true);
        return;
      }
      const data = await res.json() as unknown;
      const rawRows = Array.isArray(data)
        ? data
        : (typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
          ? (data as { data: unknown[] }).data
          : null);
      if (!rawRows) {
        if (!hasModelsCacheRef.current) setModels([]);
        setModelsLoadFailed(true);
        return;
      }
      const rows = rawRows
        .filter((row): row is { id: string; owned_by?: string } => (
          typeof row === "object"
          && row !== null
          && typeof (row as { id?: unknown }).id === "string"
        ))
        .map(row => classifyExternalModel(row))
        .sort((a, b) => externalModelId(a).localeCompare(externalModelId(b)));
      setModels(rows);
      hasModelsCacheRef.current = true;
      writeSessionListCache(modelsCacheKey, rows);
    } catch {
      if (!hasModelsCacheRef.current) setModels([]);
      setModelsLoadFailed(true);
    } finally {
      setModelsLoading(false);
    }
  }, [apiBase, modelsCacheKey]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      // Independent: keys panel and model catalog must not block each other.
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

  const handleCreate = async (name?: string): Promise<boolean> => {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    try {
      const effectiveName = name ?? newName;
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: effectiveName || "default" }),
      });
      const data = await readJsonOrThrow<CreateKeyResponse>(res, t("api.createFailed"));
      if (typeof data?.key !== "string" || data.key.length === 0) {
        setActionError(t("api.createFailed"));
        return false;
      }
      setNewKey(data.key);
      setNewName("");
      void fetchKeys();
      return true;
    } catch {
      setActionError(t("api.createFailed"));
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setActionError(null);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setActionError(t("api.deleteFailed"));
        return;
      }
      void fetchKeys();
    } catch {
      setActionError(t("api.deleteFailed"));
    }
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedModelId(modelId);
      window.setTimeout(() => setCopiedModelId(current => (current === modelId ? null : current)), 2000);
    } catch {
      /* clipboard unavailable */
    }
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

      {(keysLoadFailed || actionError) && (
        <Notice tone="err">{actionError ?? t("api.keysLoadFailed")}</Notice>
      )}

      <ApiKeysWorkspace
        keys={keys}
        keysLoading={keysLoading}
        keysLoadFailed={keysLoadFailed}
        endpoints={endpoints}
        claudeCodeEnabled={claudeCodeEnabled}
        localeTag={localeTag}
        newName={newName}
        creating={creating}
        newKey={newKey}
        copied={copied}
        filteredModels={filteredModels}
        modelsLoading={modelsLoading}
        modelsLoadFailed={modelsLoadFailed}
        modelQuery={modelQuery}
        copiedModelId={copiedModelId}
        modelTests={modelTests}
        onNewNameChange={setNewName}
        onCreate={() => { void handleCreate(); }}
        onDismissNewKey={() => setNewKey(null)}
        onCopyKey={copyKey}
        onDelete={(id) => { void handleDelete(id); }}
        onModelQueryChange={setModelQuery}
        onCopyModelId={(modelId) => { void copyModelId(modelId); }}
        onTestModel={(model) => { void testModel(model); }}
        sourceLabel={sourceLabel}
        protocolLabel={protocolLabel}
      />
    </section>
  );
}
