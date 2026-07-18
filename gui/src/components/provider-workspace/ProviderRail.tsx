/**
 * ProviderRail — the provider list rail of the workspace view (WP080a):
 * icon/status helpers and RailRow. The surrounding shell (search/filter/sort
 * chrome) arrives in WP080b; detail panels in WP090/091.
 */
/* eslint-disable react-refresh/only-export-components -- label helpers co-locate with the rail row */
import { useT, type TFn } from "../../i18n";
import { IconServer, IconStar } from "../../icons";
import {
  binProviderStatus,
  isFreeProvider,
  type WorkspaceItem,
  type WorkspaceProvider,
} from "../../provider-workspace/catalog";
import { isLocalProvider } from "../../provider-workspace/kind";
import { formatProviderDisplayName, providerIconSrc } from "../../provider-icons";

export function statusLabel(p: WorkspaceProvider, t: TFn): string {
  const s = binProviderStatus(p);
  if (s === "disabled") return t("prov.disabledBadge");
  if (s === "ready") return t("pws.status.ready");
  return t("pws.status.needsSetup");
}

export function authModeLabel(item: WorkspaceItem, t: TFn): string {
  switch (item.authMode) {
    case "oauth": return t("modal.badge.oauth");
    case "forward": return t("pws.auth.chatgptPassthrough");
    case "local": return t("modal.badge.local");
    case "key": return t("modal.badge.apiKey");
    default: return item.authMode ?? (item.keyOptional ? t("pws.auth.noKey") : t("modal.badge.apiKey"));
  }
}

export function railStatusCls(item: WorkspaceItem): string {
  const s = binProviderStatus(item);
  if (s === "disabled") return "providers-workspace-rail-status providers-workspace-rail-status--inactive";
  if (s === "ready") return "providers-workspace-rail-status providers-workspace-rail-status--active";
  return "providers-workspace-rail-status providers-workspace-rail-status--warning";
}

export function ProviderIcon({ name, adapter, baseUrl, cls }: {
  name: string;
  adapter?: string;
  baseUrl?: string;
  cls: string;
}) {
  const src = providerIconSrc(name, { adapter, baseUrl });
  return (
    <span className={cls}>
      {src ? (
        <img src={src} alt="" aria-hidden="true" />
      ) : (
        <IconServer aria-hidden="true" />
      )}
    </span>
  );
}

export function RailRow({ item, selected, tabbable, modelCount, isDefault, showConfigId, onClick, onFocus }: {
  item: WorkspaceItem;
  selected: boolean;
  tabbable: boolean;
  modelCount?: number;
  isDefault?: boolean;
  /** When display names collide (e.g. openai + chatgpt → ChatGPT), show the config id. */
  showConfigId?: boolean;
  onClick: () => void;
  onFocus: () => void;
}) {
  const t = useT();
  const free = isFreeProvider(item);
  const local = isLocalProvider(item);
  const status = statusLabel(item, t);
  const displayName = formatProviderDisplayName(item.name);
  const nameTitle = showConfigId ? `${displayName} (${item.name})` : displayName;
  const suffix = `${isDefault ? t("pws.rail.suffixDefault") : ""}${local ? t("pws.rail.suffixLocal") : free ? t("pws.rail.suffixFree") : ""}`;
  const countLabel = modelCount !== undefined && modelCount > 0
    ? (modelCount === 1 ? t("pws.modelCountOne") : t("pws.modelCount", { count: modelCount }))
    : "";
  const secondaryLabel = [showConfigId ? item.name : "", countLabel].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={`providers-workspace-rail-row${selected ? " providers-workspace-rail-row--selected" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      aria-label={t("pws.rail.selectAria", { name: nameTitle, status, suffix })}
      title={nameTitle}
      onFocus={onFocus}
    >
      <ProviderIcon
        name={item.name}
        adapter={item.adapter}
        baseUrl={item.baseUrl}
        cls="providers-workspace-rail-icon"
      />
      <span className="providers-workspace-rail-copy">
        <span className="providers-workspace-rail-primary">
          <span className="providers-workspace-rail-name-label" title={displayName}>{displayName}</span>
          {/* Only label exceptions (Local / Free). Paid is the unmarked default. */}
          {local ? (
            <span className="pwi-rail-badge pwi-rail-badge--local" title={t("pws.localTitle")}>{t("modal.badge.local")}</span>
          ) : free ? (
            <span className="pwi-rail-badge pwi-rail-badge--free" title={t("pws.freeTitle")}>{t("modal.badge.free")}</span>
          ) : null}
        </span>
        {secondaryLabel && (
          <span className="providers-workspace-rail-secondary" title={secondaryLabel}>
            {secondaryLabel}
          </span>
        )}
      </span>
      <span className="providers-workspace-rail-trail">
        {isDefault && (
          <span
            className="pwi-default-star"
            title={t("prov.defaultBadge")}
            aria-label={t("prov.defaultBadge")}
          >
            <IconStar width={17} height={17} aria-hidden="true" />
          </span>
        )}
        <span className={railStatusCls(item)} title={status} aria-hidden="true" />
      </span>
    </button>
  );
}
