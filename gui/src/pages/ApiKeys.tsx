import { useCallback, useMemo, useRef, useState } from "react";
import { Notice } from "../ui";
import { useI18n, LOCALES } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import {
  classifyExternalModel,
  externalModelId,
  type ExternalModelRow,
  type GatewayInboundProtocol,
} from "../api-access-models";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
import { createBoundedFetch } from "../bounded-fetch";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import ApiKeysWorkspace from "../components/apikeys-workspace/ApiKeysWorkspace";
import {
  DEFAULT_ENDPOINTS,
  deriveApiEndpoints,
  isApiAuthMatrix,
  isApiKeyUsage,
  type ApiEndpointInfo,
  type ApiAuthMatrixRow,
  type ApiKeyEntry,
  type ModelTestResult,
  type ModelTests,
} from "./api-keys-utils";

interface KeysResponse {
  // `usage` is optional on the wire only so a malformed payload lands in
  // fetchKeys' validator rather than at the type boundary. A row without it is
  // rejected, not defaulted: zeroes would assert "never used" about data we
  // could not read.
  keys?: Array<Omit<ApiKeyEntry, "usage"> & { usage?: ApiKeyEntry["usage"] }>;
  attributionSince?: string;
  historyTruncated?: boolean;
  authMatrix?: unknown;
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
  /** Dataset-level: absent means nothing is attributable yet, which is a
   *  different statement from a key whose counters are zero. */
  attributionSince?: string;
  historyTruncated?: boolean;
  authMatrix: ApiAuthMatrixRow[];
};

const EMPTY_MODELS: ExternalModelRow[] = [];

/** Delete and rename hold the detail pane's navigation lock while in flight,
 *  so they cannot be allowed to hang forever. Generous enough that a slow but
 *  live proxy still lands, short enough that a dead socket gives the UI back. */
const MUTATION_TIMEOUT_MS = 15_000;

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

/** Session-cache entries get the same scrutiny as a network payload. */
function validCachedKeys(cached: CachedKeysShape | null): CachedKeysShape | null {
  if (!cached || !isApiAuthMatrix(cached.authMatrix)) return null;
  if (!Array.isArray(cached.keys) || cached.keys.some(key => !key || !isApiKeyUsage(key.usage))) return null;
  return cached;
}

/**
 * `active` gates both resources. As one panel of the Integrations tab strip
 * this stays mounted while hidden — which is what preserves in-progress key
 * drafts — so without the gate a hidden panel would keep polling the catalog
 * behind whatever tab the user is actually looking at.
 */
