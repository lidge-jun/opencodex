import { useCallback, useRef } from "react";
import type { TFn } from "../i18n/shared";
import type { ProviderUpdatePatch, ProviderUpdateResult } from "../components/provider-workspace/types";
import { apiErrorMessage, errorMessageFrom } from "../api-error";
import { isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../api";
import { useRenderTargetCapture } from "../use-render-target-capture";

type ProviderError = { code?: unknown; combos?: unknown; error?: unknown };
type ShadowDependency = { model: string; enabled: boolean };

/** The shadow-call target a disable or delete left without its provider, when interception is on. */
function activeShadowDependency(data: { dependentShadowIntercept?: unknown }): ShadowDependency | null {
  const dependency = data.dependentShadowIntercept as Partial<ShadowDependency> | undefined;
  if (!dependency || typeof dependency.model !== "string" || dependency.enabled !== true) return null;
  return { model: dependency.model, enabled: true };
}

function providerErrorMessage(data: ProviderError, t: TFn, fallback: string): string {
  switch (data.code) {
    case "last_provider": return t("prov.removeLastProvider");
    case "provider_has_dependent_combos": {
      const combos = Array.isArray(data.combos) ? data.combos.filter((id): id is string => typeof id === "string").join(", ") : "";
      return t("prov.removeHasDependentCombos", { combos: combos || "—" });
    }
    case "default_provider_disabled": return t("prov.defaultDisabled");
    default:
      return errorMessageFrom(data, fallback, t("prov.targetChanged"));
  }
}

export function useProvidersCrud({
  apiBase,
  targetKey,
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
  onProviderRemoved,
}: {
  apiBase: string;
  /** Logical dashboard target; a relay apiBase is shared across a re-pair. */
  targetKey?: string;
  t: TFn;
  removeBusyRef: React.MutableRefObject<boolean>;
  workspaceSelected: string | null;
  setWorkspaceSelected: (name: string | null) => void;
  setRemoveConfirmName: (name: string | null) => void;
  /** A "warn" notice with ok=false stays until dismissed, like an error, in the warning tone. */
  notify: (msg: string, ok: boolean, tone?: "warn") => void;
  fetchConfig: () => Promise<void>;
  fetchOauth: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  /** Shared Codex account controller refresh (Providers.tsx passes codexPool.load). */
  refreshCodexAccount?: () => Promise<unknown> | unknown;
  /** Confirmed removal only: drop this target's parked draft for the provider. */
  onProviderRemoved?: (name: string) => void;
}) {
  // This page's render owns the target for its own actions. A module-level target change
  // that has not re-rendered the page cannot retarget a stale closure.
  const renderCapture = useRenderTargetCapture(apiBase, targetKey);
  // The confirmation belongs to the target that opened it, not to the target live when
  // the user finally confirms.
  const pendingRemoveRef = useRef<{ name: string; capture: ApiTargetCapture } | null>(null);
  const removeProvider = useCallback(async (name: string) => {
    pendingRemoveRef.current = { name, capture: renderCapture };
    setRemoveConfirmName(name);
  }, [renderCapture, setRemoveConfirmName]);

  const confirmRemoveProvider = useCallback(async (removeConfirmName: string | null) => {
    const name = removeConfirmName;
    if (!name || removeBusyRef.current) return;
    const pending = pendingRemoveRef.current;
    const capture = pending?.name === name ? pending.capture : renderCapture;
    // The dashboard moved while the confirmation was open: refuse rather than delete the
    // same-named provider on the new target.
    if (!isApiTargetCaptureCurrent(capture)) {
      setRemoveConfirmName(null);
      notify(t("prov.targetChanged"), false);
      return;
    }
    removeBusyRef.current = true;
    setRemoveConfirmName(null);
    const fallback = t("prov.removeFail", { name });
    try {
      const res = await targetFetch(capture, `${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) {
        pendingRemoveRef.current = null;
        const data = await res.json().catch(() => ({})) as { defaultProvider?: unknown; dependentShadowIntercept?: unknown };
        const defaultProvider = typeof data.defaultProvider === "string" ? data.defaultProvider : null;
        const shadow = activeShadowDependency(data);
        onProviderRemoved?.(name);
        if (!isApiTargetCaptureCurrent(capture)) return;
        if (shadow) notify(t("prov.removedShadowTarget", { name, model: shadow.model }), false, "warn");
        else notify(defaultProvider
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
  }, [apiBase, fetchConfig, fetchOauth, fetchProviderQuotas, notify, onProviderRemoved, removeBusyRef, renderCapture, setRemoveConfirmName, setWorkspaceSelected, t, workspaceSelected]);

  const setProviderDisabled = useCallback(async (name: string, disabled: boolean) => {
    const capture = renderCapture;
    const res = await targetFetch(capture, `${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (!res.ok) {
      notify(await apiErrorMessage(
        res,
        disabled ? t("prov.disableFail", { name }) : t("prov.enableFail", { name }),
        t("prov.targetChanged"),
      ), false);
      return;
    }
    const data = await res.json().catch(() => ({})) as { dependentShadowIntercept?: unknown };
    if (!isApiTargetCaptureCurrent(capture)) return;
    const shadow = activeShadowDependency(data);
    if (shadow) notify(t("prov.disabledShadowTarget", { name, model: shadow.model }), false, "warn");
    else notify(disabled ? t("prov.disabled", { name }) : t("prov.enabled", { name }), true);
    fetchConfig();
    fetchOauth();
    fetchProviderQuotas(true);
  }, [apiBase, fetchConfig, fetchOauth, fetchProviderQuotas, notify, renderCapture, t]);

  const updateProvider = useCallback(async (
    name: string,
    patch: ProviderUpdatePatch,
    captureOverride?: ApiTargetCapture,
  ): Promise<ProviderUpdateResult> => {
    // A caller that owns the form passes its render capture. Never replace it with a live
    // capture: that is exactly how a stale form used to write to the new hub.
    const capture = captureOverride ?? renderCapture;
    try {
      const res = await targetFetch(capture, `${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        return { ok: false, error: await apiErrorMessage(res, t("prov.updateFail"), t("prov.targetChanged")) };
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
  }, [apiBase, fetchConfig, fetchProviderQuotas, refreshCodexAccount, renderCapture, t]);

  const setDefaultProvider = useCallback(async (name: string): Promise<boolean> => {
    const capture = renderCapture;
    try {
      const res = await targetFetch(capture, `${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setDefault: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as ProviderError;
        notify(providerErrorMessage(data, t, t("prov.setDefaultFail", { name })), false);
        return false;
      }
      if (!isApiTargetCaptureCurrent(capture)) return false;
      notify(t("prov.setDefaultSuccess", { name }), true);
      await fetchConfig();
      return true;
    } catch {
      notify(t("prov.setDefaultFail", { name }), false);
      return false;
    }
  }, [apiBase, fetchConfig, notify, renderCapture, t]);

  return { removeProvider, confirmRemoveProvider, setProviderDisabled, setDefaultProvider, updateProvider };
}
