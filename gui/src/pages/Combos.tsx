import { useCallback, useEffect, useRef, useState } from "react";
import ComboWorkspace from "../components/ComboWorkspace";
import {
  type ComboItem,
  comboModelId,
  parseComboList,
  toPutBody,
} from "../combo-workspace-data";
import { hideRedundantChatGptForwardProviders } from "../provider-workspace/catalog";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";

type ProviderOption = {
  name: string;
  disabled?: boolean;
  hiddenFromPicker?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};
type ModelOption = { provider: string; id: string; namespaced?: string; reasoningEfforts?: string[] };
type ProviderDto = {
  adapter: string;
  baseUrl: string;
  disabled?: boolean;
  defaultModel?: string;
  authMode?: string;
};
type ConfigDto = { providers?: Record<string, ProviderDto> };
type CachedCombosPage = {
  combos: ComboItem[];
  providers: ProviderOption[];
  models: ModelOption[];
  cataloguedComboIds: string[];
};

function responseError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : undefined;
}

function responseSucceeded(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as { success?: unknown }).success === true;
}

function seedCombos(cacheKey: string): CachedCombosPage | null {
  return readSessionListCache<CachedCombosPage>(cacheKey);
}

export default function Combos({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.combos.workspace.v1:${apiBase}`;
  const [combos, setCombos] = useState<ComboItem[]>(() => seedCombos(cacheKey)?.combos ?? []);
  const [providers, setProviders] = useState<ProviderOption[]>(() => seedCombos(cacheKey)?.providers ?? []);
  const [models, setModels] = useState<ModelOption[]>(() => seedCombos(cacheKey)?.models ?? []);
  const [cataloguedComboIds, setCataloguedComboIds] = useState<ReadonlySet<string>>(
    () => new Set(seedCombos(cacheKey)?.cataloguedComboIds ?? []),
  );
  const [loading, setLoading] = useState(() => !seedCombos(cacheKey));
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [adding, setAdding] = useState(false);
  const hasCacheRef = useRef(Boolean(seedCombos(cacheKey)));

  const notify = (msg: string, ok: boolean) => {
    setStatus(msg);
    setStatusOk(ok);
  };

  // Success banners are transient; errors stay until the next notify.
  useEffect(() => {
    if (!status || !statusOk) return;
    const timer = window.setTimeout(() => {
      setStatus("");
      setStatusOk(false);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [status, statusOk]);

  const fetchAll = useCallback(async (opts?: { notifyOnFail?: boolean }) => {
    // Soft refresh: keep last-good workspace painted while revalidating.
    if (!hasCacheRef.current) setLoading(true);
    try {
      const [combosRes, configRes, modelsRes] = await Promise.all([
        fetch(`${apiBase}/api/combos`),
        fetch(`${apiBase}/api/config`),
        fetch(`${apiBase}/api/models`),
      ]);
      if (!combosRes.ok || !configRes.ok || !modelsRes.ok) {
        throw new Error("combo workspace load failed");
      }
      const combosJson = await combosRes.json();
      const configJson = await configRes.json() as ConfigDto;
      // /api/models returns a bare array (not { models: [...] }).
      const modelsRaw = await modelsRes.json() as unknown;
      const modelRows = Array.isArray(modelsRaw)
        ? modelsRaw
        : Array.isArray((modelsRaw as { models?: unknown })?.models)
          ? (modelsRaw as { models: unknown[] }).models
          : [];

      const nextCombos = parseComboList(combosJson);
      setCombos(nextCombos);

      const allProviders = configJson.providers ?? {};
      // Collapse canonical forward aliases only in the new-member picker. Validation keeps
      // every configured provider id, including legacy chatgpt members already in a combo.
      const visibleProviders = hideRedundantChatGptForwardProviders(allProviders);
      const nextProviders = Object.entries(allProviders).map(([name, p]) => ({
        name,
        disabled: !!p.disabled,
        hiddenFromPicker: !Object.hasOwn(visibleProviders, name),
        authMode: p.authMode,
        adapter: p.adapter,
        baseUrl: p.baseUrl,
      }));
      setProviders(nextProviders);

      const fromApi: ModelOption[] = [];
      const catalogued = new Set<string>();
      for (const row of modelRows) {
        if (!row || typeof row !== "object") continue;
        const m = row as {
          provider?: unknown;
          id?: unknown;
          namespaced?: unknown;
          disabled?: unknown;
          reasoningEfforts?: unknown;
        };
        if (typeof m.provider !== "string" || typeof m.id !== "string") continue;
        const provider = m.provider.trim();
        const id = m.id.trim();
        if (!provider || !id) continue;
        if (provider === "combo") {
          catalogued.add(id);
          continue; // combos cannot nest other combos as targets
        }
        if (m.disabled === true) continue;
        const reasoningEfforts = Array.isArray(m.reasoningEfforts)
          ? m.reasoningEfforts.filter((effort): effort is string => typeof effort === "string")
          : undefined;
        fromApi.push({
          provider,
          id,
          namespaced: typeof m.namespaced === "string" ? m.namespaced : undefined,
          ...(reasoningEfforts ? { reasoningEfforts } : {}),
        });
      }
      setCataloguedComboIds(catalogued);

      // Ensure each provider's defaultModel appears even if catalog fetch lagged.
      for (const [name, p] of Object.entries(configJson.providers ?? {})) {
        const dm = typeof p.defaultModel === "string" ? p.defaultModel.trim() : "";
        if (!dm || p.disabled) continue;
        if (!fromApi.some((m) => m.provider === name && m.id === dm)) {
          fromApi.push({ provider: name, id: dm, namespaced: `${name}/${dm}` });
        }
      }

      setModels(fromApi);
      hasCacheRef.current = true;
      writeSessionListCache(cacheKey, {
        combos: nextCombos,
        providers: nextProviders,
        models: fromApi,
        cataloguedComboIds: [...catalogued],
      } satisfies CachedCombosPage);
    } catch {
      if (!hasCacheRef.current || opts?.notifyOnFail) notify(t("cws.loadFailed"), false);
    } finally {
      setLoading(false);
    }
  }, [apiBase, cacheKey, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAll]);

  const saveCombo = async (item: ComboItem, isCreate: boolean, renameFrom?: string) => {
    try {
      const res = await fetch(`${apiBase}/api/combos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPutBody(item, renameFrom ? { renameFrom } : {})),
      });
      const data = res.ok
        ? await res.json() as unknown
        : await res.json().catch(() => null) as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.saveFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      await fetchAll();
      notify(
        renameFrom
          ? t("cws.renamed", { from: comboModelId(renameFrom), to: item.model })
          : isCreate ? t("cws.created", { model: item.model }) : t("cws.saved"),
        true,
      );
      return { ok: true as const };
    } catch {
      const err = t("cws.saveFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  const removeCombo = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/api/combos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = res.ok
        ? await res.json() as unknown
        : await res.json().catch(() => null) as unknown;
      const serverError = responseError(data);
      if (!res.ok || serverError || !responseSucceeded(data)) {
        const err = serverError || t("cws.removeFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      await fetchAll();
      notify(t("cws.removed", { id }), true);
      return { ok: true as const };
    } catch {
      const err = t("cws.removeFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  // Cold start only — cached empty lists paint the workspace immediately. `loading`
  // already encodes that: it initializes to !seedCombos(cacheKey) and a refresh only
  // sets it when the cache is empty, so reading the ref during render was redundant.
  if (loading) {
    return (
      <div className="combos-workspace-shell">
        {status && (
          <div className="combos-workspace-shell-banner">
            <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
          </div>
        )}
        <div className="muted" style={{ padding: "24px 20px" }} role="status">
          {status ? null : t("cws.loading")}
        </div>
      </div>
    );
  }

  return (
    <div className="combos-workspace-shell">
      {status && (
        <div className="combos-workspace-shell-banner">
          <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
        </div>
      )}
      <div className="combos-workspace-shell-body">
        <ComboWorkspace
          combos={combos}
          providers={providers}
          models={models}
          cataloguedComboIds={cataloguedComboIds}
          loading={loading}
          onRefresh={() => { void fetchAll({ notifyOnFail: true }); }}
          onSave={saveCombo}
          onRemove={removeCombo}
          onAdd={() => setAdding(true)}
          adding={adding}
          onCloseAdd={() => setAdding(false)}
          onCreated={() => { void fetchAll(); }}
        />
      </div>
    </div>
  );
}