export default function ApiKeys({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  // v2: a v1 session entry has no auth matrix, and defaulting that to [] would
  // turn stale client state into an apparently authoritative empty auth table.
  const keysCacheKey = `ocx.apikeys.list.v2:${apiBase}`;
  const modelsCacheKey = `ocx.apikeys.models.v1:${apiBase}`;
  const keysResourceKey = `api-keys:${apiBase}`;
  const modelsResourceKey = `api-models:${apiBase}`;
  // A cache entry is arbitrary parsed JSON. Trusting it would reintroduce exactly
  // what the network path refuses: an empty matrix rendering as an authoritative
  // "no rules" table, or a row without `usage` throwing on first render.
  const cachedKeysEntry = readSessionListCacheEntry<CachedKeysShape>(keysCacheKey);
  const cachedModelsEntry = readSessionListCacheEntry<ExternalModelRow[]>(modelsCacheKey);
  const cachedKeys = validCachedKeys(cachedKeysEntry?.data ?? null);
  const cachedModels = cachedModelsEntry?.data ?? null;
  const [actionError, setActionError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [copiedModelId, setCopiedModelId] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<ModelTests>({});
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const creatingRef = useRef(false);

  const fetchKeys = useCallback(async (signal: AbortSignal): Promise<CachedKeysShape> => {
    const res = await fetch(`${apiBase}/api/keys`, { signal });
    const data = await readJsonIfOk<KeysResponse>(res);
    // The auth matrix is server truth; without it the page would have to describe
    // the rules from memory, which is the defect this replaces.
    if (!data || !isApiAuthMatrix(data.authMatrix)) throw new Error(t("api.keysLoadFailed"));
    const rows = data.keys ?? [];
    if (rows.some(key => !isApiKeyUsage(key.usage))) throw new Error(t("api.keysLoadFailed"));
    const validatedKeys = rows as ApiKeyEntry[];
    const derived = deriveApiEndpoints(data.endpoint ?? "");
    const next: CachedKeysShape = {
      // Validate rather than coerce. A missing or malformed `usage` used to
      // become zeroes, which says "used zero times" about data we could not
      // read — and every reader downstream would believe it.
      keys: validatedKeys,
      endpoints: {
        baseUrl: data.baseUrl ?? derived.baseUrl,
        responses: data.responsesEndpoint ?? data.endpoint ?? DEFAULT_ENDPOINTS.responses,
        chatCompletions: data.chatCompletionsEndpoint ?? derived.chatCompletions,
        messages: data.messagesEndpoint ?? derived.messages,
        models: data.modelsEndpoint ?? derived.models,
      },
      claudeCodeEnabled: data.claudeCodeEnabled !== false,
      ...(data.attributionSince ? { attributionSince: data.attributionSince } : {}),
      ...(data.historyTruncated === true ? { historyTruncated: true } : {}),
      authMatrix: data.authMatrix,
    };
    // Prefixes only — never the secret key material.
    writeSessionListCacheEntry(keysCacheKey, next);
    return next;
  }, [apiBase, keysCacheKey, t]);

  const fetchModels = useCallback(async (signal: AbortSignal): Promise<ExternalModelRow[]> => {
    const res = await fetch(`${apiBase}/v1/models`, { signal });
    if (!res.ok) throw new Error(t("api.modelsLoadFailed"));
    const data = await res.json() as unknown;
    const rawRows = Array.isArray(data)
      ? data
      : (typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : null);
    if (!rawRows) throw new Error(t("api.modelsLoadFailed"));
    const rows = rawRows
      .filter((row): row is { id: string; owned_by?: string } => (
        typeof row === "object"
        && row !== null
        && typeof (row as { id?: unknown }).id === "string"
      ))
      .map(row => classifyExternalModel(row))
      .sort((a, b) => externalModelId(a).localeCompare(externalModelId(b)));
    writeSessionListCacheEntry(modelsCacheKey, rows);
    return rows;
  }, [apiBase, modelsCacheKey, t]);

  // Keys and models intentionally remain independent resources: a slow catalog must never
  // block endpoint/key management, and each cache key retains its own session seed.
  const keysResource = useDataSurface<CachedKeysShape>(
    keysResourceKey,
    [apiBase],
    fetchKeys,
    {
      isEmpty: data => data.keys.length === 0,
      initialData: cachedKeys ?? undefined,
      initialDataCachedAt: cachedKeysEntry?.cachedAt ?? null,
      staleAfterMs: 60_000,
      enabled: active,
    },
  );
  const modelsResource = useDataSurface<ExternalModelRow[]>(
    modelsResourceKey,
    [apiBase],
    fetchModels,
    {
      isEmpty: models => models.length === 0,
      initialData: cachedModels ?? undefined,
      initialDataCachedAt: cachedModelsEntry?.cachedAt ?? null,
      staleAfterMs: 60_000,
      enabled: active,
    },
  );
  const keysState = keysResource.state;
  const modelsState = modelsResource.state;
  const keysData = keysState.data ?? cachedKeys;
  const models = modelsState.data ?? cachedModels ?? EMPTY_MODELS;
  const keys = keysData?.keys ?? [];
  const endpoints = keysData?.endpoints ?? seedEndpointsFromApiBase(apiBase);
  const claudeCodeEnabled = keysData?.claudeCodeEnabled ?? true;
  const attributionSince = keysData?.attributionSince;
  const historyTruncated = keysData?.historyTruncated === true;
  // `?? []` only ever fires while there is no key data at all — both the network
  // and cache paths reject a payload without a valid matrix, so an empty table
  // can never be presented as the server's answer.
  const authMatrix = keysData?.authMatrix ?? [];
  const refreshKeys = keysResource.refresh;
  const refreshModels = modelsResource.refresh;

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
      refreshKeys();
      return true;
    } catch {
      setActionError(t("api.createFailed"));
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  /** Resolves true only when the key is really gone, so the pane can stay put
   *  until then instead of navigating away from a failure. Bounded: this call
   *  holds the detail pane's navigation lock, so a connection that never
   *  answers would otherwise strand the rail, Back, and Overview for good. */
  const handleDelete = async (id: string): Promise<boolean> => {
    setActionError(null);
    const bounded = createBoundedFetch(MUTATION_TIMEOUT_MS);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
        signal: bounded.signal,
      });
      if (!res.ok) return false;
      refreshKeys();
      return true;
    } catch {
      // Includes the timeout abort: the key may or may not be gone, so the
      // pane stays open on the row it was about and the next refresh decides.
      return false;
    } finally {
      bounded.clear();
    }
  };

  /** Pessimistic: the name changes on screen only after the server accepts it,
   *  and a failure keeps the draft rather than discarding what was typed.
   *  Bounded for the same reason as delete — it holds the same lock. */
  const handleRename = async (id: string, name: string): Promise<boolean> => {
    setActionError(null);
    const bounded = createBoundedFetch(MUTATION_TIMEOUT_MS);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name }),
        signal: bounded.signal,
      });
      // The detail pane renders this failure next to the draft it concerns; a
      // page-level banner would say it twice and outlive the key.
      if (!res.ok) return false;
      refreshKeys();
      return true;
    } catch {
      return false;
    } finally {
      bounded.clear();
    }
  };

  const copyKey = async () => {
    if (!newKey) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The one-time key is the only string in the product with no second
      // chance, so a silent failure here is the worst kind. Keep it on screen.
      setCopied(false);
      setActionError(t("api.key.copyFailed"));
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
    return formatProviderDisplayName(model.provider, t);
  };

  const protocolLabel = (protocol: GatewayInboundProtocol): string => {
    if (protocol === "responses") return t("api.protocolResponses");
    if (protocol === "messages") return t("api.protocolMessages");
    return t("api.protocolChatCompletions");
  };

  /** Each protocol speaks its own wire; a chat body sent to Responses proves
   *  nothing about Responses. */
  const modelTestRequest = (protocol: GatewayInboundProtocol, modelId: string): { url: string; body: unknown } => {
    if (protocol === "responses") {
      return { url: endpoints.responses, body: { model: modelId, input: "ping", max_output_tokens: 1, stream: false } };
    }
    if (protocol === "messages") {
      return { url: endpoints.messages, body: { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] } };
    }
    return { url: endpoints.chatCompletions, body: { model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false } };
  };

  const setModelTest = (modelId: string, protocol: GatewayInboundProtocol, result: ModelTestResult) =>
    setModelTests(current => ({ ...current, [modelId]: { ...current[modelId], [protocol]: result } }));

  const testModel = async (model: ExternalModelRow, protocol: GatewayInboundProtocol) => {
    // Without a key the request would ride the loopback bypass and pass whether
    // or not the key works — which is the one thing this button should prove.
    if (!newKey) return;
    const modelId = externalModelId(model);
    const request = modelTestRequest(protocol, modelId);
    setModelTest(modelId, protocol, { state: "testing" });
    try {
      const res = await fetch(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The one header every data-plane endpoint accepts, so a pass here
          // means something on a remote bind too.
          "x-opencodex-api-key": newKey,
        },
        body: JSON.stringify(request.body),
      });
      if (!res.ok) {
        const detail = await res.text();
        setModelTest(modelId, protocol, { state: "error", detail: detail.slice(0, 160) || String(res.status) });
        return;
      }
      setModelTest(modelId, protocol, { state: "ok" });
    } catch (error) {
      setModelTest(modelId, protocol, {
        state: "error",
        detail: error instanceof Error ? error.message : t("api.testFailed"),
      });
    }
  };

  // Subtitle names ONE header. It used to advertise `Authorization: Bearer` too,
  // which /v1/responses and /v1/chat/completions reject — the per-endpoint rule
  // lives in the auth matrix now, where it can be right.
  const subtitleParts = t("api.subtitle").split("{authHeader}");

  return (
    <section
      className="api-page"
      aria-busy={keysState.refreshing || modelsState.refreshing || undefined}
    >
      <div className="page-head">
        <h2>{t("api.title")}</h2>
      </div>
      <p className="page-sub">
        {subtitleParts[0]}
        <code>x-opencodex-api-key</code>
        {subtitleParts[1]}
      </p>

      {actionError && <Notice tone="err">{actionError}</Notice>}
      {keysState.showError && keysData && <Notice tone="err">{t("api.keysLoadFailed")}</Notice>}
      {/* The model failure is reported inside the models panel, beside the
          retry that repairs it. A page banner said it a second time and stayed
          up while the panel below it showed perfectly good cached rows. */}

      {keysState.showSkeleton && !keysData ? (
        <DataSurfaceSkeleton label={t("api.activeKeysLoading")} rows={4} />
      ) : keysState.kind === "failed-cold" && !keysData ? (
        <>
          <Notice tone="err">{keysState.error instanceof Error ? keysState.error.message : t("api.keysLoadFailed")}</Notice>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => refreshKeys()}>{t("common.retry")}</button>
        </>
      ) : (
        <>
          <ApiKeysWorkspace
        keys={keys}
        apiBase={apiBase}
        attributionSince={attributionSince}
        historyTruncated={historyTruncated}
        authMatrix={authMatrix}
        keysLoading={false}
        keysLoadFailed={keysState.showError}
        endpoints={endpoints}
        claudeCodeEnabled={claudeCodeEnabled}
        localeTag={localeTag}
        newName={newName}
        creating={creating}
        newKey={newKey}
        copied={copied}
        filteredModels={filteredModels}
        modelsLoading={modelsState.showSkeleton && !modelsState.data && !cachedModels}
        // Only announce progress on a retry after failure — quiet warm revisits stay silent.
        modelsRefreshing={modelsState.refreshing && modelsState.showError && (modelsState.data !== undefined || cachedModels !== null)}
        modelsLoadFailed={modelsState.showError}
        modelCount={models.length}
        // `readSessionListCache` answers `null`, not `undefined`, when it has
        // nothing — comparing against `undefined` made a failed cold load look
        // like a successfully-read empty catalog.
        hasModelData={modelsState.data !== undefined || cachedModels !== null}
        modelQuery={modelQuery}
        copiedModelId={copiedModelId}
        modelTests={modelTests}
        onNewNameChange={setNewName}
        onCreate={() => { void handleCreate(); }}
        onDismissNewKey={() => setNewKey(null)}
        onCopyKey={() => { void copyKey(); }}
        onDelete={handleDelete}
        onRename={handleRename}
        onModelQueryChange={setModelQuery}
        onCopyModelId={(modelId) => { void copyModelId(modelId); }}
        onTestModel={(model, protocol) => { void testModel(model, protocol); }}
        onRetryModels={() => { refreshModels({ forceLoading: true }); }}
        canTestModels={newKey !== null}
        sourceLabel={sourceLabel}
        protocolLabel={protocolLabel}
          />
        </>
      )}
    </section>
  );
}
