/**
 * ProviderWorkspaceShell — the workspace chrome (WP080b): search, filter
 * popover (status/pricing/type/sort), grouped rail with keyboard navigation,
 * empty state, and a render-prop `detail` slot. Detail/Overview panel bodies
 * arrive in WP090/091; until then the slot renders a real placeholder message.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { IconFilter, IconSearch, IconBoxes, IconGlobe, IconLock, IconKey } from "../../icons";
import {
  buildProviderWorkspace,
  hideRedundantChatGptForwardProviders,
  isFreeProvider,
  sortWorkspaceItems,
  type ProviderSortMode,
  type WorkspaceItem,
  type WorkspaceProvider,
  type WorkspaceSections,
} from "../../provider-workspace/catalog";
import { providerKind } from "../../provider-workspace/kind";
import { countAvailableModels, parseAvailableModels, parseSelectedModels, type ProviderAvailableModels, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import { formatProviderDisplayName } from "../../provider-icons";
import { RailRow } from "./ProviderRail";
import type { PricingFilter, ProviderUsageTotals, StatusFilter, TypeFilter } from "./types";
import ProviderOverviewDashboard from "./ProviderOverviewDashboard";

export type AddProviderIntent = { tier?: "accounts" | "free" | "paid"; custom?: boolean };

/** Detail-slot data plumbed per selected provider (props-down; no shared hook). */
export interface DetailSlotData {
  usageTotals?: import("./types").ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
}

const SORT_DEFS: { id: ProviderSortMode; labelKey: "pws.sort.az" | "pws.sort.za" | "pws.sort.freePaid" | "pws.sort.paidFree" | "pws.sort.accountsFirst" }[] = [
  { id: "az", labelKey: "pws.sort.az" },
  { id: "za", labelKey: "pws.sort.za" },
  { id: "free-paid", labelKey: "pws.sort.freePaid" },
  { id: "paid-free", labelKey: "pws.sort.paidFree" },
  { id: "accounts-first", labelKey: "pws.sort.accountsFirst" },
];

