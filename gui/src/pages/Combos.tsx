import { useCallback, useEffect, useState } from "react";
import ComboWorkspace from "../components/ComboWorkspace";
import {
  type ComboItem,
  parseComboList,
  toPutBody,
  hideRedundantChatGptForwardProviders,
} from "../combo-workspace-data";
import { Notice } from "../ui";
import { useT } from "../i18n";
import "../styles-combos-workspace.css";

type ProviderOption = {
  name: string;
  disabled?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};
type ModelOption = { provider: string; id: string; namespaced?: string };

export default function Combos({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [combos, setCombos] = useState<ComboItem[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
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

  const fetchAll = useCallback(async () => {
    try {
      const [combosRes, configRes, modelsRes] = await Promise.all([
        fetch(`${apiBase}/api/combos`),
        fetch(`${apiBase}/api/config`),
        fetch(`${apiBase}/api/models`),
      ]);
      const combosJson = await combosRes.json();
      const configJson = await configRes.json() as {
        providers?: Record<string, {
          disabled?: boolean;
          defaultModel?: string;
          authMode?: string;
          adapter?: string;
          baseUrl?: string;
        }>;
      };
      // /api/models returns a bare array (not { models: [...] }).
      const modelsRaw = await modelsRes.json() as unknown;
      const modelRows = Array.isArray(modelsRaw)
        ? modelsRaw
        : Array.isArray((modelsRaw as { models?: unknown })?.models)
          ? (modelsRaw as { models: unknown[] }).models
          : [];

      setCombos(parseComboList(combosJson));

      // Same as Providers workspace: hide duplicate chatgpt when openai forward already exists.
      const visibleProviders = hideRedundantChatGptForwardProviders(configJson.providers ?? {});
      setProviders(
        Object.entries(visibleProviders).map(([name, p]) => ({
          name,
          disabled: !!p.disabled,
          authMode: p.authMode,
          adapter: p.adapter,
          baseUrl: p.baseUrl,
        })),
      );

      const fromApi: ModelOption[] = [];
      for (const row of modelRows) {
        if (!row || typeof row !== "object") continue;
        const m = row as { provider?: unknown; id?: unknown; namespaced?: unknown; disabled?: unknown };
        if (typeof m.provider !== "string" || typeof m.id !== "string") continue;
        if (m.provider === "combo") continue; // combos cannot nest other combos as targets
        if (m.disabled === true) continue;
        fromApi.push({
          provider: m.provider,
          id: m.id,
          namespaced: typeof m.namespaced === "string" ? m.namespaced : undefined,
        });
      }

      // Ensure each provider's defaultModel appears even if catalog fetch lagged.
      for (const [name, p] of Object.entries(configJson.providers ?? {})) {
        const dm = typeof p.defaultModel === "string" ? p.defaultModel.trim() : "";
        if (!dm || p.disabled) continue;
        if (!fromApi.some((m) => m.provider === name && m.id === dm)) {
          fromApi.push({ provider: name, id: dm, namespaced: `${name}/${dm}` });
        }
      }

      setModels(fromApi);
    } catch {
      notify(t("cws.loadFailed"), false);
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAll();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAll]);

  const saveCombo = async (item: ComboItem, isCreate: boolean) => {
    try {
      const res = await fetch(`${apiBase}/api/combos`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toPutBody(item)),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || data.error) {
        const err = data.error || t("cws.saveFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      notify(isCreate ? t("cws.created", { model: item.model }) : t("cws.saved"), true);
      await fetchAll();
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
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || data.error) {
        const err = data.error || t("cws.removeFailed");
        notify(err, false);
        return { ok: false as const, error: err };
      }
      notify(t("cws.removed", { id }), true);
      await fetchAll();
      return { ok: true as const };
    } catch {
      const err = t("cws.removeFailed");
      notify(err, false);
      return { ok: false as const, error: err };
    }
  };

  if (loading && combos.length === 0) {
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
          apiBase={apiBase}
          combos={combos}
          providers={providers}
          models={models}
          loading={loading}
          onRefresh={() => { void fetchAll(); }}
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
