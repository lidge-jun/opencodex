import type { ReactNode } from "react";
import type { TFn, TKey } from "../i18n/shared";
import { relativeTimeLabelsFromT, formatRelativeTime } from "../provider-workspace/usage";
import { Select, Switch } from "../ui";
import { IconExternal } from "../icons";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { desktopShellVersion, isDesktopShell, type HostOs } from "../lib/desktop-shell";
import {
  bucketMinutesForWindow,
  formatCompanionTokens,
  toggleCompanionModels,
  type CompanionSettings,
  type CompanionSettingsResponse,
  type groupCompanionModels,
} from "./usage-companion-utils";

/*
 * Presentational blocks of the Menu bar & widget tab. The panel owns loading and autosave;
 * these only lay the settings out as v2 cards: install status, the live preview, and the
 * settings grouped by what they change (menu bar, chart, popover).
 */

const MENU_METRICS = ["requests", "tokens", "cost", "quota", "none"] as const;
const WINDOWS = [6, 24, 72, 168] as const;
const CHART_STYLES = ["line", "stackedBar"] as const;
const TOKEN_METRICS = ["total", "input", "output", "cached"] as const;
const AGGREGATIONS = ["sum", "average", "max"] as const;
const GROUPINGS = ["model", "modelAccount"] as const;
const MENU_METRIC_KEYS: Record<(typeof MENU_METRICS)[number], TKey> = {
  requests: "usage.companion.menuRequests",
  tokens: "usage.companion.menuTokens",
  cost: "usage.companion.menuCost",
  quota: "usage.companion.menuQuota",
  none: "usage.companion.menuNone",
};
const WINDOW_KEYS: Record<(typeof WINDOWS)[number], TKey> = {
  6: "usage.companion.window6",
  24: "usage.companion.window24",
  72: "usage.companion.window72",
  168: "usage.companion.window168",
};
const TOKEN_METRIC_KEYS: Record<(typeof TOKEN_METRICS)[number], TKey> = {
  total: "usage.companion.metricTotal",
  input: "usage.companion.metricInput",
  output: "usage.companion.metricOutput",
  cached: "usage.companion.metricCached",
};
const SECTION_OPTIONS = [
  ["showToday", "usage.companion.sectionToday"],
  ["showChart", "usage.companion.sectionChart"],
  ["showModels", "usage.companion.sectionModels"],
  ["showCost", "usage.companion.sectionCost"],
  ["showAccounts", "usage.companion.sectionAccounts"],
] as const;
const AGGREGATION_KEYS: Record<(typeof AGGREGATIONS)[number], TKey> = {
  sum: "usage.companion.aggregationSum",
  average: "usage.companion.aggregationAverage",
  max: "usage.companion.aggregationMax",
};
export type InstallOs = Exclude<HostOs, "unknown">;

const INSTALL_STEP_KEYS: Record<InstallOs, readonly [TKey, TKey, TKey]> = {
  macos: ["usage.companion.installMacStep1", "usage.companion.installMacStep2", "usage.companion.installMacStep3"],
  windows: ["usage.companion.installWinStep1", "usage.companion.installWinStep2", "usage.companion.installWinStep3"],
  linux: ["usage.companion.installLinuxStep1", "usage.companion.installLinuxStep2", "usage.companion.installLinuxStep3"],
};

const OS_LABEL_KEYS: Record<InstallOs, TKey> = {
  macos: "usage.companion.osMac",
  windows: "usage.companion.osWindows",
  linux: "usage.companion.osLinux",
};

const SEGMENT_BUTTON = "h-7 px-2.5 text-[13px]";
const FIELD_LABEL = "field-label text-xs font-medium text-fg-muted";

