import { useT } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import { distinctProviderLabels, formatContextWindow, type RouteRow } from "../../route-board-model";
import type { ComboStrategy } from "../../combo-workspace-data";
import { Switch } from "../../ui";
import { ProviderIcon } from "../provider-workspace/ProviderRail";
import { QuotaLine } from "./QuotaLine";
import { StrategyMenu } from "./StrategyMenu";

const MAX_STACKED_ICONS = 4;

/** One combo: icons, name + public id, channel order, quota line, tags, context, strategy, switch. */
export function ModelRouteRow({
  row,
  expanded,
  busy,
  locked = false,
  lastResortActive = false,
  onOpenContext,
  message,
  onToggleExpanded,
  onStrategy,
  onEnabled,
  children,
}: {
  row: RouteRow;
  expanded: boolean;
  busy: boolean;
  locked?: boolean;
  /** The combo sets `cooldownWaitPolicy`; otherwise fallback-only marks are inert. */
  lastResortActive?: boolean;
  onOpenContext?: () => void;
  message: string | null;
  onToggleExpanded: () => void;
  onStrategy: (next: ComboStrategy) => void;
  onEnabled: (next: boolean) => void;
  children?: React.ReactNode;
}) {
  const t = useT();
  const separator = row.combo.strategy === "failover" ? "→" : "·";
  const providers = [...new Set(row.channels.map((channel) => channel.provider))];
  const labels = distinctProviderLabels(providers, (provider) => formatProviderDisplayName(provider, t));
  const offChannels = row.channels.filter((channel) => channel.providerDisabled).length;
  const panelId = `rb-panel-${row.combo.id}`;
  return (
    <li className={`rb-row${expanded ? " rb-row--open" : ""}${row.enabled ? "" : " rb-row--off"}`}>
      <div className="rb-row-main">
        <button
          type="button"
          className="rb-row-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggleExpanded}
        >
          <span className="rb-icons" aria-hidden="true">
            {providers.slice(0, MAX_STACKED_ICONS).map((provider) => (
              <ProviderIcon key={provider} name={provider} cls="provider-icon provider-icon-sm rb-icon" />
            ))}
          </span>
          <span className="rb-row-body">
            <span className="rb-row-title">
              <strong>{row.displayName}</strong>
              <code>{row.publicId}</code>
            </span>
            <span className="rb-order">
              {row.channels.map((channel, index) => (
                <span key={channel.key} className={`rb-order-item${channel.providerDisabled ? " rb-order-item--off" : ""}`}>
                  {index > 0 && <span className="rb-order-sep" aria-hidden="true">{separator}</span>}
                  {labels.get(channel.provider)}
                  {channel.lastResort && (
                    <span
                      className={`rb-mark${lastResortActive ? "" : " rb-mark--inert"}`}
                      title={lastResortActive ? t("routeBoard.edit.lastResortHint") : t("routeBoard.edit.lastResortInert")}
                    >{t("routeBoard.lastResort")}</span>
                  )}
                </span>
              ))}
            </span>
            <QuotaLine quotas={row.quotas} labels={labels} />
          </span>
        </button>
        <div className="rb-row-controls">
          {locked && <span className="rb-tag rb-tag--warn" title={t("routeBoard.lockedHint")}>{t("routeBoard.locked")}</span>}
          {offChannels > 0 && <span className="rb-tag rb-tag--warn">{t("routeBoard.tag.channelsOff", { count: offChannels })}</span>}
          {row.combo.strategy === "round-robin" && row.combo.stickyLimit > 1 && (
            <span className="rb-tag">{t("routeBoard.tag.sticky", { count: row.combo.stickyLimit })}</span>
          )}
          {row.combo.imageInput === "disabled" && <span className="rb-tag">{t("routeBoard.tag.noImages")}</span>}
          {row.contextWindow !== undefined && (
            <button type="button" className="rb-tag rb-tag--button" title={t("routeBoard.contextHint")} onClick={onOpenContext}>
              {t("routeBoard.context", { size: formatContextWindow(row.contextWindow) })}
              {row.contextBasis !== "catalog" && (
                <span className="rb-tag-basis"> {t(row.contextBasis === "max" ? "routeBoard.contextBasis.max" : "routeBoard.contextBasis.min")}</span>
              )}
            </button>
          )}
          <StrategyMenu
            value={row.combo.strategy}
            label={t("routeBoard.strategyLabel", { model: row.publicId })}
            disabled={busy || locked}
            onChange={onStrategy}
          />
          <Switch
            on={row.enabled}
            disabled={busy}
            label={t("routeBoard.enabledLabel", { model: row.publicId })}
            title={t("routeBoard.enabledHint")}
            onClick={() => onEnabled(!row.enabled)}
          />
        </div>
      </div>
      {message && <p className="rb-row-message" role="alert">{message}</p>}
      <div id={panelId} hidden={!expanded}>{expanded ? children : null}</div>
    </li>
  );
}