export default function ProviderWorkspaceShell({
  providers,
  apiBase,
  defaultProvider,
  selectedName,
  onSelect,
  onAddProvider,
  detail,
}: {
  providers: Record<string, WorkspaceProvider>;
  apiBase: string;
  defaultProvider: string;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  onAddProvider: (intent?: AddProviderIntent) => void;
  /** Detail body for the selected provider (WP090); a placeholder renders when absent. */
  detail?: (item: WorkspaceItem, data: DetailSlotData) => ReactNode;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>({ ready: true, needsSetup: true, disabled: true });
  const [pricingFilter, setPricingFilter] = useState<PricingFilter>({ free: true, paid: true });
  const [typeFilter, setTypeFilter] = useState<TypeFilter>({ cloud: true, local: true, selfHosted: true, login: true });
  const [sortMode, setSortMode] = useState<ProviderSortMode>("az");
  const [filterOpen, setFilterOpen] = useState(false);
  const [railFocusName, setRailFocusName] = useState<string | null>(null);
  const [modelCounts, setModelCounts] = useState<ProviderModelCounts>({});
  const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
  const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReportView>>({});
  const filterWrapRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () => buildProviderWorkspace(hideRedundantChatGptForwardProviders(providers)),
    [providers],
  );

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/selected-models`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(data => {
        if (cancelled) return;
        setModelCounts(countAvailableModels(data));
        setAvailableModels(parseAvailableModels(data));
        setSelectedModels(parseSelectedModels(data));
        setModelsLoadFailed(false);
        setModelsLoading(false);
      })
      .catch(() => { if (!cancelled) { setModelsLoadFailed(true); setModelsLoading(false); } });
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/usage?range=30d`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { providers?: Array<{ provider: string; requests: number; totalTokens?: number }> } | null) => {
        if (cancelled || !data) return;
        const byProvider: Record<string, ProviderUsageTotals> = {};
        for (const p of data.providers ?? []) byProvider[p.provider] = { requests: p.requests, totalTokens: p.totalTokens };
        setUsageTotals(byProvider);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/provider-quotas`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { reports?: Array<{ provider: string; label?: string; source?: string; updatedAt?: number; quota?: unknown }> } | null) => {
        if (cancelled || !data) return;
        const byProvider: Record<string, ProviderQuotaReportView> = {};
        for (const report of data.reports ?? []) {
          if (!report?.provider) continue;
          byProvider[report.provider] = {
            label: report.label,
            source: report.source,
            updatedAt: typeof report.updatedAt === "number" ? report.updatedAt : Date.now(),
            quota: report.quota,
          };
        }
        setQuotaReports(byProvider);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    if (!filterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFilterOpen(false); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const freeCount = useMemo(() => allItems.filter(isFreeProvider).length, [allItems]);
  const paidCount = allItems.length - freeCount;
  const typeCounts = useMemo(() => {
    const counts = { cloud: 0, local: 0, selfHosted: 0, login: 0 };
    for (const item of allItems) counts[providerKind(item)] += 1;
    return counts;
  }, [allItems]);

  const filteredSections = useMemo((): WorkspaceSections => {
    const q = search.trim().toLowerCase();
    const byQueryAndFacets = (items: WorkspaceItem[]) => {
      const filtered = items.filter(p => {
        if (q && !p.name.toLowerCase().includes(q) && !p.adapter.toLowerCase().includes(q)) return false;
        const free = isFreeProvider(p);
        if (free && !pricingFilter.free) return false;
        if (!free && !pricingFilter.paid) return false;
        if (!typeFilter[providerKind(p)]) return false;
        return true;
      });
      return sortWorkspaceItems(filtered, sortMode);
    };
    return {
      ready: statusFilter.ready ? byQueryAndFacets(sections.ready) : [],
      needsSetup: statusFilter.needsSetup ? byQueryAndFacets(sections.needsSetup) : [],
      disabled: statusFilter.disabled ? byQueryAndFacets(sections.disabled) : [],
    };
  }, [sections, search, statusFilter, pricingFilter, typeFilter, sortMode]);

  const filterActive =
    !statusFilter.ready || !statusFilter.needsSetup || !statusFilter.disabled
    || !pricingFilter.free || !pricingFilter.paid
    || !typeFilter.cloud || !typeFilter.local || !typeFilter.selfHosted || !typeFilter.login
    || sortMode !== "az";

  const resetFilters = () => {
    setStatusFilter({ ready: true, needsSetup: true, disabled: true });
    setPricingFilter({ free: true, paid: true });
    setTypeFilter({ cloud: true, local: true, selfHosted: true, login: true });
    setSortMode("az");
  };

  const selectedItem = useMemo(
    () => selectedName ? allItems.find(p => p.name === selectedName) ?? null : null,
    [selectedName, allItems],
  );

  const duplicateDisplayNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      const label = formatProviderDisplayName(item.name);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([label]) => label));
  }, [allItems]);

  if (allItems.length === 0) {
    return <WorkspaceEmptyState onAddProvider={onAddProvider} />;
  }

  const statusFilterOptions = [
    { key: "ready" as const, label: t("pws.status.ready"), count: sections.ready.length },
    { key: "needsSetup" as const, label: t("pws.status.needsSetup"), count: sections.needsSetup.length },
    { key: "disabled" as const, label: t("prov.disabledBadge"), count: sections.disabled.length },
  ];
  const railGroups = [
    { id: "ready", label: t("pws.status.ready"), count: filteredSections.ready.length, ariaLabel: t("pws.groupReady", { count: filteredSections.ready.length }), items: filteredSections.ready },
    { id: "needs-setup", label: t("pws.status.needsSetup"), count: filteredSections.needsSetup.length, ariaLabel: t("pws.groupNeedsSetup", { count: filteredSections.needsSetup.length }), items: filteredSections.needsSetup },
    { id: "disabled", label: t("prov.disabledBadge"), count: filteredSections.disabled.length, ariaLabel: t("pws.groupDisabled", { count: filteredSections.disabled.length }), items: filteredSections.disabled },
  ];
  const visibleRailNames = railGroups.flatMap(group => group.items.map(item => item.name));
  const railTabbableName = railFocusName && visibleRailNames.includes(railFocusName)
    ? railFocusName
    : selectedName && visibleRailNames.includes(selectedName)
      ? selectedName
      : visibleRailNames[0] ?? null;

  return (
    <div className="pws-shell-container">
      <div className="pws-root">
        <aside className="pws-rail" aria-label={t("pws.providerList")}>
        <div className="pws-search-row">
          <div className="pws-search-wrap">
            <IconSearch className="pws-search-icon" width={14} height={14} aria-hidden="true" />
            <input
              type="search"
              className="input pws-search-input"
              placeholder={t("pws.searchPlaceholder")}
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label={t("pws.searchPlaceholder")}
            />
          </div>
          <div className="pws-filter-wrap" ref={filterWrapRef}>
            <button
              type="button"
              className={`pws-filter-btn${filterActive || filterOpen ? " pws-filter-btn--active" : ""}`}
              onClick={() => setFilterOpen(open => !open)}
              aria-label={t("pws.filterAria")}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
            >
              <IconFilter width={18} height={18} aria-hidden="true" />
              {filterActive && <span className="pws-filter-dot" aria-hidden="true" />}
            </button>
            {filterOpen && (
              <div className="pws-filter-menu" role="menu" aria-label={t("pws.providerFiltersAria")}>
                <div className="pws-filter-title">{t("pws.filters")}</div>
                <div className="pws-filter-head">{t("pws.filterStatus")}</div>
                {statusFilterOptions.map(({ key, label, count }) => (
                  <label key={key} className="pws-filter-option" role="menuitemcheckbox" aria-checked={statusFilter[key]}>
                    <input
                      type="checkbox"
                      checked={statusFilter[key]}
                      onChange={() => setStatusFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                    />
                    <span className="pws-filter-label">{label}</span>
                    <span className="pws-filter-count">{count}</span>
                  </label>
                ))}
                <div className="pws-filter-head">{t("pws.pricing")}</div>
                <label className="pws-filter-option" role="menuitemcheckbox" aria-checked={pricingFilter.free}>
                  <input type="checkbox" checked={pricingFilter.free} onChange={() => setPricingFilter(prev => ({ ...prev, free: !prev.free }))} />
                  <span className="pws-filter-label">{t("modal.badge.free")}</span>
                  <span className="pws-filter-count">{freeCount}</span>
                </label>
                <label className="pws-filter-option" role="menuitemcheckbox" aria-checked={pricingFilter.paid}>
                  <input type="checkbox" checked={pricingFilter.paid} onChange={() => setPricingFilter(prev => ({ ...prev, paid: !prev.paid }))} />
                  <span className="pws-filter-label">{t("pws.paid")}</span>
                  <span className="pws-filter-count">{paidCount}</span>
                </label>
                <div className="pws-filter-head">{t("pws.filterType")}</div>
                {([
                  { key: "cloud" as const, label: t("pws.type.cloud"), count: typeCounts.cloud },
                  { key: "local" as const, label: t("pws.type.local"), count: typeCounts.local },
                  { key: "selfHosted" as const, label: t("pws.type.selfHosted"), count: typeCounts.selfHosted },
                  { key: "login" as const, label: t("pws.type.login"), count: typeCounts.login },
                ]).map(({ key, label, count }) => (
                  <label key={key} className="pws-filter-option" role="menuitemcheckbox" aria-checked={typeFilter[key]}>
                    <input
                      type="checkbox"
                      checked={typeFilter[key]}
                      onChange={() => setTypeFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                    />
                    <span className="pws-filter-label">{label}</span>
                    <span className="pws-filter-count">{count}</span>
                  </label>
                ))}
                <div className="pws-filter-head">{t("pws.sort")}</div>
                <div className="pws-sort-grid" role="group" aria-label={t("pws.sortProvidersAria")}>
                  {SORT_DEFS.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`pws-sort-btn${sortMode === opt.id ? " pws-sort-btn--active" : ""}`}
                      onClick={() => setSortMode(opt.id)}
                      aria-pressed={sortMode === opt.id}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
                <div className="pws-filter-footer">
                  <button type="button" className="link-btn" onClick={resetFilters} disabled={!filterActive}>
                    {t("pws.resetAll")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div
          className="pws-rail-list"
          role="listbox"
          aria-label={t("pws.providersAria")}
          onKeyDown={e => {
            const options = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
            if (options.length === 0) return;
            const active = document.activeElement as HTMLElement | null;
            const idx = options.findIndex(el => el === active || el.contains(active));
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              const next = idx < 0 ? (delta > 0 ? 0 : options.length - 1) : (idx + delta + options.length) % options.length;
              options[next]?.focus();
              return;
            }
            if (e.key === "Home") { e.preventDefault(); options[0]?.focus(); return; }
            if (e.key === "End") { e.preventDefault(); options[options.length - 1]?.focus(); }
          }}
        >
          {Object.values(filteredSections).every(items => items.length === 0) && (
            <span className="muted pws-rail-empty" role="status">
              {search ? t("pws.noSearchResults") : filterActive ? t("pws.noMatchFilters") : t("pws.noProvidersConfigured")}
            </span>
          )}
          {railGroups.map(({ id, label, count, ariaLabel, items }) => {
            if (items.length === 0) return null;
            return (
              <div key={id} className="pws-rail-group" role="group" aria-label={ariaLabel}>
                <div className="pws-rail-group-head" aria-hidden="true">
                  <span className="pws-rail-group-label">{label}</span>
                  <span className="pws-rail-group-count">{count}</span>
                </div>
                {items.map(item => (
                  <RailRow
                    key={item.name}
                    item={item}
                    selected={selectedName === item.name}
                    tabbable={railTabbableName === item.name}
                    modelCount={modelCounts[item.name]}
                    isDefault={defaultProvider === item.name}
                    showConfigId={duplicateDisplayNames.has(formatProviderDisplayName(item.name))}
                    onClick={() => onSelect(item.name)}
                    onFocus={() => setRailFocusName(item.name)}
                  />
                ))}
              </div>
            );
          })}
        </div>
        </aside>
        <main className="pws-main" aria-label={t("pws.workspaceMainAria")}>
        {selectedItem ? (
          detail?.(selectedItem, {
            usageTotals: usageTotals[selectedItem.name],
            quotaReport: quotaReports[selectedItem.name],
            availableModels: availableModels[selectedItem.name] ?? [],
            selectedModels: selectedModels[selectedItem.name] ?? [],
            modelsLoading,
            modelsLoadFailed,
          }) ?? (
            <div className="pws-detail-placeholder">
              <h3>{formatProviderDisplayName(selectedItem.name)}</h3>
              <p className="muted">{t("pws.detailComingSoon")}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(null)}>
                {t("modal.back")}
              </button>
            </div>
          )
        ) : allItems.length > 0 ? (
          <ProviderOverviewDashboard
            sections={sections}
            quotaReports={quotaReports}
            usageTotals={usageTotals}
            onSelectProvider={(name) => onSelect(name)}
          />
        ) : null}
        </main>
      </div>
    </div>
  );
}

function WorkspaceEmptyState({ onAddProvider }: { onAddProvider: (intent?: AddProviderIntent) => void }) {
  const t = useT();
  return (
    <div className="pws-empty-root">
      <div className="pws-empty-hero">
        <div aria-hidden="true"><IconBoxes style={{ width: 64, height: 64 }} /></div>
        <h2>{t("pws.connectFirst")}</h2>
        <div className="pws-empty-tiles">
          <button type="button" className="pws-empty-tile" onClick={() => onAddProvider({ tier: "free" })}>
            <span aria-hidden="true"><IconGlobe width={18} height={18} /></span>
            <span className="pws-empty-tile-label">{t("pws.empty.browseFree")}</span>
            <span className="pws-empty-tile-desc muted">{t("pws.empty.browseFreeDesc")}</span>
          </button>
          <button type="button" className="pws-empty-tile" onClick={() => onAddProvider({ tier: "accounts" })}>
            <span aria-hidden="true"><IconLock width={18} height={18} /></span>
            <span className="pws-empty-tile-label">{t("pws.empty.connectAccount")}</span>
            <span className="pws-empty-tile-desc muted">{t("pws.empty.connectAccountDesc")}</span>
          </button>
          <button type="button" className="pws-empty-tile" onClick={() => onAddProvider({ custom: true })}>
            <span aria-hidden="true"><IconKey width={18} height={18} /></span>
            <span className="pws-empty-tile-label">{t("pws.empty.addEndpoint")}</span>
            <span className="pws-empty-tile-desc muted">{t("pws.empty.addEndpointDesc")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