/** A titled v2 card. */
export function CompanionCard({ title, aside, className, children }: { title?: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4 rounded-[12px] bg-surface p-5 ring-1 ring-line", className)}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title && <h3 className="m-0 text-[15px] font-semibold text-fg">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

function OsSelector({ value, onChange, t }: { value: InstallOs; onChange: (value: InstallOs) => void; t: TFn }) {
  return (
    <div className="usage-segmented w-fit" role="group" aria-label={t("usage.companion.installOs")}>
      {(Object.keys(OS_LABEL_KEYS) as InstallOs[]).map(os => (
        <button key={os} type="button" className={cn(`usage-segmented-btn${value === os ? " active" : ""}`, SEGMENT_BUTTON)} aria-pressed={value === os} onClick={() => onChange(os)}>
          {t(OS_LABEL_KEYS[os])}
        </button>
      ))}
    </div>
  );
}

function Segment<T extends string | number>({ label, value, options, optionLabel, onChange }: {
  label: string;
  value: T;
  options: readonly T[];
  optionLabel: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="usage-companion-control grid min-w-0 gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <div className="usage-segmented flex w-fit max-w-full flex-wrap" role="group" aria-label={label}>
        {options.map(option => (
          <button key={String(option)} type="button" className={cn(`usage-segmented-btn${option === value ? " active" : ""}`, SEGMENT_BUTTON)} aria-pressed={option === value} onClick={() => onChange(option)}>
            {optionLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectControl<T extends string>({ label, value, options, optionLabel, onChange }: {
  label: string;
  value: T;
  options: readonly T[];
  optionLabel: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="usage-companion-control grid min-w-0 gap-1.5">
      <span className={FIELD_LABEL}>{label}</span>
      <Select fullWidth label={label} triggerClassName="h-9 py-0 text-[13px]" value={value}
        onChange={next => onChange(next as T)}
        options={options.map(option => ({ value: option, label: optionLabel(option) }))} />
    </label>
  );
}

function StatusDot({ tone }: { tone: "on" | "off" }) {
  return <span className={cn("usage-companion-install-dot size-2 shrink-0 rounded-full", tone === "on" ? "bg-success" : "bg-fg-subtle")} aria-hidden="true" />;
}

/** Whether a companion app is talking to this proxy, and how to install one. */
export function CompanionInstall({ response, fetchedAt, installOs, onInstallOs, onOpenInBrowser, t }: {
  response: CompanionSettingsResponse | null;
  fetchedAt: number | null;
  installOs: InstallOs;
  onInstallOs: (os: InstallOs) => void;
  onOpenInBrowser: () => void;
  t: TFn;
}) {
  const lastSeenAt = response?.companion?.lastSeenAt ?? null;
  const connected = lastSeenAt !== null && fetchedAt !== null && fetchedAt - lastSeenAt <= 10 * 60 * 1000;
  const age = lastSeenAt === null || fetchedAt === null ? "" : formatRelativeTime(lastSeenAt, relativeTimeLabelsFromT(t), fetchedAt);
  const shell = isDesktopShell();
  const shellVersion = desktopShellVersion() ?? __APP_VERSION__;
  const stepKeys = INSTALL_STEP_KEYS[installOs];
  const steps = (
    <ol className="usage-companion-install-steps m-0 grid gap-2 pl-5 text-[13px] text-fg-muted">
      <li>
        {t(stepKeys[0])}{" "}
        <a className="font-medium text-highlight hover:underline" href="https://github.com/lidge-jun/opencodex/releases/latest" target="_blank" rel="noreferrer">{t("common.github")}</a>
      </li>
      <li>{t(stepKeys[1])}</li>
      <li>{t(stepKeys[2])}</li>
    </ol>
  );
  const installCommand = installOs === "macos"
    ? <code className="usage-companion-install-command block overflow-x-auto rounded-[8px] bg-bg px-3 py-2 text-xs ring-1 ring-line">xattr -d com.apple.quarantine /Applications/OpenCodex.app</code>
    : installOs === "linux"
      ? <code className="usage-companion-install-command block overflow-x-auto rounded-[8px] bg-bg px-3 py-2 text-xs ring-1 ring-line">chmod +x OpenCodex-*.AppImage</code>
      : null;
  const guide = (
    <div className="grid gap-3">
      <OsSelector value={installOs} onChange={onInstallOs} t={t} />
      {steps}
      {installCommand}
    </div>
  );
  const disclosure = (label: string, open: boolean) => (
    <details className="usage-companion-install-guide grid gap-3 border-t border-line pt-3" open={open}>
      <summary className="w-fit cursor-pointer text-[13px] font-medium text-fg-muted hover:text-fg">{label}</summary>
      <div className="pt-3">{guide}</div>
    </details>
  );

  const status = shell
    ? { tone: "off" as const, text: t("usage.companion.runningInDesktop", { version: shellVersion }) }
    : connected
      ? { tone: "on" as const, text: t(response?.companion?.kind === "desktop" ? "usage.companion.connectedDesktop" : "usage.companion.connected", { age }) }
      : { tone: "off" as const, text: lastSeenAt !== null ? t("usage.companion.lastSeen", { age }) : t("usage.companion.notConnected") };

  return (
    <CompanionCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 text-[15px] font-semibold text-fg">{t("usage.companion.title")}</h3>
          <p className="m-0 text-[13px] text-fg-muted">{t("usage.companion.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {shell && <Button variant="outline" size="sm" onClick={onOpenInBrowser}>{t("usage.companion.openInBrowser")}</Button>}
          <a className="inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-[13px] font-medium text-fg-muted no-underline transition-colors hover:bg-surface-2 hover:text-fg [&_svg]:size-3.5"
            href="https://opencodex.me/guides/macos-menu-bar/" target="_blank" rel="noreferrer">
            {t("usage.companion.installGuide")}<IconExternal aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className={cn("usage-companion-install-status flex items-center gap-2 text-[13px]", status.tone === "on" ? "text-fg" : "text-fg-muted")}>
        <StatusDot tone={status.tone} />
        <span className="usage-companion-install-last-seen">{status.text}</span>
      </div>
      {shell || connected
        ? disclosure(t("usage.companion.installAnother"), false)
        : disclosure(t("usage.companion.installTitle"), true)}
    </CompanionCard>
  );
}

/** Which models the widget chart draws, grouped by provider with a switch per group and model. */
export function CompanionModels({ groups, current, availableModels, knownTotals, disabled, onUpdate, t }: {
  groups: ReturnType<typeof groupCompanionModels>;
  current: CompanionSettings;
  availableModels: string[];
  knownTotals: Map<string, number>;
  disabled: boolean;
  onUpdate: (patch: Partial<CompanionSettings>) => void;
  t: TFn;
}) {
  const selectedModels = current.models ?? availableModels;
  const selectedModelSet = new Set(selectedModels);
  return (
    <div className="usage-companion-models grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={FIELD_LABEL}>{t("usage.companion.modelsOnChart")}</span>
          <span className="usage-companion-models-count text-xs whitespace-nowrap text-fg-subtle tabular-nums">{t("usage.companion.modelsCount", { selected: selectedModels.length, total: availableModels.length })}</span>
        </div>
        {current.models !== null && <Button variant="ghost" size="sm" onClick={() => onUpdate({ models: null })} disabled={disabled}>{t("usage.companion.modelsShowAll")}</Button>}
      </div>
      <div className="usage-companion-models-list max-h-72 overflow-y-auto rounded-[8px] border-0 bg-bg ring-1 ring-line">
        {groups.map(group => {
          const selectedCount = group.models.filter(model => selectedModelSet.has(model.id)).length;
          const groupOn = selectedCount === group.models.length;
          return (
            <div key={group.provider} className="usage-companion-model-group">
              <div className="usage-companion-model-group-header">
                <span className="usage-companion-model-provider">{group.provider}</span>
                <span className="usage-companion-model-chip mono text-caption">{group.models.length}</span>
                <Switch
                  on={groupOn}
                  mixed={selectedCount > 0 && !groupOn}
                  onClick={() => onUpdate({ models: toggleCompanionModels(current.models, availableModels, group.models.map(model => model.id), !groupOn) })}
                  disabled={disabled}
                  label={group.provider}
                  title={group.provider}
                />
              </div>
              {group.models.map(model => {
                const on = selectedModelSet.has(model.id);
                return (
                  <div key={model.id} className={`usage-companion-model-row${on ? "" : " is-off"}`}>
                    <Switch
                      on={on}
                      onClick={() => onUpdate({ models: toggleCompanionModels(current.models, availableModels, [model.id], !on) })}
                      disabled={disabled}
                      label={model.id}
                      title={model.id}
                    />
                    <code className="mono text-control">{model.id}</code>
                    <span className="usage-companion-model-total muted text-caption">{knownTotals.has(model.id) ? formatCompanionTokens(model.total) : "—"}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GroupHeading({ children }: { children: ReactNode }) {
  return <h4 className="m-0 text-[13px] font-semibold text-fg">{children}</h4>;
}

/** Every setting, grouped by what it changes. */
export function CompanionSettingsForm({ current, disabled, providerNames, onUpdate, t }: {
  current: CompanionSettings;
  disabled: boolean;
  providerNames: string[];
  onUpdate: (patch: Partial<CompanionSettings>) => void;
  t: TFn;
}) {
  const hiddenProviderSet = new Set(current.hiddenProviders);
  return (
    <fieldset className="usage-companion-controls m-0 flex min-w-0 flex-col gap-5 border-0 p-0" disabled={disabled}>
      <div className="grid gap-3">
        <GroupHeading>{t("usageV2.companionMenuBar")}</GroupHeading>
        <Segment label={t("usage.companion.menuBarShows")} value={current.menuBarMetric} options={MENU_METRICS} optionLabel={value => t(MENU_METRIC_KEYS[value])} onChange={value => onUpdate({ menuBarMetric: value })} />
      </div>
      <div className="grid gap-3 border-t border-line pt-4">
        <GroupHeading>{t("usageV2.companionChart")}</GroupHeading>
        <Segment label={t("usage.companion.window")} value={current.chartHours} options={WINDOWS} optionLabel={value => t(WINDOW_KEYS[value])} onChange={value => onUpdate({ chartHours: value, bucketMinutes: bucketMinutesForWindow(value) })} />
        <Segment label={t("usage.companion.style")} value={current.chartStyle} options={CHART_STYLES} optionLabel={value => value === "line" ? t("usage.companion.styleLine") : t("usage.companion.styleStacked")} onChange={value => onUpdate({ chartStyle: value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectControl label={t("usage.companion.metric")} value={current.tokenMetric} options={TOKEN_METRICS} optionLabel={value => t(TOKEN_METRIC_KEYS[value])} onChange={value => onUpdate({ tokenMetric: value })} />
          <SelectControl label={t("usage.companion.groupBy")} value={current.chartGrouping} options={GROUPINGS} optionLabel={value => value === "model" ? t("usage.companion.groupModel") : t("usage.companion.groupAccount")} onChange={value => onUpdate({ chartGrouping: value })} />
        </div>
      </div>
      <fieldset className="usage-companion-switches m-0 grid gap-1 border-0 border-t border-line p-0 pt-4">
        <legend className="float-left mb-2 w-full p-0"><GroupHeading>{t("usage.companion.popoverSections")}</GroupHeading></legend>
        {SECTION_OPTIONS.map(([key, label]) => (
          <div key={key} className="usage-companion-switch flex items-center justify-between gap-3 py-1 text-[13px] text-fg">
            <span>{t(label)}</span>
            <Switch on={current[key]} label={t(label)} onClick={() => onUpdate({ [key]: !current[key] })} />
          </div>
        ))}
      </fieldset>
      <details className="usage-companion-advanced border-t border-line pt-4">
        <summary className="w-fit cursor-pointer text-[13px] font-semibold text-fg">{t("usage.companion.advanced")}</summary>
        <div className="usage-companion-advanced-body grid gap-4 pt-3">
          <SelectControl label={t("usage.companion.aggregation")} value={current.aggregation} options={AGGREGATIONS} optionLabel={value => t(AGGREGATION_KEYS[value])} onChange={value => onUpdate({ aggregation: value })} />
          <label className="usage-companion-control grid min-w-0 gap-1.5">
            <span className={FIELD_LABEL}>{t("usage.companion.menuText")}</span>
            <input className="h-9 rounded-control text-[13px]" value={current.menuBarTemplate ?? ""} onChange={event => onUpdate({ menuBarTemplate: event.target.value })} maxLength={200} />
            <span className="text-xs text-fg-subtle">{t("usage.companion.placeholders")} <code>{"{requests} {totalTokens} {inputTokens} {outputTokens} {costUsd} {quotaPercent}"}</code></span>
          </label>
          {providerNames.length > 0 && (
            <fieldset className="usage-companion-check-list m-0 grid gap-2 border-0 p-0">
              <legend className={cn(FIELD_LABEL, "mb-1 p-0")}>{t("usage.companion.hideProviders")}</legend>
              {providerNames.map(provider => (
                <label key={provider}>
                  <input type="checkbox" checked={hiddenProviderSet.has(provider)} onChange={event => onUpdate({ hiddenProviders: event.target.checked ? [...current.hiddenProviders, provider] : current.hiddenProviders.filter(item => item !== provider) })} /> <span>{provider}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
      </details>
    </fieldset>
  );
}
