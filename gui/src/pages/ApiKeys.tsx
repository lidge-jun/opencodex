import { useCallback, useEffect, useState, type FormEvent } from "react";
import { IconPlus, IconX, IconCheck, IconGlobe, IconAlert, IconExternal } from "../icons";
import { useI18n, LOCALES, type TKey } from "../i18n/shared";
import { apiErrorMessage } from "../api-error";
import {
  STOPPED_CLOUDFLARE_TUNNEL,
  buildCloudflareTunnelSetupRequest,
  buildCloudflareTunnelToggleRequest,
  canReconfigureTunnel,
  canToggleTunnel,
  endpointFromApiPayload,
  isTunnelEnabled,
  isTunnelTransitioning,
  shouldOpenTunnelSetup,
  tunnelFromApiPayload,
  tunnelStatusTone,
  type CloudflareTunnelStatus,
  type CloudflareTunnelSetupMethod,
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
  const [tunnelSetupOpen, setTunnelSetupOpen] = useState(false);
  const [tunnelSetupMethod, setTunnelSetupMethod] = useState<CloudflareTunnelSetupMethod>("api");
  const [tunnelAccountId, setTunnelAccountId] = useState("");
  const [tunnelZoneId, setTunnelZoneId] = useState("");
  const [tunnelHostname, setTunnelHostname] = useState("");
  const [tunnelApiToken, setTunnelApiToken] = useState("");
  const [tunnelName, setTunnelName] = useState("");
  const [tunnelReplaceExisting, setTunnelReplaceExisting] = useState(false);
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelToken, setTunnelToken] = useState("");
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

  const openTunnelSetup = () => {
    setTunnelRequestError(null);
    setTunnelSetupMethod(tunnel.configured || tunnel.configurationSource === "local" ? "token" : "api");
    setTunnelReplaceExisting(false);
    setTunnelPublicUrl(tunnel.configuredPublicUrl ?? "");
    setTunnelSetupOpen(true);
  };

  const handleTunnelToggle = async (mode?: "quick" | "named") => {
    if (!mode && shouldOpenTunnelSetup(tunnel)) {
      openTunnelSetup();
      return;
    }

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
      const requestTunnelToggle = (body: unknown) => fetch(`${apiBase}/api/cloudflare-tunnel`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let res = await requestTunnelToggle(buildCloudflareTunnelToggleRequest(enabled, mode));
      if (!res.ok && enabled && mode) {
        try {
          const payload = await res.clone().json();
          if (payload?.error === "unknown field: mode") {
            // Older local management servers do not yet accept the explicit mode field. Retry
            // with the legacy body so existing Quick Tunnel configs keep working while the
            // backend rolls forward.
            res = await requestTunnelToggle(buildCloudflareTunnelToggleRequest(enabled));
          }
        } catch {
          // Non-JSON errors fall through to the normal localized error path below.
        }
      }
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

  const handleTunnelSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tunnel.canConfigure) return;
    setTunnelRequestError(null);
    setTunnelRequestPending(true);

    const body = tunnelSetupMethod === "api"
      ? buildCloudflareTunnelSetupRequest("api", {
          accountId: tunnelAccountId,
          zoneId: tunnelZoneId,
          hostname: tunnelHostname,
          apiToken: tunnelApiToken,
          tunnelName,
          replaceExisting: tunnelReplaceExisting,
        })
      : buildCloudflareTunnelSetupRequest("token", {
          publicUrl: tunnelPublicUrl,
          tunnelToken,
        });

    try {
      const res = await fetch(`${apiBase}/api/cloudflare-tunnel/setup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Provisioning can succeed even when the final local cloudflared start fails. In that
        // case the API returns the saved configuration alongside the start error: adopt it and
        // clear both secret inputs so the user can install/fix cloudflared, then retry Enable.
        try {
          const failurePayload = await res.clone().json();
          const configuredTunnel = tunnelFromApiPayload(failurePayload, tunnel);
          if (configuredTunnel.configured) {
            setTunnel(configuredTunnel);
            setEndpoint(previous => endpointFromApiPayload(failurePayload, previous));
            setTunnelApiToken("");
            setTunnelToken("");
            setTunnelSetupOpen(false);
            await fetchTunnel(true);
          }
        } catch {
          // apiErrorMessage below supplies the localized fallback for non-JSON failures.
        }
        setTunnelRequestError(await apiErrorMessage(res, t("api.tunnelSetupFailed")));
        return;
      }

      const data = await res.json();
      setTunnel(previous => tunnelFromApiPayload(data, previous));
      setEndpoint(previous => endpointFromApiPayload(data, previous));
      setTunnelApiToken("");
      setTunnelToken("");
      setTunnelReplaceExisting(false);
      setTunnelSetupOpen(false);
      await fetchTunnel(true);
    } catch {
      setTunnelRequestError(t("api.tunnelSetupFailed"));
    } finally {
      // Secret fields are single-request inputs: clear them after success, validation errors,
      // Cloudflare failures, and local network errors alike.
      setTunnelApiToken("");
      setTunnelToken("");
      setTunnelRequestPending(false);
    }
  };

  const closeTunnelSetup = () => {
    setTunnelApiToken("");
    setTunnelToken("");
    setTunnelReplaceExisting(false);
    setTunnelSetupOpen(false);
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
  const tunnelNeedsSetup = shouldOpenTunnelSetup(tunnel);
  const tunnelCanProceed = tunnelNeedsSetup ? tunnel.canConfigure : tunnel.canEnable;
  const tunnelCanUseQuick = !tunnelEnabled && (tunnel.canEnable || tunnel.canConfigure) && tunnel.configurationSource !== "environment";
  const tunnelBusy = tunnelRequestPending || isTunnelTransitioning(tunnel.status);
  const tunnelError = tunnelRequestError ?? tunnel.error;
  const tunnelButtonLabel = tunnel.status === "starting"
    ? t("api.tunnelStarting")
    : tunnel.status === "stopping"
      ? t("api.tunnelStopping")
      : tunnelEnabled
        ? t("api.tunnelDisable")
        : tunnelNeedsSetup
          ? t("api.tunnelConfigure")
          : t("api.tunnelEnable");
  const tunnelReplaceConfirmationRequired = tunnel.configurationSource === "local";
  const tunnelSetupReady = tunnelSetupMethod === "api"
    ? Boolean(
        tunnelAccountId.trim()
        && tunnelZoneId.trim()
        && tunnelHostname.trim()
        && tunnelApiToken.trim()
        && (!tunnelReplaceConfirmationRequired || tunnelReplaceExisting)
      )
    : Boolean(tunnelPublicUrl.trim() && tunnelToken.trim());

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
            {tunnel.configuredPublicUrl && (
              <p className="api-tunnel-detail small">
                <span className="muted">{t("api.tunnelPublicUrl")}</span>
                <code>{tunnel.configuredPublicUrl}</code>
              </p>
            )}
            {tunnel.originUrl && (
              <p className="api-tunnel-detail small">
                <span className="muted">{t("api.tunnelOriginUrl")}</span>
                <code>{tunnel.originUrl}</code>
              </p>
            )}
            {!tunnelCanProceed && !tunnelEnabled && (
              <p className="api-tunnel-key-hint small">
                {t(tunnel.configurationSource === "environment" && tunnel.setupRequired
                  ? "api.tunnelEnvironmentManaged"
                  : "api.tunnelNeedsKey")}
              </p>
            )}
          </div>
          <div className="api-tunnel-buttons">
            {tunnel.configured && !tunnelEnabled && tunnel.configurationSource !== "environment" && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={openTunnelSetup}
                disabled={!canReconfigureTunnel(tunnel, tunnelRequestPending)}
              >
                {t("api.tunnelReconfigure")}
              </button>
            )}
            <button
              type="button"
              className={`btn ${tunnelEnabled ? "btn-ghost" : "btn-primary"}`}
              onClick={() => handleTunnelToggle()}
              disabled={!canToggleTunnel(tunnel, tunnelRequestPending)}
              aria-busy={tunnelBusy}
            >
              {tunnelBusy ? <span className="spin" aria-hidden="true" /> : <IconGlobe />}
              {tunnelButtonLabel}
            </button>
            {tunnelCanUseQuick && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => handleTunnelToggle("quick")}
                disabled={tunnelBusy || tunnelRequestPending}
                aria-busy={tunnelBusy}
              >
                {tunnelBusy ? <span className="spin" aria-hidden="true" /> : <IconGlobe />}
                {t("api.tunnelUseQuick")}
              </button>
            )}
          </div>
        </div>
        {tunnelCanUseQuick && (
          <p className="muted small api-tunnel-quick-note">{t("api.tunnelQuickNote")}</p>
        )}
        {tunnelError && (
          <div className="notice notice-err api-tunnel-error" role="alert">
            <IconAlert /> <span>{tunnelError}</span>
          </div>
        )}
        {tunnelSetupOpen && !tunnelEnabled && (
          <div className="api-tunnel-setup">
            <div className="api-tunnel-setup-head">
              <div>
                <h4>{t("api.tunnelSetupTitle")}</h4>
                <p className="muted small">{t("api.tunnelSetupIntro")}</p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={closeTunnelSetup}
                disabled={tunnelRequestPending}
              >
                {t("common.cancel")}
              </button>
            </div>

            <div className="notice api-tunnel-sse-note">
              <IconCheck /> <span>{t("api.tunnelSseNote")}</span>
            </div>

            <div className="api-tunnel-methods" role="radiogroup" aria-label={t("api.tunnelSetupMethod")}>
              <button
                type="button"
                role="radio"
                aria-checked={tunnelSetupMethod === "api"}
                className={`api-tunnel-method${tunnelSetupMethod === "api" ? " api-tunnel-method-active" : ""}`}
                onClick={() => setTunnelSetupMethod("api")}
              >
                <strong>{t("api.tunnelSetupAutomatic")}</strong>
                <span>{t("api.tunnelSetupAutomaticDesc")}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={tunnelSetupMethod === "token"}
                className={`api-tunnel-method${tunnelSetupMethod === "token" ? " api-tunnel-method-active" : ""}`}
                onClick={() => setTunnelSetupMethod("token")}
              >
                <strong>{t("api.tunnelSetupExisting")}</strong>
                <span>{t("api.tunnelSetupExistingDesc")}</span>
              </button>
            </div>

            <form className="api-tunnel-setup-form" onSubmit={handleTunnelSetup}>
              {tunnelSetupMethod === "api" ? (
                <>
                  <div className="api-tunnel-form-grid">
                    <label>
                      <span className="field-label">{t("api.tunnelAccountId")}</span>
                      <input className="input" required value={tunnelAccountId} onChange={event => setTunnelAccountId(event.target.value)} placeholder={t("api.tunnelAccountIdPlaceholder")} />
                    </label>
                    <label>
                      <span className="field-label">{t("api.tunnelZoneId")}</span>
                      <input className="input" required value={tunnelZoneId} onChange={event => setTunnelZoneId(event.target.value)} placeholder={t("api.tunnelZoneIdPlaceholder")} />
                    </label>
                    <label>
                      <span className="field-label">{t("api.tunnelHostname")}</span>
                      <input className="input" required value={tunnelHostname} onChange={event => setTunnelHostname(event.target.value)} placeholder={t("api.tunnelHostnamePlaceholder")} />
                    </label>
                    <label>
                      <span className="field-label">{t("api.tunnelName")}</span>
                      <input className="input" value={tunnelName} onChange={event => setTunnelName(event.target.value)} placeholder={t("api.tunnelNamePlaceholder")} />
                    </label>
                  </div>
                  <label>
                    <span className="field-label">{t("api.tunnelApiToken")}</span>
                    <input className="input" type="password" autoComplete="off" required value={tunnelApiToken} onChange={event => setTunnelApiToken(event.target.value)} placeholder={t("api.tunnelApiTokenPlaceholder")} />
                  </label>
                  <p className="muted small">{t("api.tunnelApiPermissions")}</p>
                  {tunnelReplaceConfirmationRequired && (
                    <label className="api-tunnel-confirm">
                      <input
                        type="checkbox"
                        checked={tunnelReplaceExisting}
                        onChange={event => setTunnelReplaceExisting(event.target.checked)}
                      />
                      <span>{t("api.tunnelReplaceExistingConfirm")}</span>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <label>
                    <span className="field-label">{t("api.tunnelExistingPublicUrl")}</span>
                    <input className="input" type="url" required value={tunnelPublicUrl} onChange={event => setTunnelPublicUrl(event.target.value)} placeholder={t("api.tunnelExistingPublicUrlPlaceholder")} />
                  </label>
                  <label>
                    <span className="field-label">{t("api.tunnelTokenOrCommand")}</span>
                    <input className="input api-tunnel-token-input" type="password" autoComplete="off" required value={tunnelToken} onChange={event => setTunnelToken(event.target.value)} placeholder={t("api.tunnelTokenOrCommandPlaceholder")} />
                  </label>
                </>
              )}

              <p className="api-tunnel-security-note small">
                <IconAlert />
                <span>{t(tunnelSetupMethod === "api" ? "api.tunnelTokenSecurity" : "api.tunnelRunnerTokenSecurity")}</span>
              </p>
              <div className="api-tunnel-guide-links">
                <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">
                  {t("api.tunnelOpenDashboard")} <IconExternal />
                </a>
                <a href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noreferrer">
                  {t("api.tunnelTokenGuide")} <IconExternal />
                </a>
                <a href="https://developers.cloudflare.com/tunnel/setup/" target="_blank" rel="noreferrer">
                  {t("api.tunnelExistingGuide")} <IconExternal />
                </a>
              </div>
              <div className="api-tunnel-setup-actions">
                <button type="submit" className="btn btn-primary" disabled={!tunnel.canConfigure || !tunnelSetupReady || tunnelRequestPending} aria-busy={tunnelRequestPending}>
                  {tunnelRequestPending ? <span className="spin" aria-hidden="true" /> : <IconGlobe />}
                  {tunnelRequestPending ? t("api.tunnelConfiguring") : t("api.tunnelConfigureStart")}
                </button>
              </div>
            </form>
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
