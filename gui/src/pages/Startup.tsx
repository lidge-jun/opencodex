import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconCheck, IconPower, IconRefresh, IconTerminal } from "../icons";
import { useI18n, type TKey } from "../i18n/shared";
import { EmptyState } from "../ui";

type StartupStatus = "native" | "protected" | "at-risk";
type StartupProtection = "service" | "shim" | "none";

interface StartupHealthData {
  status: StartupStatus;
  routingKind: "native" | "opencodex-local" | "custom-local" | "custom-remote" | "unknown";
  routingInjected: boolean;
  localRoutingDependency: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  serviceInstalled: boolean;
  serviceViable: boolean;
  serviceEnabled: boolean;
  serviceRunning: boolean;
  serviceStale: boolean;
  serviceConflict: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: "full" | "cli-only" | "none";
  platform: string;
  recommendedCommand: string | null;
  diagnosticStale: boolean;
  commands: {
    installService: string;
    installShim: string;
    restoreNative: string;
  };
}

interface TrayStatusData {
  supported: boolean;
  installed: boolean;
  running: boolean;
  stale: boolean;
  summary: string;
}

function isTrayStatusData(value: unknown): value is TrayStatusData {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.supported === "boolean"
    && typeof row.installed === "boolean"
    && typeof row.running === "boolean"
    && typeof row.stale === "boolean"
    && typeof row.summary === "string";
}

const STATUS_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.status.native",
  protected: "startup.status.protected",
  "at-risk": "startup.status.atRisk",
};

const SUMMARY_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.summary.native",
  protected: "startup.summary.protected",
  "at-risk": "startup.summary.atRisk",
};

const PROTECTION_KEYS: Record<StartupProtection, TKey> = {
  service: "startup.protection.service",
  shim: "startup.protection.shim",
  none: "startup.protection.none",
};

function StateBadge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`badge ${ok ? "badge-green" : "badge-amber"}`}>{ok ? yes : no}</span>;
}

