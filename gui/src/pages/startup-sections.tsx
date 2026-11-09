import { Fragment, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CommandLineIcon, ComputerSettingsIcon, LaptopIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { useI18n, type TKey } from "../i18n/shared";
import { confirmAction } from "../action-dialogs";
import { desktopBadgeKey, desktopManagesStartup, desktopSupervisionFailed, startupPresentation, startupRiskDetailKey } from "../startup-health-ui";
import { IconAlert, IconCheck, IconChevron, IconInfo, IconTerminal } from "../icons";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { OptionCard } from "../components/v2-startup/option-card";
import { Banner, CommandRow, HelpButton, HelpRegion, IconTile, StateBadge, type Tone } from "../components/v2-startup/primitives";
import { useHelp } from "../components/v2-startup/use-help";
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

/*
 * The Startup page answers one question at a glance: will Codex still work after a reboot?
 * The status hero says yes or no, the protection options sit under it as cards that each carry
 * their state and the one action they need, and the copyable commands close the page as the
 * fallback. Long explanations stay one "?" away.
 */

const hugeIcon = (icon: typeof ServerStack01Icon) => <HugeiconsIcon icon={icon} size={18} strokeWidth={1.8} aria-hidden="true" />;

export function StartupHeroSection({
  failed,
  data,
}: {
  failed: boolean;
  data: StartupHealthData;
}) {
  const { t } = useI18n();
  const help = useHelp();
  const presentation = startupPresentation(data, failed);
  const unverified = presentation === "unverified";
  const risk = presentation === "error" || presentation === "at-risk";
  const StatusIcon = unverified ? IconInfo : risk ? IconAlert : IconCheck;

  const routingKey: TKey = data.routingKind === "opencodex-local" ? "startup.routing.proxy"
    : data.routingKind === "custom-local" ? "startup.routing.customLocal"
      : data.routingKind === "custom-remote" ? "startup.routing.customRemote"
        : data.routingKind === "unknown" ? "startup.routing.unknown"
          : "startup.routing.native";

  // The three stat cards that once restated this answer are one labelled line now.
  const facts: Array<[TKey, string]> = [
    ["startup.routing", t(routingKey)],
    ["startup.restartProtection", t(unverified ? "startup.unverified" : PROTECTION_KEYS[data.protection])],
    ["startup.preference", t(data.autostartEnabled ? "startup.enabled" : "startup.disabled")],
  ];

  return (
    <section className="startup-status flex min-w-0 gap-4 rounded-[12px] bg-surface p-5 ring-1 ring-line" aria-live="polite" data-status={failed ? "error" : data.status}>
      <span aria-hidden="true" className={cn(
        "grid size-11 shrink-0 place-items-center rounded-full [&_svg]:size-[22px]",
        unverified ? "bg-surface-2 text-fg-muted" : risk ? "bg-warning-soft text-warning" : "bg-success-soft text-success",
      )}><StatusIcon /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <StateBadge tone={unverified ? "neutral" : risk ? "warn" : "ok"} className="self-start">
          {t(unverified ? "startup.unverified" : failed ? "startup.status.atRisk" : STATUS_KEYS[data.status])}
        </StateBadge>
        <div className="flex items-start gap-1.5">
          <h3 className="m-0 text-[20px] leading-7 font-semibold tracking-[-0.02em] text-fg">{t(unverified ? desktopManagesStartup(data) ? "startup.loginUnverifiedTitle" : "startup.unverified" : failed ? "startup.error" : SUMMARY_KEYS[data.status])}</h3>
          <span className="mt-0.5"><HelpButton open={help.open} controls={help.id} name={t("startup.title")} onToggle={help.toggle} /></span>
        </div>
        <p className="m-0 max-w-[72ch] text-[14px] leading-[21px] text-fg-muted">
          {unverified ? t(desktopManagesStartup(data) ? "startup.loginUnverifiedAction" : "startup.subtitle") : data.status === "at-risk" && data.routingKind === "opencodex-local" && desktopManagesStartup(data) && !desktopSupervisionFailed(data) ? t("startup.loginUnverifiedAction") : failed ? t("startup.staleData") : data.status === "at-risk" ? t(startupRiskDetailKey(data)) : t("startup.safeDetail")}
        </p>
        <p className="startup-status-line m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">
          {facts.map(([label, value], index) => (
            <Fragment key={label}>
              {index > 0 && <span aria-hidden="true" className="text-fg-subtle">·</span>}
              <span className="inline-flex flex-wrap gap-x-1.5"><span className="text-fg-subtle">{t(label)}</span><span className="font-medium text-fg">{value}</span></span>
            </Fragment>
          ))}
        </p>
        <HelpRegion id={help.id} open={help.open} className="mt-1 max-w-[72ch]">{t("startup.subtitle")}</HelpRegion>
      </div>
    </section>
  );
}

type InstallResult = { kind: "success" | "error"; action: StartupInstallAction; repair?: boolean; detail?: string } | null;

export function StartupOptionsSection({
  data,
  failed,
  loading = false,
  installBusy,
  installResult,
  onInstall,
  tray,
}: {
  data: StartupHealthData;
  failed: boolean;
  loading?: boolean;
  installBusy: StartupInstallAction | null;
  installResult: InstallResult;
  onInstall: (action: StartupInstallAction, opts?: { repair?: boolean }) => void;
  /** The Windows tray card, rendered in the same grid; null off Windows. */
  tray?: ReactNode;
}) {
  const { t } = useI18n();
  // Repair only rewrites stale assets — conflict/disabled need uninstall/reinstall, not repair.
  const serviceNeedsRepair = data.serviceSupported && data.serviceInstalled && data.serviceStale && !data.serviceConflict;
  // An intact overlay that is not yet on the shell's PATH needs activation; reinstalling changes nothing.
  const shimAwaitingActivation = data.shimInstalled && !data.shimHealthy && data.shimActivationPending === true;
  const shimNeedsRepair = data.shimInstalled && !data.shimHealthy && !shimAwaitingActivation;
  const shimActionsDisabled = installBusy !== null || failed || loading;
  // Desktop owns startup, so a second supervisor stays off. The shim is safe under Desktop: its
  // `ocx ensure` waits for or starts the Desktop app instead of a competing CLI proxy (#6971).
  const desktopManages = desktopManagesStartup(data);
  const serviceActionsDisabled = shimActionsDisabled || desktopManages;

  const serviceBadge: { tone: Tone; label: string } = data.serviceViable
    ? { tone: "ok", label: t("startup.viable") }
    : {
      tone: data.serviceInstalled ? "warn" : "neutral",
      label: t(data.serviceConflict ? "startup.conflict" : data.serviceStale ? "startup.stale" : data.serviceInstalled ? "startup.unhealthy" : data.serviceSupported ? "startup.notInstalled" : "startup.unsupported"),
    };
  const shimOk = data.shimHealthy && data.autostartEnabled;
  const shimBadge: { tone: Tone; label: string } = shimOk
    ? { tone: "ok", label: t(data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy") }
    : {
      tone: data.shimInstalled ? "warn" : "neutral",
      label: t(data.shimInstalled
        ? data.shimHealthy && !data.autostartEnabled ? "startup.installedDisabled"
          : shimAwaitingActivation ? "startup.shimActivationPending" : "startup.stale"
        : "startup.notInstalled"),
    };
  const desktopOk = Boolean(data.desktop && !failed && data.desktop.viable);
  const cards = (data.desktop ? 1 : 0) + 2 + (tray ? 1 : 0);

  const installButton = (action: StartupInstallAction, label: string, repair: boolean, disabled: boolean) => (
    <Button variant="primary" size="sm" aria-label={`${label} - ${t(repair ? "startup.repair" : "startup.install")}`} disabled={disabled}
      onClick={() => onInstall(action, repair ? { repair: true } : undefined)}>
      {t(installBusy === action ? (repair ? "startup.repairing" : "startup.installing") : (repair ? "startup.repair" : "startup.install"))}
    </Button>
  );

  return (
    <section className="startup-options flex min-w-0 flex-col gap-3" aria-labelledby="startup-options-title">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 px-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id="startup-options-title" className="m-0 text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">{t("startupV2.optionsTitle")}</h3>
          <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("startupV2.optionsHint")}</p>
        </div>
        <span className="font-mono text-[12px] text-fg-subtle" title={t("startup.details")}>{data.platform}</span>
      </div>
      <div className={cn("grid gap-3 sm:grid-cols-2", cards === 3 && "lg:grid-cols-3")}>
        {data.desktop && (
          <OptionCard option="desktop" icon={hugeIcon(LaptopIcon)} title={t("startup.protection.desktop")}
            badge={{ tone: desktopOk ? "ok" : startupPresentation(data, failed) === "unverified" ? "neutral" : "warn", label: t(startupPresentation(data, failed) === "unverified" ? "startup.loginUnverifiedTitle" : desktopBadgeKey(data.desktop, failed)) }}>
            {desktopOk ? <p className="m-0">{t("startup.desktopHint")}</p>
              : !failed && data.desktop.running ? <p className="m-0">{t("startup.desktopRunning")}</p> : null}
          </OptionCard>
        )}
        <OptionCard option="service" icon={hugeIcon(ServerStack01Icon)} title={t("startup.service")}
          tag={data.serviceSupported && !desktopManages ? t("startupV2.recommended") : undefined}
          badge={serviceBadge}
          actions={(data.serviceSupported && !data.serviceInstalled) ? installButton("install-service", t("startup.service"), false, serviceActionsDisabled)
            : serviceNeedsRepair ? installButton("install-service", t("startup.service"), true, serviceActionsDisabled) : undefined}>
          <p className="m-0">{t("startup.serviceHint")}</p>
        </OptionCard>
        <OptionCard option="shim" icon={hugeIcon(CommandLineIcon)} title={t("startupV2.shimPlain")} term={t("startup.shim")}
          badge={shimBadge}
          actions={!data.shimInstalled ? installButton("install-shim", t("startup.shim"), false, shimActionsDisabled)
            : shimNeedsRepair ? installButton("install-shim", t("startup.shim"), true, shimActionsDisabled) : undefined}>
          <p className="m-0">{t(shimAwaitingActivation ? "startup.shimActivationHint" : "startup.shimHint")}</p>
        </OptionCard>
        {tray}
      </div>
      {installResult && (
        <Banner tone={installResult.kind === "success" ? "ok" : "warn"} className="startup-action-result">
          {installResult.kind === "success"
            ? installResult.action === "install-service"
              ? t(installResult.repair ? "startup.serviceRepaired" : "startup.serviceInstalled")
              : t(installResult.repair ? "startup.shimRepaired" : "startup.shimInstalled")
            : `${t("startup.installFailed")} ${installResult.detail ?? ""}`}
        </Banner>
      )}
    </section>
  );
}

export function StartupTrayCard({
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

  /**
   * Uninstalling removes the tray helper, so it asks first. Written as a named async
   * function rather than a promise chain inside the handler: a floating `.then` in a JSX
   * handler has no rejection path, which is what `no-floating-then-in-jsx-handler` catches.
   */
  const requestTrayUninstall = async () => {
    if (await confirmAction({ message: t("startup.tray.uninstall"), tone: "danger" })) {
      onTrayAction("uninstall");
    }
  };

  const known = !trayLoading && !trayError && tray !== null;
  const badge: { tone: Tone; label: string } = !known
    ? { tone: trayLoading ? "neutral" : "warn", label: t(trayLoading ? "startup.tray.loading" : "startup.tray.unavailable") }
    : tray.running && !tray.stale
      ? { tone: "ok", label: t("startup.tray.running") }
      : { tone: tray.stale ? "warn" : "neutral", label: t(tray.stale ? "startup.tray.stale" : tray.installed ? "startup.tray.stopped" : "startup.tray.notInstalled") };

  const actions = known ? (
    <>
      {!tray.installed && !tray.stale && <Button variant="primary" size="sm" disabled={trayBusy} onClick={() => onTrayAction("install")}>{t("startup.tray.install")}</Button>}
      {tray.installed && !tray.stale && !tray.running && <Button variant="primary" size="sm" disabled={trayBusy} onClick={() => onTrayAction("start")}>{t("startup.tray.start")}</Button>}
      {tray.running && !tray.stale && <Button variant="outline" size="sm" disabled={trayBusy} onClick={() => onTrayAction("stop")}>{t("startup.tray.stop")}</Button>}
      {(tray.installed || tray.stale) && (
        <Button variant="ghost" size="sm" className="hover:bg-danger-soft hover:text-danger" disabled={trayBusy} onClick={() => { void requestTrayUninstall(); }}>{t("startup.tray.uninstall")}</Button>
      )}
    </>
  ) : undefined;

  return (
    <OptionCard option="tray" icon={hugeIcon(ComputerSettingsIcon)} title={t("startup.tray.title")} term={t("startup.tray.login")}
      tag={t("startupV2.optional")} badge={badge} actions={actions}>
      <p className="m-0">{t("startup.tray.hint")}</p>
      <p className="m-0 text-[12px] leading-[18px] text-fg-subtle">{t("startup.tray.notProtection")}</p>
      {(trayError || tray?.stale) && <Banner tone="warn" role="alert">{t("startup.tray.error")}</Banner>}
    </OptionCard>
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
  const desktopManages = desktopManagesStartup(data);

  // An already-registered service is refreshed in place. `install` re-registers, which
  // needs elevation on Windows and can switch a WinSW backend to Task Scheduler, so
  // handing that command to someone who already has a service costs them a UAC prompt
  // they do not need. A conflict still needs uninstall-then-install.
  const serviceCommand = data.serviceInstalled && !data.serviceConflict
    ? data.commands.repairService
    : data.commands.installService;

  const commands: Array<[TKey, string]> = [
    ...(data.serviceSupported && !desktopManages ? [["startup.command.service", serviceCommand] as [TKey, string]] : []),
    ["startup.command.shim", data.commands.installShim],
    ["startup.command.native", data.commands.restoreNative],
  ];

  return (
    <section className="startup-recovery-panel rounded-[12px] bg-surface p-1 ring-1 ring-line" aria-label={t("startup.recovery")}>
      {/*
        The one-click actions above are the primary path; the copyable commands are the
        fallback, open by default only while protection is missing.
      */}
      <details className="startup-recovery group" open={startupPresentation(data) === "at-risk"}>
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-[10px] px-3 py-2.5 transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight [&::-webkit-details-marker]:hidden">
          <IconTile className="size-8 rounded-[8px] [&_svg]:size-4"><IconTerminal /></IconTile>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg">{t("startup.recovery")}</span>
            <span className="text-[13px] leading-5 text-fg-muted">{t(desktopManages ? "startup.protection.desktop" : "startupV2.recoveryMeta")}</span>
          </span>
          <span aria-hidden="true" className="text-fg-subtle transition-transform duration-200 group-open:rotate-90 [&_svg]:size-4"><IconChevron /></span>
        </summary>
        <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
          {!desktopManages && <p className="m-0 text-[13px] leading-5 text-fg-muted">{t("startup.recoveryHint")}</p>}
          <div className="flex flex-col divide-y divide-line rounded-[8px] bg-bg ring-1 ring-line">
            {commands.map(([label, command]) => (
              <CommandRow key={label} label={t(label)} command={command} copied={copied === command} onCopy={() => onCopy(command)} />
            ))}
          </div>
          {data.status === "at-risk" && data.recommendedCommand && !desktopManages && (
            <Banner tone="warn" role="alert">{t("startup.recommended", { cmd: data.recommendedCommand })}</Banner>
          )}
        </div>
      </details>
    </section>
  );
}
