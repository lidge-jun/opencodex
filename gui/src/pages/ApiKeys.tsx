import { useCallback, useEffect, useState } from "react";
import { IconPlus, IconX, IconCheck, IconGlobe, IconAlert } from "../icons";
import { useI18n, LOCALES, type TKey } from "../i18n/shared";
import { apiErrorMessage } from "../api-error";
import {
  STOPPED_CLOUDFLARE_TUNNEL,
  canToggleTunnel,
  endpointFromApiPayload,
  isTunnelEnabled,
  isTunnelTransitioning,
  tunnelFromApiPayload,
  tunnelStatusTone,
  type CloudflareTunnelStatus,
} from "../cloudflare-tunnel";

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

const TUNNEL_STATUS_KEYS: Record<CloudflareTunnelStatus, TKey> = {
  stopped: "api.tunnelStatusStopped",
  starting: "api.tunnelStatusStarting",
  running: "api.tunnelStatusRunning",
  stopping: "api.tunnelStatusStopping",
  error: "api.tunnelStatusError",
};

function formatCreatedDate(iso: string, localeTag?: string): string {
  return new Date(iso).toLocaleDateString(localeTag);
}

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [tunnel, setTunnel] = useState(STOPPED_CLOUDFLARE_TUNNEL);
  const [tunnelRequestPending, setTunnelRequestPending] = useState(false);
  const [tunnelRequestError, setTunnelRequestError] = useState<string | null>(null);
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
        setEndpoint(previous => endpointFromApiPayload(data, previous));
        setTunnel(previous => tunnelFromApiPayload(data, previous));
      }
    } catch { /* proxy down */ }
  }, [apiBase]);

  const fetchTunnel = useCallback(async (reportError = false): Promise<boolean> => {
    try {
      const res = await fetch(`${apiBase}/api/cloudflare-tunnel`);
      if (!res.ok) {
        if (reportError) {
          setTunnelRequestError(await apiErrorMessage(res, t("api.tunnelRequestFailed")));
        }
        return false;
      }
      const data = await res.json();
      setTunnel(previous => tunnelFromApiPayload(data, previous));
      setEndpoint(previous => endpointFromApiPayload(data, previous));
      setTunnelRequestError(null);
      return true;
    } catch {
      if (reportError) setTunnelRequestError(t("api.tunnelRequestFailed"));
      return false;
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchKeys();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeys]);

  useEffect(() => {
    const transitioning = isTunnelTransitioning(tunnel.status);
    if (!transitioning && !tunnel.enabled) return;

    let cancelled = false;
    let timeout: number | undefined;
    const poll = async () => {
      await fetchTunnel();
      if (!cancelled) timeout = window.setTimeout(poll, transitioning ? 1000 : 5000);
    };
    timeout = window.setTimeout(poll, transitioning ? 1000 : 5000);

    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [fetchTunnel, tunnel.enabled, tunnel.status]);

  const responseEndpoint = endpoint || "http://127.0.0.1:10100/v1/responses";

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

  const handleTunnelToggle = async () => {
    const enabled = !isTunnelEnabled(tunnel);
    const previousTunnel = tunnel;
    setTunnelRequestError(null);
    setTunnelRequestPending(true);
    setTunnel(current => ({
      ...current,
      status: enabled ? "starting" : "stopping",
      enabled,
      error: undefined,
    }));

    try {
      const res = await fetch(`${apiBase}/api/cloudflare-tunnel`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setTunnel(previousTunnel);
        setTunnelRequestError(await apiErrorMessage(res, t("api.tunnelRequestFailed")));
        return;
      }
      await fetchTunnel(true);
    } catch {
      setTunnel(previousTunnel);
      setTunnelRequestError(t("api.tunnelRequestFailed"));
    } finally {
      setTunnelRequestPending(false);
    }
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Subtitle carries the dedicated admission header as an inline <code> chip.
  const subtitleParts = t("api.subtitle").split("{authHeader}");
  const tunnelEnabled = isTunnelEnabled(tunnel);
  const tunnelBusy = tunnelRequestPending || isTunnelTransitioning(tunnel.status);
  const tunnelError = tunnelRequestError ?? tunnel.error;
  const tunnelButtonLabel = tunnel.status === "starting"
    ? t("api.tunnelStarting")
    : tunnel.status === "stopping"
      ? t("api.tunnelStopping")
      : tunnelEnabled
        ? t("api.tunnelDisable")
        : t("api.tunnelEnable");

  return (
    <section className="api-page">
      <div className="page-head">
        <h2>{t("api.title")}</h2>
      </div>
      <p className="page-sub">
        {subtitleParts[0]}
        <code>X-OpenCodex-API-Key: ocx_...</code>
        {subtitleParts[1]}
      </p>

      <div className="panel api-panel">
        <h3 className="panel-title">{t("api.endpoint")}</h3>
        <code className="api-code api-code-inline">{responseEndpoint}</code>
        <p className="muted small">{t("api.endpointNote")}</p>

        <div className="api-tunnel-control">
          <div className="api-tunnel-copy">
            <div className="api-tunnel-title-row">
              <span className="api-tunnel-title"><IconGlobe /> {t("api.tunnelTitle")}</span>
              <span
                className={`badge badge-${tunnelStatusTone(tunnel.status)}`}
                aria-live="polite"
              >
                {t(TUNNEL_STATUS_KEYS[tunnel.status])}
              </span>
            </div>
            <p className="muted small">
              {t(tunnel.mode === "named" ? "api.tunnelModeNamed" : "api.tunnelModeQuick")}
            </p>
            {!tunnel.canEnable && !tunnelEnabled && (
              <p className="api-tunnel-key-hint small">{t("api.tunnelNeedsKey")}</p>
            )}
          </div>
          <button
            type="button"
            className={`btn ${tunnelEnabled ? "btn-ghost" : "btn-primary"}`}
            onClick={handleTunnelToggle}
            disabled={!canToggleTunnel(tunnel, tunnelRequestPending)}
            aria-busy={tunnelBusy}
          >
            {tunnelBusy ? <span className="spin" aria-hidden="true" /> : <IconGlobe />}
            {tunnelButtonLabel}
          </button>
        </div>
        {tunnelError && (
          <div className="notice notice-err api-tunnel-error" role="alert">
            <IconAlert /> <span>{tunnelError}</span>
          </div>
        )}
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
        <h3 className="panel-title">{t("api.usageTitle")}</h3>
        <pre className="api-code">{`curl ${responseEndpoint} \\
  -H "X-OpenCodex-API-Key: ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Hello, world!"
  }'`}</pre>
      </div>
    </section>
  );
}
