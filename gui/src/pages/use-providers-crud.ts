import { useCallback } from "react";
import type { TFn } from "../i18n/shared";
import type { ProviderUpdatePatch, ProviderUpdateResult } from "../components/provider-workspace/types";
import { apiErrorMessage } from "../api-error";

type ProviderError = { code?: unknown; combos?: unknown; error?: unknown };

function providerErrorMessage(data: ProviderError, t: TFn, fallback: string): string {
  switch (data.code) {
    case "last_provider": return t("prov.removeLastProvider");
    case "provider_has_dependent_combos": {
      const combos = Array.isArray(data.combos) ? data.combos.filter((id): id is string => typeof id === "string").join(", ") : "";
      return t("prov.removeHasDependentCombos", { combos: combos || "—" });
    }
    case "default_provider_disabled": return t("prov.defaultDisabled");
    default:
      return typeof data.error === "string" && data.error.trim() ? data.error.trim() : fallback;
  }
}

export function useProvidersCrud({
  apiBase,
  t,
  removeBusyRef,
  workspaceSelected,
  setWorkspaceSelected,
  setRemoveConfirmName,
  notify,
  fetchConfig,
  fetchOauth,
  fetchProviderQuotas,
  refreshCodexAccount,
}: {
  apiBase: string;
  t: TFn;
  removeBusyRef: React.MutableRefObject<boolean>;
  workspaceSelected: string | null;
  setWorkspaceSelected: (name: string | null) => void;
  setRemoveConfirmName: (name: string | null) => void;
  notify: (msg: string, ok: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchOauth: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  /** Shared Codex account controller refresh (Providers.tsx passes codexPool.load). */
  refreshCodexAccount?: () => Promise<unknown> | unknown;
}) {
  const removeProvider = useCallback(async (name: string) => {
    setRemoveConfirmName(name);
  }, [setRemoveConfirmName]);

  const confirmRemoveProvider = useCallback(async (removeConfirmName: string | null) => {
    const name = removeConfirmName;
    if (!name || removeBusyRef.current) return;
    removeBusyRef.current = true;
    setRemoveConfirmName(null);
    const fallback = t("prov.removeFail", { name });
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as { defaultProvider?: unknown };
        const defaultProvider = typeof data.defaultProvider === "string" ? data.defaultProvider : null;
        notify(defaultProvider
          ? t("prov.removedDefault", { name, defaultProvider })
          : t("prov.removed", { name }), true);
        if (workspaceSelected === name) setWorkspaceSelected(null);
        fetchConfig();
        fetchOauth();
        fetchProviderQuotas(true);
      } else {
        const data = await res.json().catch(() => ({})) as ProviderError;
        notify(providerErrorMessage(data, t, fallback), false);
      }
    } catch {
      notify(fallback, false);
    } finally {
      removeBusyRef.current = false;
    }
  }, [apiBase, fetchConfig, fetchOauth, fetchProviderQuotas, notify, removeBusyRef, setRemoveConfirmName, setWorkspaceSelected, t, workspaceSelected]);

  const setProviderDisabled = useCallback(async (name: string, disabled: boolean) => {
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (!res.ok) {
      notify(await apiErrorMessage(res, disabled ? t("prov.disableFail", { name }) : t("prov.enableFail", { name })), false);
      return;
    }
    notify(disabled ? t("prov.disabled", { name }) : t("prov.enabled", { name }), true);
    fetchConfig();
    fetchOauth();
    fetchProviderQuotas(true);
  }, [apiBase, fetchConfig, fetchOauth, fetchProviderQuotas, notify, t]);

  const updateProvider = useCallback(async (name: string, patch: ProviderUpdatePatch): Promise<ProviderUpdateResult> => {
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        return { ok: false, error: await apiErrorMessage(res, t("prov.updateFail")) };
      }
      const data = await res.json().catch(() => ({})) as { xaiResponsesOptInState?: unknown };
      // Await refresh so callers (e.g. notes editor) only leave edit mode once
      // item.note reflects the saved value.
      await fetchConfig();
      // A codexAccountMode PATCH clears quota caches and thread affinity server-side,
      // so both dependent surfaces must refresh before the action reports success.
      if (Object.hasOwn(patch, "codexAccountMode")) {
        const refreshes: Promise<unknown>[] = [fetchProviderQuotas(true)];
        if (refreshCodexAccount) refreshes.push(Promise.resolve(refreshCodexAccount()));
        await Promise.all(refreshes);
      }
      const state = data.xaiResponsesOptInState;
      return {
        ok: true,
        ...(state === true || state === false || state === "mixed"
          ? { xaiResponsesOptInState: state }
          : {}),
      };
    } catch {
      return { ok: false, error: t("prov.networkError") };
    }
  }, [apiBase, fetchConfig, fetchProviderQuotas, refreshCodexAccount, t]);

  const setDefaultProvider = useCallback(async (name: string): Promise<boolean> => {
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setDefault: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as ProviderError;
        notify(providerErrorMessage(data, t, t("prov.setDefaultFail", { name })), false);
        return false;
      }
      notify(t("prov.setDefaultSuccess", { name }), true);
      await fetchConfig();
      return true;
    } catch {
      notify(t("prov.setDefaultFail", { name }), false);
      return false;
    }
  }, [apiBase, fetchConfig, notify, t]);

  return { removeProvider, confirmRemoveProvider, setProviderDisabled, setDefaultProvider, updateProvider };
}
