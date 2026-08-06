import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";

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
  const cached = useMemo(() => seedCombos(cacheKey), [cacheKey]);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [adding, setAdding] = useState(false);

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

  const loadCombos = useCallback(async (): Promise<CachedCombosPage> => {
    // Keep all three requests parallel: this workspace is only coherent once every input arrives.
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

    const combos = parseComboList(combosJson);
    const allProviders = configJson.providers ?? {};
    // Collapse canonical forward aliases only in the new-member picker. Validation keeps
    // every configured provider id, including legacy chatgpt members already in a combo.
    const visibleProviders = hideRedundantChatGptForwardProviders(allProviders);
    const providers = Object.entries(allProviders).map(([name, p]) => ({
      name,
      disabled: !!p.disabled,
      hiddenFromPicker: !Object.hasOwn(visibleProviders, name),
      authMode: p.authMode,
      adapter: p.adapter,
      baseUrl: p.baseUrl,
    }));

    const models: ModelOption[] = [];
    const catalogued = new Set<string>();
    for (const row of modelRows) {
      if (!row || typeof row !== "object") continue;
      const model = row as {
        provider?: unknown;
        id?: unknown;
        namespaced?: unknown;
        disabled?: unknown;
        reasoningEfforts?: unknown;
      };
      if (typeof model.provider !== "string" || typeof model.id !== "string") continue;
      const provider = model.provider.trim();
      const id = model.id.trim();
      if (!provider || !id) continue;
      if (provider === "combo") {
        catalogued.add(id);
        continue; // combos cannot nest other combos as targets
      }
      if (model.disabled === true) continue;
      const reasoningEfforts = Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts.filter((effort): effort is string => typeof effort === "string")
        : undefined;
      models.push({
        provider,
        id,
        namespaced: typeof model.namespaced === "string" ? model.namespaced : undefined,
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
      });
    }

    // Ensure each provider's defaultModel appears even if catalog fetch lagged.
    for (const [name, provider] of Object.entries(allProviders)) {
      const defaultModel = typeof provider.defaultModel === "string" ? provider.defaultModel.trim() : "";
      if (!defaultModel || provider.disabled) continue;
      if (!models.some(model => model.provider === name && model.id === defaultModel)) {
        models.push({ provider: name, id: defaultModel, namespaced: `${name}/${defaultModel}` });
      }
    }

    const next = { combos, providers, models, cataloguedComboIds: [...catalogued] } satisfies CachedCombosPage;
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey]);

  const resource = useDataSurface<CachedCombosPage>(
    cacheKey,
    [apiBase],
    loadCombos,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const data = state.data;
  const combos = data?.combos ?? [];
  const providers = data?.providers ?? [];
  const models = data?.models ?? [];
  const cataloguedComboIds = new Set(data?.cataloguedComboIds ?? []);

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
      resource.refresh();
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
      resource.refresh();
      notify(t("cws.removed", { id }), true);
      return { ok: true as const };
    } catch {
      const err = t("cws.removeFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  // The skeleton owns the live region until a session seed or live workspace is available.
  if (state.showSkeleton && !data) {
    return <DataSurfaceSkeleton label={t("cws.loading")} rows={5} />;
  }

  if (state.kind === "failed-cold") {
    const reason = state.error instanceof Error ? state.error.message : t("cws.loadFailed");
    return (
      <>
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>{t("common.retry")}</button>
      </>
    );
  }

  return (
    <div className="combos-workspace-shell">
      {status && (
        <div className="combos-workspace-shell-banner">
          <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
        </div>
      )}
      {state.showError && (
        <div className="combos-workspace-shell-banner">
          <Notice tone="err">{t("cws.loadFailed")}</Notice>
        </div>
      )}
      {/* Revalidation is silent by design: existing combos stay visible, and the
          shell announces the in-flight refresh to assistive tech only. */}
      <div className="combos-workspace-shell-body" aria-busy={state.refreshing}>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {state.refreshing ? t("common.loading") : ""}
        </span>
        <ComboWorkspace
          combos={combos}
          providers={providers}
          models={models}
          cataloguedComboIds={cataloguedComboIds}
          loading={false}
          onRefresh={() => resource.refresh()}
          onSave={saveCombo}
          onRemove={removeCombo}
          onAdd={() => setAdding(true)}
          adding={adding}
          onCloseAdd={() => setAdding(false)}
          onCreated={() => resource.refresh()}
        />
      </div>
    </div>
  );
}
