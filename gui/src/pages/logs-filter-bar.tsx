import { useRef } from "react";
import type { TFn } from "../i18n/shared";
import { IconX } from "../icons";
import { formatProviderDisplayName } from "../provider-icons";
import type { LogFilterState, LogStatusFilter, LogTimeWindow } from "./logs-filter";
import { logsSurfaceKeyDown } from "./logs-surface-keydown";

interface LogsFilterBarProps {
  filters: LogFilterState;
  options: { models: string[]; providers: string[] };
  hasActiveFilters: boolean;
  filteredCount: number;
  totalCount: number;
  t: TFn;
  onFilterChange: (next: LogFilterState) => void;
  onResetFilters: () => void;
}

export function LogsFilterBar({
  filters, options, hasActiveFilters, filteredCount, totalCount, t, onFilterChange, onResetFilters,
}: LogsFilterBarProps) {
  const allSurfaceRef = useRef<HTMLButtonElement>(null);
  const resetFilters = () => {
    onResetFilters();
    allSurfaceRef.current?.focus({ preventScroll: true });
  };
  const currentSpeed = filters.maxTokPerSec === 15
    ? "slow"
    : filters.minTokPerSec === 15 && filters.maxTokPerSec === 50
      ? "medium"
      : filters.minTokPerSec === 50 ? "fast" : "all";

  const handleSpeedChange = (value: string) => {
    const bounds = value === "slow"
      ? { minTokPerSec: undefined, maxTokPerSec: 15 }
      : value === "medium"
        ? { minTokPerSec: 15, maxTokPerSec: 50 }
        : value === "fast"
          ? { minTokPerSec: 50, maxTokPerSec: undefined }
          : { minTokPerSec: undefined, maxTokPerSec: undefined };
    onFilterChange({ ...filters, ...bounds });
  };

  return (
    <div className="logs-filter-container">
      <div className="logs-toolbar">
        <span className="muted text-control">{t("logs.filter.surface.label")}</span>
        <div className="segmented logs-segmented" role="radiogroup" aria-label={t("logs.filter.surface.label")}>
          {(["all", "claude", "codex", "grok"] as const).map(surface => (
            <button
              key={surface}
              ref={surface === "all" ? allSurfaceRef : undefined}
              type="button"
              role="radio"
              aria-checked={filters.surface === surface}
              id={`logs-surface-${surface}`}
              tabIndex={filters.surface === surface ? 0 : -1}
              className={`btn btn-sm${filters.surface === surface ? " btn-primary" : " btn-ghost"}`}
              style={{ background: filters.surface === surface ? undefined : "transparent", color: filters.surface === surface ? undefined : "var(--muted)" }}
              onClick={() => onFilterChange({ ...filters, surface })}
              onKeyDown={event => logsSurfaceKeyDown(event, surface, nextSurface => onFilterChange({ ...filters, surface: nextSurface }))}
            >
              {t(`logs.filter.surface.${surface}`)}
            </button>
          ))}
        </div>

        <label className="muted text-control logs-filter-field">
          <input type="checkbox" checked={filters.interceptedOnly} onChange={event => onFilterChange({ ...filters, interceptedOnly: event.target.checked })} />
          {t("logs.filter.interceptedHelpersOnly")}
        </label>

        <label className="muted text-control logs-filter-field">
          {t("logs.filter.provider.label")}
          <select className="input select-sm" value={filters.provider} aria-label={t("logs.filter.provider.label")} onChange={event => onFilterChange({ ...filters, provider: event.target.value })}>
            <option value="">{t("logs.filter.provider.all")}</option>
            {options.providers.map(provider => <option key={provider} value={provider}>{formatProviderDisplayName(provider, t)}</option>)}
          </select>
        </label>

        <label className="muted text-control logs-filter-field">
          {t("logs.filter.model.label")}
          <select className="input select-sm" value={filters.model} aria-label={t("logs.filter.model.label")} onChange={event => onFilterChange({ ...filters, model: event.target.value })}>
            <option value="">{t("logs.filter.model.all")}</option>
            {options.models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>

        <label className="muted text-control logs-filter-field">
          {t("logs.filter.time.label")}
          <select className="input select-sm" value={filters.timeWindow} aria-label={t("logs.filter.time.label")} onChange={event => onFilterChange({ ...filters, timeWindow: event.target.value as LogTimeWindow })}>
            <option value="all">{t("logs.filter.time.all")}</option>
            <option value="15m">{t("logs.filter.time.15m")}</option>
            <option value="1h">{t("logs.filter.time.1h")}</option>
            <option value="24h">{t("logs.filter.time.24h")}</option>
          </select>
        </label>

        <label className="muted text-control logs-filter-field">
          {t("logs.filter.speed.label")}
          <select className="input select-sm" value={currentSpeed} aria-label={t("logs.filter.speed.label")} onChange={event => handleSpeedChange(event.target.value)}>
            <option value="all">{t("logs.filter.speed.all")}</option>
            <option value="slow">{t("logs.filter.speed.slow")}</option>
            <option value="medium">{t("logs.filter.speed.medium")}</option>
            <option value="fast">{t("logs.filter.speed.fast")}</option>
          </select>
        </label>

        <label className="muted text-control logs-filter-field">
          {t("logs.filter.status.label")}
          <select className="input select-sm" value={filters.status} aria-label={t("logs.filter.status.label")} onChange={event => onFilterChange({ ...filters, status: event.target.value as LogStatusFilter })}>
            <option value="all">{t("logs.filter.status.all")}</option>
            <option value="success">{t("logs.filter.status.success")}</option>
            <option value="errors">{t("logs.filter.status.errors")}</option>
          </select>
        </label>
      </div>

      <div className="logs-toolbar logs-toolbar-secondary">
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.conversation.label")}
          <input type="search" className="input mono select-sm" value={filters.conversationId} onChange={event => onFilterChange({ ...filters, conversationId: event.target.value })} placeholder={t("logs.filter.conversation.placeholder")} aria-label={t("logs.filter.conversation.label")} />
        </label>

        {hasActiveFilters && (
          <div className="logs-filter-status">
            <span className="muted text-control">{t("logs.filter.showingCount", { count: filteredCount, total: totalCount })}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}><IconX /> {t("logs.filter.reset")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
