import { useI18n, type TKey } from "../i18n/shared";
import { startupRiskDetailKey } from "../startup-health-ui";
import { IconAlert, IconCheck, IconPower, IconTerminal } from "../icons";
import type {
  StartupHealthData,
  StartupInstallAction,
  TrayStatusData,
} from "./startup-shared";
import {
  PROTECTION_KEYS,
  STATUS_KEYS,
  SUMMARY_KEYS,
} from "./startup-shared";

function StartupStateBadge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`badge ${ok ? "badge-green" : "badge-amber"}`}>{ok ? yes : no}</span>;
}

export function StartupHeroSection({
  failed,
  data,
}: {
  failed: boolean;
  data: StartupHealthData;
}) {
  const { t } = useI18n();
  const statusClass = failed
    ? "startup-hero--risk"
    : data.status === "protected"
      ? "startup-hero--safe"
      : data.status === "at-risk"
        ? "startup-hero--risk"
        : "startup-hero--native";
  const StatusIcon = failed || data.status === "at-risk" ? IconAlert : IconCheck;

  const routingKey: TKey = data.routingKind === "opencodex-local" ? "startup.routing.proxy"
    : data.routingKind === "custom-local" ? "startup.routing.customLocal"
      : data.routingKind === "custom-remote" ? "startup.routing.customRemote"
        : data.routingKind === "unknown" ? "startup.routing.unknown"
          : "startup.routing.native";

  return (
    <>
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
              ? t(startupRiskDetailKey(data))
              : t("startup.safeDetail")}</p>
          {/*
            The three stat cards that used to restate this answer (routing, protection,
            preference) are one line now; the page subtitle rides underneath as a visible
            sentence rather than a title attribute.
          */}
          <p className="muted startup-state-line">
            {t(routingKey)} · {t(PROTECTION_KEYS[data.protection])} · {t(data.autostartEnabled ? "startup.enabled" : "startup.disabled")}
          </p>
          <p className="muted text-label">{t("startup.subtitle")}</p>
        </div>
      </section>
    </>
  );
}