export default function Startup({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<StartupHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [tray, setTray] = useState<TrayStatusData | null>(null);
  const [trayLoading, setTrayLoading] = useState(true);
  const [trayBusy, setTrayBusy] = useState(false);
  const [trayError, setTrayError] = useState(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setTrayLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/startup-health`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const next = await res.json() as StartupHealthData;
      if (signal?.aborted) return;
      setData(next);
      setFailed(next.diagnosticStale);
      if (next.platform === "win32") {
        setTrayError(false);
        try {
          const trayRes = await fetch(`${apiBase}/api/windows-tray`, { signal });
          if (!trayRes.ok) throw new Error("tray status failed");
          const trayNext = await trayRes.json() as unknown;
          if (!isTrayStatusData(trayNext)) throw new Error("invalid tray status");
          if (!signal?.aborted) {
            setTray(trayNext);
            setTrayError(false);
          }
        } catch {
          if (!signal?.aborted) {
            setTray(null);
            setTrayError(true);
          }
        } finally {
          if (!signal?.aborted) setTrayLoading(false);
        }
      } else {
        setTrayLoading(false);
      }
    } catch {
      if (signal?.aborted) return;
      setFailed(true);
      setTray(null);
      setTrayError(true);
      setTrayLoading(false);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (!data?.diagnosticStale) return;
    const timer = window.setTimeout(() => { void refresh(); }, 2000);
    return () => window.clearTimeout(timer);
  }, [data, refresh]);

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      window.setTimeout(() => setCopied(current => current === command ? null : current), 1600);
    } catch {
      setCopied(null);
    }
  };

  const runTrayAction = async (action: "install" | "start" | "stop" | "uninstall") => {
    setTrayBusy(true);
    setTrayError(false);
    try {
      const res = await fetch(`${apiBase}/api/windows-tray`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error("tray action failed");
      const body = await res.json() as { status: TrayStatusData };
      if (!isTrayStatusData(body.status)) throw new Error("invalid tray action status");
      setTray(body.status);
      setTrayError(false);
    } catch {
      setTray(null);
      setTrayError(true);
    } finally {
      setTrayBusy(false);
    }
  };

  const routingKey: TKey = data?.routingKind === "opencodex-local" ? "startup.routing.proxy"
    : data?.routingKind === "custom-local" ? "startup.routing.customLocal"
      : data?.routingKind === "custom-remote" ? "startup.routing.customRemote"
        : data?.routingKind === "unknown" ? "startup.routing.unknown"
          : "startup.routing.native";

  const statusClass = failed
    ? "startup-hero--risk"
    : data?.status === "protected"
    ? "startup-hero--safe"
    : data?.status === "at-risk"
      ? "startup-hero--risk"
      : "startup-hero--native";
  const StatusIcon = failed || data?.status === "at-risk" ? IconAlert : IconCheck;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{t("startup.title")}</h2>
          <p className="page-sub startup-page-sub">{t("startup.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>
          <IconRefresh /> {t("startup.refresh")}
        </button>
      </div>

      {loading && !data ? (
        <EmptyState title={t("startup.loading")} />
      ) : failed && !data ? (
        <EmptyState title={t("startup.error")} />
      ) : data ? (
        <>
          {failed && <div className="notice notice-warn" role="alert">{t("startup.staleData")}</div>}
          <section className={`panel startup-hero ${statusClass}`} aria-live="polite">
            <div className="startup-hero-icon"><StatusIcon /></div>
            <div className="startup-hero-copy">
              <span className={`badge ${failed || data.status === "at-risk" ? "badge-amber" : "badge-green"}`}>
                {t(failed ? "startup.status.atRisk" : STATUS_KEYS[data.status])}
              </span>
              <h3>{t(failed ? "startup.error" : SUMMARY_KEYS[data.status])}</h3>
              <p>{failed
                ? t("startup.staleData")
                : data.status === "at-risk"
                ? t(data.routingKind === "custom-local" ? "startup.riskDetailCustomLocal" : data.shimCoverage === "cli-only" ? "startup.riskDetailWindowsShim" : "startup.riskDetail")
                : t("startup.safeDetail")}</p>
            </div>
          </section>

          <div className="startup-state-grid">
            <section className="stat">
              <div className="label">{t("startup.routing")}</div>
              <div className="value">{t(routingKey)}</div>
            </section>
            <section className="stat">
              <div className="label">{t("startup.restartProtection")}</div>
              <div className="value">{t(PROTECTION_KEYS[data.protection])}</div>
            </section>
            <section className="stat">
              <div className="label">{t("startup.preference")}</div>
              <div className="value">{t(data.autostartEnabled ? "startup.enabled" : "startup.disabled")}</div>
            </section>
          </div>

          <section className="panel startup-details">
            <div className="panel-head">
              <h3 className="panel-title">{t("startup.details")}</h3>
              <span className="muted mono">{data.platform}</span>
            </div>
            <div className="startup-detail-row">
              <div><strong>{t("startup.service")}</strong><span>{t("startup.serviceHint")}</span></div>
              <StateBadge
                ok={data.serviceViable}
                yes={t("startup.viable")}
                no={t(data.serviceConflict ? "startup.conflict" : data.serviceStale ? "startup.stale" : data.serviceInstalled ? "startup.unhealthy" : data.serviceSupported ? "startup.notInstalled" : "startup.unsupported")}
              />
            </div>
            <div className="startup-detail-row">
              <div><strong>{t("startup.shim")}</strong><span>{t("startup.shimHint")}</span></div>
              <StateBadge
                ok={data.shimHealthy && data.autostartEnabled}
                yes={t(data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy")}
                no={t(data.shimInstalled
                  ? data.shimHealthy && !data.autostartEnabled ? "startup.installedDisabled" : "startup.stale"
                  : "startup.notInstalled")}
              />
            </div>
          </section>

          {data.platform === "win32" && (
            <section className="panel startup-actions">
              <div className="panel-head">
                <h3 className="panel-title">{t("startup.tray.title")}</h3>
                <IconPower />
              </div>
              <p className="muted">{t("startup.tray.hint")}</p>
              <div className="startup-detail-row">
                <div>
                  <strong>{t("startup.tray.login")}</strong>
                  <span>{t("startup.tray.notProtection")}</span>
                </div>
                {trayLoading || trayError || !tray
                  ? <span className="badge badge-amber">{t(trayLoading ? "startup.tray.loading" : "startup.tray.unavailable")}</span>
                  : <StateBadge
                    ok={tray.running && !tray.stale}
                    yes={t("startup.tray.running")}
                    no={t(tray.stale ? "startup.tray.stale" : tray.installed ? "startup.tray.stopped" : "startup.tray.notInstalled")}
                  />}
              </div>
              <div className="startup-tray-buttons">
                {!trayLoading && !trayError && tray && !tray.installed && !tray.stale && (
                  <button type="button" className="btn btn-primary" disabled={trayBusy} onClick={() => void runTrayAction("install")}>{t("startup.tray.install")}</button>
                )}
                {!trayLoading && !trayError && tray?.installed && !tray.stale && !tray.running && (
                  <button type="button" className="btn btn-primary" disabled={trayBusy} onClick={() => void runTrayAction("start")}>{t("startup.tray.start")}</button>
                )}
                {!trayLoading && !trayError && tray?.running && !tray.stale && (
                  <button type="button" className="btn btn-ghost" disabled={trayBusy} onClick={() => void runTrayAction("stop")}>{t("startup.tray.stop")}</button>
                )}
                {!trayLoading && !trayError && tray && (tray.installed || tray.stale) && (
                  <button type="button" className="btn btn-danger" disabled={trayBusy} onClick={() => void runTrayAction("uninstall")}>{t("startup.tray.uninstall")}</button>
                )}
              </div>
              {(trayError || tray?.stale) && <div className="notice notice-warn" role="alert">{t("startup.tray.error")}</div>}
            </section>
          )}

          <section className="panel startup-actions">
            <div className="panel-head">
              <h3 className="panel-title">{t("startup.recovery")}</h3>
              <IconTerminal />
            </div>
            <p className="muted">{t("startup.recoveryHint")}</p>
            <div className="startup-command-list">
              {data.serviceSupported && (
                <div className="startup-command-row">
                  <div>
                    <strong>{t("startup.command.service")}</strong>
                    <code>{data.commands.installService}</code>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(data.commands.installService)}>
                    {copied === data.commands.installService ? t("startup.copied") : t("startup.copy")}
                  </button>
                </div>
              )}
              <div className="startup-command-row">
                <div>
                  <strong>{t("startup.command.shim")}</strong>
                  <code>{data.commands.installShim}</code>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(data.commands.installShim)}>
                  {copied === data.commands.installShim ? t("startup.copied") : t("startup.copy")}
                </button>
              </div>
              <div className="startup-command-row">
                <div>
                  <strong>{t("startup.command.native")}</strong>
                  <code>{data.commands.restoreNative}</code>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(data.commands.restoreNative)}>
                  {copied === data.commands.restoreNative ? t("startup.copied") : t("startup.copy")}
                </button>
              </div>
            </div>
            {data.status === "at-risk" && (
              <div className="notice notice-warn startup-action-notice" role="alert">
                <IconPower /> {t("startup.recommended", { cmd: data.recommendedCommand ?? data.commands.installService })}
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
