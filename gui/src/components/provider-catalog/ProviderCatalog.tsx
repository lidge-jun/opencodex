import { useMemo, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { providerIconSrc } from "../../provider-icons";
import {
  ACCESS_GROUPS,
  accessGroupCounts,
  bucketPresets,
  curatedPresets,
  filterByAccessGroup,
  filterPresets,
  freeCatalogSections,
  type CatalogPreset,
  type ProviderAccessGroup,
} from "./provider-presets";

export type AccountLoginStatus = { loggedIn: boolean; email?: string; error?: string; needsReauth?: boolean };
export type AccountLoginRow = {
  id: string;
  label: string;
  kind: "oauth" | "key" | "codex";
  statusLabel?: string;
  href?: string;
};

export type CatalogTier = "accounts" | "free" | "paid";
type FreeCatalogGroup = ProviderAccessGroup | "all" | "existing";

export default function ProviderCatalog({
  presets,
  usageRank = {},
  presetsLoading = false,
  initialTier = "free",
  onSelectPreset,
  onSelectCustom,
  accountRows = [],
  accountStatus = {},
  busyProvider = null,
  onLogin,
  onCancelLogin,
  onLogout,
  onClearSelection,
  selectedPreset,
  detail,
  standalone = false,
}: {
  presets: CatalogPreset[];
  usageRank?: Record<string, number>;
  presetsLoading?: boolean;
  initialTier?: CatalogTier;
  onSelectPreset: (preset: CatalogPreset) => void;
  onSelectCustom: () => void;
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  busyProvider?: string | null;
  onLogin?: (provider: string) => void;
  onCancelLogin?: (provider: string) => void;
  onLogout?: (provider: string) => void;
  onClearSelection?: () => void;
  selectedPreset?: CatalogPreset | null;
  detail?: ReactNode;
  standalone?: boolean;
}) {
  const t = useT();
  const [tier, setTier] = useState<CatalogTier>(initialTier);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<FreeCatalogGroup>("all");

  const catalog = useMemo(() => presets.filter(p => p.id !== "custom"), [presets]);
  const ranked = useMemo(() => [...catalog].sort((a, b) => {
    const difference = (usageRank[b.id] ?? 0) - (usageRank[a.id] ?? 0);
    return difference || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  }), [catalog, usageRank]);
  const buckets = useMemo(() => bucketPresets(ranked), [ranked]);
  const curated = useMemo(() => curatedPresets(ranked), [ranked]);
  const counts = useMemo(() => accessGroupCounts(curated), [curated]);
  const freeSections = useMemo(() => freeCatalogSections(ranked), [ranked]);
  const freeDirectory = freeSections.directory;
  const tierList = tier === "free"
    ? group === "all" ? freeDirectory : group === "existing" ? freeSections.existing : filterByAccessGroup(curated, group)
    : buckets[tier];
  const rows = useMemo(() => filterPresets(tierList, query), [tierList, query]);
  const filteredAccountRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? accountRows.filter(row => row.label.toLowerCase().includes(normalized) || row.id.toLowerCase().includes(normalized))
      : accountRows;
  }, [accountRows, query]);
  const searchCount = tier === "accounts" ? accountRows.length
    : tier === "free" && group === "all" ? freeDirectory.length
    : tierList.length;

  if (standalone) return <div className="provider-catalog-standalone">{detail}</div>;

  const badges = (p: CatalogPreset) => {
    const auth = p.codexAccountMode === "direct" ? <span className="badge badge-green">{t("modal.badge.direct")}</span>
      : p.codexAccountMode === "pool" ? <span className="badge badge-accent">{t("modal.badge.pool")}</span>
      : p.auth === "oauth" ? <span className="badge badge-accent">{t("modal.badge.oauth")}</span>
      : p.auth === "forward" ? <span className="badge badge-green">{t("modal.badge.codexLogin")}</span>
      : p.auth === "local" ? <span className="badge badge-amber">{t("modal.badge.local")}</span>
      : p.keyOptional ? null
      : <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>;
    const access = p.accessGroups?.includes("recurring-or-keyless")
      ? <span className="badge badge-green">{t("modal.badge.recurring")}</span>
      : (p.freeTier || p.keyOptional) && p.auth === "key"
        ? <span className="badge badge-green">{t("modal.badge.free")}</span>
        : null;
    const support = p.supportLevel === "reference"
      ? <span className="badge badge-amber">{t("modal.badge.reference")}</span>
      : p.supportLevel === "experimental"
        ? <span className="badge badge-muted">{t("modal.badge.experimental")}</span>
        : null;
    return <>{access}{auth}{support}</>;
  };

  return (
    <div className="provider-catalog">
      <div
        className="provider-catalog-tabs"
        role="tablist"
        aria-label={t("modal.catalogModes")}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
            : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
            : (current + 1) % tabs.length;
          event.preventDefault();
          tabs[next]?.focus();
          tabs[next]?.click();
        }}
      >
        {(["accounts", "free", "paid"] as const).map(candidate => (
          <button
            key={candidate}
            id={`provider-catalog-tab-${candidate}`}
            role="tab"
            aria-selected={tier === candidate}
            aria-controls={`provider-catalog-panel-${candidate}`}
            tabIndex={tier === candidate ? 0 : -1}
            className={`provider-catalog-tab${tier === candidate ? " active" : ""}`}
            onClick={() => { setTier(candidate); setQuery(""); setGroup("all"); onClearSelection?.(); }}
          >
            {t(candidate === "accounts" ? "modal.tab.accounts" : candidate === "free" ? "modal.tab.free" : "modal.tab.paid")}
          </button>
        ))}
      </div>

      <div
        id={`provider-catalog-panel-${tier}`}
        role="tabpanel"
        aria-labelledby={`provider-catalog-tab-${tier}`}
        className={`provider-catalog-workspace${selectedPreset ? " has-selection" : ""}${tier === "accounts" ? " is-accounts" : ""}`}
      >
        <nav className="provider-catalog-groups" aria-label={t(tier === "free" ? "modal.accessGroups" : "modal.providerDirectory")}>
          {tier === "free" ? (["all", ...ACCESS_GROUPS, ...(freeSections.existing.length ? ["existing" as const] : [])] as const).map(candidate => (
            <button
              key={candidate}
              className={`provider-catalog-group${group === candidate ? " active" : ""}`}
              aria-current={group === candidate ? "page" : undefined}
              onClick={() => { setGroup(candidate); onClearSelection?.(); }}
            >
              <span>{t(candidate === "all" ? "modal.group.all" : `modal.group.${candidate}`)}</span>
              <strong>{candidate === "all" ? freeDirectory.length : candidate === "existing" ? freeSections.existing.length : counts[candidate]}</strong>
            </button>
          )) : (
            <div className="provider-catalog-accounts-hint muted text-label">
              {t(tier === "accounts" ? "modal.accountsHint" : "modal.paidHint")}
            </div>
          )}
          {tier !== "accounts" && <button className="link-btn provider-catalog-custom" onClick={onSelectCustom}>{t("modal.notListed")}</button>}
        </nav>

        <section className="provider-catalog-browser" aria-label={t("modal.providerDirectory")}>
          <div className="provider-catalog-search-wrap">
            <input
              className="input provider-catalog-search"
              value={query}
              onChange={e => { setQuery(e.target.value); onClearSelection?.(); }}
              placeholder={t("modal.searchCount", { count: searchCount })}
              aria-label={t("modal.searchCount", { count: searchCount })}
            />
          </div>

          <div className="provider-catalog-rows">
            {presetsLoading && rows.length === 0 && <div className="provider-catalog-empty muted text-control">{t("modal.catalogLoading")}</div>}
            {tier !== "accounts" && rows.map(p => {
              const icon = providerIconSrc(p.id, { adapter: p.adapter, baseUrl: p.baseUrl, defaultModel: p.defaultModel, models: p.models });
              return (
                <button key={p.id} className={`provider-catalog-row${selectedPreset?.id === p.id ? " active" : ""}`} aria-pressed={selectedPreset?.id === p.id} onClick={() => onSelectPreset(p)}>
                  <span className="provider-catalog-icon">{icon ? <img src={icon} alt="" aria-hidden="true" /> : p.label.slice(0, 1)}</span>
                  <span className="provider-catalog-row-copy">
                    <span className="title">{p.label}</span>
                    <span className="sub">{p.id}</span>
                  </span>
                  <span className="provider-catalog-badges">{badges(p)}</span>
                </button>
              );
            })}
            {tier !== "accounts" && !presetsLoading && rows.length === 0 && <div className="provider-catalog-empty muted text-control">{t("modal.noMatch")}</div>}

            {tier === "accounts" && filteredAccountRows.map(row => {
              const status = accountStatus[row.id];
              const busy = busyProvider === row.id;
              const loggedIn = !!status?.loggedIn;
              const statusText = loggedIn ? (status.email ?? row.statusLabel ?? t("modal.accountLoggedIn")) : (status?.error ?? row.statusLabel ?? t("modal.accountLoggedOut"));
              return (
                <div key={row.id} className="provider-catalog-row provider-catalog-account-row">
                  <span className="provider-catalog-row-copy"><span className="title">{row.label}</span><span className="sub">{statusText}</span></span>
                  <span className="provider-catalog-badges">
                    {row.kind === "key" ? null : row.kind === "codex" ? <>
                      {loggedIn && <a className="btn btn-ghost" href={row.href ?? "#codex-auth"}>{t("modal.accountManage")}</a>}
                      {onLogin && <button className={loggedIn ? "btn btn-ghost" : "btn btn-primary"} onClick={() => onLogin(row.id)}>{loggedIn ? t("modal.accountAdd") : t("modal.accountLogin")}</button>}
                    </> : loggedIn ? (
                      onLogout && <button className="btn btn-ghost" onClick={() => onLogout(row.id)}>{t("modal.accountLogout")}</button>
                    ) : busy ? (
                      onCancelLogin && <button className="btn btn-ghost" onClick={() => onCancelLogin(row.id)}>{t("common.cancel")}</button>
                    ) : (
                      onLogin && <button className="btn btn-primary" onClick={() => onLogin(row.id)}>{t("modal.accountLogin")}</button>
                    )}
                  </span>
                </div>
              );
            })}
            {tier === "accounts" && filteredAccountRows.length === 0 && !presetsLoading && <div className="provider-catalog-empty muted text-control">{t("modal.noMatch")}</div>}
          </div>
        </section>

        <section className="provider-catalog-detail" aria-live="polite">
          {tier === "accounts"
            ? <div className="provider-catalog-detail-empty"><strong>{t("modal.tab.accounts")}</strong><span>{t("modal.accountsHint")}</span></div>
            : detail ?? <div className="provider-catalog-detail-empty"><strong>{t("modal.selectProvider")}</strong><span>{t("modal.selectProviderHint")}</span></div>}
        </section>
      </div>
    </div>
  );
}