export function StartupDetailsSection({
  data,
  failed,
  loading = false,
  installBusy,
  installResult,
  onInstall,
}: {
  data: StartupHealthData;
  failed: boolean;
  loading?: boolean;
  installBusy: StartupInstallAction | null;
  installResult: { kind: "success" | "error"; action: StartupInstallAction; repair?: boolean; detail?: string } | null;
  onInstall: (action: StartupInstallAction, opts?: { repair?: boolean }) => void;
}) {
  const { t } = useI18n();
  // Repair only rewrites stale assets — conflict/disabled need uninstall/reinstall, not repair.
  const serviceNeedsRepair = data.serviceSupported && data.serviceInstalled && data.serviceStale && !data.serviceConflict;
  const shimNeedsRepair = data.shimInstalled && !data.shimHealthy;
  const actionsDisabled = installBusy !== null || failed || loading;

  return (
    <section className="panel startup-details">
      <div className="panel-head">
        <h3 className="panel-title">{t("startup.details")}</h3>
        <span className="muted mono">{data.platform}</span>
      </div>
      <div className="startup-detail-row">
        <div><strong>{t("startup.service")}</strong><span>{t("startup.serviceHint")}</span></div>
        <div className="startup-detail-actions">
          <StartupStateBadge
            ok={data.serviceViable}
            yes={t("startup.viable")}
            no={t(data.serviceConflict ? "startup.conflict" : data.serviceStale ? "startup.stale" : data.serviceInstalled ? "startup.unhealthy" : data.serviceSupported ? "startup.notInstalled" : "startup.unsupported")}
          />
          {data.serviceSupported && !data.serviceInstalled && (
            <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.service")} - ${t("startup.install")}`} disabled={actionsDisabled} onClick={() => onInstall("install-service")}>
              {t(installBusy === "install-service" ? "startup.installing" : "startup.install")}
            </button>
          )}
          {serviceNeedsRepair && (
            <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.service")} - ${t("startup.repair")}`} disabled={actionsDisabled} onClick={() => onInstall("install-service", { repair: true })}>
              {t(installBusy === "install-service" ? "startup.repairing" : "startup.repair")}
            </button>
          )}
        </div>
      </div>
      <div className="startup-detail-row">
        <div><strong>{t("startup.shim")}</strong><span>{t("startup.shimHint")}</span></div>
        <div className="startup-detail-actions">
          <StartupStateBadge
            ok={data.shimHealthy && data.autostartEnabled}
            yes={t(data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy")}
            no={t(data.shimInstalled
              ? data.shimHealthy && !data.autostartEnabled ? "startup.installedDisabled" : "startup.stale"
              : "startup.notInstalled")}
          />
          {!data.shimInstalled && (
            <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.shim")} - ${t("startup.install")}`} disabled={actionsDisabled} onClick={() => onInstall("install-shim")}>
              {t(installBusy === "install-shim" ? "startup.installing" : "startup.install")}
            </button>
          )}
          {shimNeedsRepair && (
            <button type="button" className="btn btn-primary btn-sm" aria-label={`${t("startup.shim")} - ${t("startup.repair")}`} disabled={actionsDisabled} onClick={() => onInstall("install-shim", { repair: true })}>
              {t(installBusy === "install-shim" ? "startup.repairing" : "startup.repair")}
            </button>
          )}
        </div>
      </div>
      {installResult && (
        <div className={`notice ${installResult.kind === "success" ? "notice-ok" : "notice-warn"} startup-action-notice`} role="status" aria-live="polite">
          {installResult.kind === "success"
            ? installResult.action === "install-service"
              ? t(installResult.repair ? "startup.serviceRepaired" : "startup.serviceInstalled")
              : t(installResult.repair ? "startup.shimRepaired" : "startup.shimInstalled")
            : `${t("startup.installFailed")} ${installResult.detail ?? ""}`}
        </div>
      )}
    </section>
  );
}

export function StartupTraySection({
  tray,
  trayLoading,
  trayError,
  trayBusy,
  onTrayAction,
}: {
  tray: TrayStatusData | null;
  trayLoading: boolean;
  trayError: boolean;
  trayBusy: boolean;
  onTrayAction: (action: "install" | "start" | "stop" | "uninstall") => void;
}) {
  const { t } = useI18n();

  return (
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
          : <StartupStateBadge
            ok={tray.running && !tray.stale}
            yes={t("startup.tray.running")}
            no={t(tray.stale ? "startup.tray.stale" : tray.installed ? "startup.tray.stopped" : "startup.tray.notInstalled")}
          />}
      </div>
      <div className="startup-tray-buttons">
        {!trayLoading && !trayError && tray && !tray.installed && !tray.stale && (
          <button type="button" className="btn btn-primary" disabled={trayBusy} onClick={() => onTrayAction("install")}>{t("startup.tray.install")}</button>
        )}
        {!trayLoading && !trayError && tray?.installed && !tray.stale && !tray.running && (
          <button type="button" className="btn btn-primary" disabled={trayBusy} onClick={() => onTrayAction("start")}>{t("startup.tray.start")}</button>
        )}
        {!trayLoading && !trayError && tray?.running && !tray.stale && (
          <button type="button" className="btn btn-ghost" disabled={trayBusy} onClick={() => onTrayAction("stop")}>{t("startup.tray.stop")}</button>
        )}
        {!trayLoading && !trayError && tray && (tray.installed || tray.stale) && (
          <button type="button" className="btn btn-danger" disabled={trayBusy} onClick={() => {
            if (window.confirm(t("startup.tray.uninstall"))) onTrayAction("uninstall");
          }}>{t("startup.tray.uninstall")}</button>
        )}
      </div>
      {(trayError || tray?.stale) && (
        <div className="notice notice-warn startup-tray-error" role="alert">{t("startup.tray.error")}</div>
      )}
    </section>
  );
}

export function StartupRecoverySection({
  data,
  copied,
  onCopy,
}: {
  data: StartupHealthData;
  copied: string | null;
  onCopy: (command: string) => void;
}) {
  const { t } = useI18n();

  // An already-registered service is refreshed in place. `install` re-registers, which
  // needs elevation on Windows and can switch a WinSW backend to Task Scheduler, so
  // handing that command to someone who already has a service costs them a UAC prompt
  // they do not need. A conflict still needs uninstall-then-install.
  const serviceCommand = data.serviceInstalled && !data.serviceConflict
    ? data.commands.repairService
    : data.commands.installService;

  return (
    <section className="panel startup-actions">
      <div className="panel-head">
        <h3 className="panel-title">{t("startup.recovery")}</h3>
        <IconTerminal />
      </div>
      {/*
        The one-click install/repair buttons above are the primary path; the copyable
        commands are the fallback. Open by default only while protection is missing.
      */}
      <details className="startup-recovery-details" open={data.status !== "protected"}>
        <summary className="muted">{t("startup.recoveryHint")}</summary>
      <div className="startup-command-list">
        {data.serviceSupported && (
          <div className="startup-command-row">
            <div>
              <strong>{t("startup.command.service")}</strong>
              <code>{serviceCommand}</code>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(serviceCommand)}>
              {copied === serviceCommand ? t("startup.copied") : t("startup.copy")}
            </button>
          </div>
        )}
        <div className="startup-command-row">
          <div>
            <strong>{t("startup.command.shim")}</strong>
            <code>{data.commands.installShim}</code>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(data.commands.installShim)}>
            {copied === data.commands.installShim ? t("startup.copied") : t("startup.copy")}
          </button>
        </div>
        <div className="startup-command-row">
          <div>
            <strong>{t("startup.command.native")}</strong>
            <code>{data.commands.restoreNative}</code>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(data.commands.restoreNative)}>
            {copied === data.commands.restoreNative ? t("startup.copied") : t("startup.copy")}
          </button>
        </div>
      </div>
      {data.status === "at-risk" && (
        <div className="notice notice-warn startup-action-notice" role="alert">
          <IconPower /> {t("startup.recommended", { cmd: data.recommendedCommand ?? data.commands.installService })}
        </div>
      )}
      </details>
    </section>
  );
}
