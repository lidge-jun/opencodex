import { useCallback, useEffect, useMemo, useState } from "react";
import ComboWorkspace from "../components/ComboWorkspace";
import {
  type ComboItem,
  comboModelId,
  parseComboList,
  toPutBody,
} from "../combo-workspace-data";
import { hideRedundantChatGptForwardProviders } from "../provider-workspace/catalog";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
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
type ModelOption = { provider: string; id: string; namespaced?: string; reasoningEfforts?: string[]; inputModalities?: string[] };
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
  return readSessionListCacheEntry<CachedCombosPage>(cacheKey)?.data ?? null;
}

function seedCombosCachedAt(cacheKey: string): number | null {
  return readSessionListCacheEntry<CachedCombosPage>(cacheKey)?.cachedAt ?? null;
}

export default function Combos({
  apiBase,
  active = true,
  onCountChange,
}: {
  apiBase: string;
  /**
   * False while this panel is mounted but hidden behind another Models tab. It gates
   * the NETWORK only — the rendered tree stays put so unsaved editor drafts survive a
   * tab hop. Defaults true so the standalone page keeps its existing behaviour.
   */
  active?: boolean;
  /** Reports the combo count up to the tab strip. */
  onCountChange?: (count: number) => void;
}) {
  const t = useT();
  const cacheKey = `ocx.combos.workspace.v1:${apiBase}`;
  const cached = useMemo(() => seedCombos(cacheKey), [cacheKey]);

  /*
   * The last coherent payload, kept so a hidden panel can keep rendering.
   *
   * While `active` is false the resource is disabled and reports `data: undefined` with
   * no skeleton and no error. Falling back to empty arrays there swaps the whole
   * ComboWorkspace for a first-run empty state and takes every unsaved draft with it —
   * proven in a browser: type into a combo, switch tabs, come back, field blank.
   *
   * State rather than a ref: this repo avoids render-time ref reads under React
   * Compiler, and a ref would not re-render when the retained payload changes. Written
   * on the load success path, never during render and never from an effect.
   */
  const [retainedData, setRetainedData] = useState<CachedCombosPage | null>(cached ?? null);
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

  const loadCombos = useCallback(async (signal?: AbortSignal): Promise<CachedCombosPage> => {
    // Keep all three requests parallel: this workspace is only coherent once every input arrives.
    const [combosRes, configRes, modelsRes] = await Promise.all([
      // Signals were missing entirely, so resource cleanup could not cancel these.
      fetch(`${apiBase}/api/combos`, { signal }),
      fetch(`${apiBase}/api/config`, { signal }),
      fetch(`${apiBase}/api/models`, { signal }),
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
        inputModalities?: unknown;
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
      const inputModalities = Array.isArray(model.inputModalities)
        ? model.inputModalities
          .filter((modality): modality is string => typeof modality === "string")
          .map((modality) => modality.trim())
          .filter(Boolean)
        : undefined;
      models.push({
        provider,
        id,
        namespaced: typeof model.namespaced === "string" ? model.namespaced : undefined,
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
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
    writeSessionListCacheEntry(cacheKey, next);
    // Retain the coherent payload here — one place, on the success path, never during
    // render. See the `retainedData` note below.
    setRetainedData(next);
    return next;
  }, [apiBase, cacheKey]);

  const resource = useDataSurface<CachedCombosPage>(
    cacheKey,
    [apiBase],
    loadCombos,
    /*
     * Gate the network, never the tree. A hidden panel must not fetch, but the rendered
     * workspace has to stay mounted so an unsaved editor draft survives a tab hop.
     * Disabling reports `data: undefined`, so `retainedData` below keeps the last good
     * payload and the subtree never unmounts.
     */
    {
      isEmpty: () => false,
      initialData: cached ?? undefined,
      initialDataCachedAt: seedCombosCachedAt(cacheKey),
      staleAfterMs: 60_000,
      enabled: active,
    },
  );
  const { state } = resource;

  const data = state.data ?? retainedData ?? undefined;
  const combos = data?.combos ?? [];

  /*
   * Report the count up to the tab strip from an effect keyed on the list length, not
   * during render, so a parent re-render cannot refire it.
   */
  useEffect(() => {
    if (!data) return;
    onCountChange?.(combos.length);
  }, [combos.length, data, onCountChange]);
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

  /*
   * `!data` matters. Disabling the only subscriber schedules store eviction, so a
   * reactivation whose fetch fails is classified `failed-cold` even when this component
   * still holds a coherent retained payload — and replacing the workspace there would
   * unmount the editor and destroy the very draft retention exists to protect. With
   * retained data the workspace stays up and the failure shows in the stale banner below.
   */
  if (state.kind === "failed-cold" && !data) {
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
