/**
 * ProviderWorkspaceShell — the workspace chrome (WP080b): search, filter
 * popover (status/pricing/type/sort), grouped rail with keyboard navigation,
 * empty state, and a render-prop `detail` slot. Detail/Overview panel bodies
 * arrive in WP090/091; until then the slot renders a real placeholder message.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useKeyedClientResource } from "../../client-resource";
import { usageSummary30dResourceKey } from "../../usage-summary-resource";
import { useT } from "../../i18n/shared";
import { IconFilter, IconSearch, IconBoxes, IconGlobe, IconLock, IconKey, IconTrash } from "../../icons";
import {
  applyActiveAccountReauth,
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
import { readJsonIfOk, readJsonOrThrow } from "../../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../../session-list-cache";
import { countAvailableModels, parseAvailableModels, parseLiveModelCounts, parseSelectedModels, type ProviderAvailableModels, type ProviderLiveModelCounts, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import { formatProviderDisplayName } from "../../provider-icons";
import { RailRow } from "./ProviderRail";
import type { PricingFilter, ProviderModelUsageRow, ProviderUsageTotals, StatusFilter, TypeFilter } from "./types";
import ProviderOverviewDashboard from "./ProviderOverviewDashboard";
import ProviderJsonEditor, { type JsonEditorState } from "./ProviderJsonEditor";

export type AddProviderIntent = { tier?: "accounts" | "free" | "paid"; custom?: boolean };

/** Detail-slot data plumbed per selected provider (props-down; no shared hook). */
export interface DetailSlotData {
  usageTotals?: import("./types").ProviderUsageTotals;
  modelUsage?: ProviderModelUsageRow[];
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  /** Did the last successful discovery return rows? Server-reported, never inferred. */
  hasLiveModels: boolean;
  selectedModels: string[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  onRetryModels?: () => void;
}

const SORT_DEFS: { id: ProviderSortMode; labelKey: "pws.sort.az" | "pws.sort.za" | "pws.sort.freePaid" | "pws.sort.paidFree" | "pws.sort.accountsFirst" }[] = [
  { id: "az", labelKey: "pws.sort.az" },
  { id: "za", labelKey: "pws.sort.za" },
  { id: "free-paid", labelKey: "pws.sort.freePaid" },
  { id: "paid-free", labelKey: "pws.sort.paidFree" },
  { id: "accounts-first", labelKey: "pws.sort.accountsFirst" },
];

const QUOTA_REPORT_MAX_AGE_MS = 30 * 60_000;

function freshQuotaReport(value: unknown, now: number): ProviderQuotaReportView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return null;
  if (now - row.updatedAt >= QUOTA_REPORT_MAX_AGE_MS) return null;
  if (!("quota" in row)) return null;
  if (row.label !== undefined && typeof row.label !== "string") return null;
  if (row.source !== undefined && typeof row.source !== "string") return null;
  return {
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    ...(typeof row.source === "string" ? { source: row.source } : {}),
    updatedAt: row.updatedAt,
    quota: row.quota,
    ...(row.aggregation !== undefined ? { aggregation: row.aggregation } : {}),
  };
}

function freshQuotaReportRecord(value: unknown, now = Date.now()): Record<string, ProviderQuotaReportView> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, ProviderQuotaReportView> = {};
  for (const [provider, raw] of Object.entries(value)) {
    const report = freshQuotaReport(raw, now);
    if (provider.trim() && report) out[provider] = report;
  }
  return out;
}

function readFreshQuotaReportCache(key: string): Record<string, ProviderQuotaReportView> | null {
  return freshQuotaReportRecord(readSessionListCache<unknown>(key));
}

function freshQuotaReportsFromResponse(value: unknown, now = Date.now()): Record<string, ProviderQuotaReportView> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, ProviderQuotaReportView> = {};
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const provider = (raw as Record<string, unknown>).provider;
    const report = freshQuotaReport(raw, now);
    if (typeof provider === "string" && provider.trim() && report) out[provider] = report;
  }
  return out;
}

export default function ProviderWorkspaceShell({
  providers,
  apiBase,
  defaultProvider,
  selectedName,
  onSelect,
  onRemoveProvider,
  onAddProvider,
  onEditConfig,
  jsonEditor,
  jsonSaving = false,
  modelsRefreshToken = 0,
  activeAccountNeedsReauth,
  /** Stable key of active OAuth account ids — refetch overview quotas after account switch. */
  quotaRefreshEpoch = 0,
  quotaForceRefresh = false,
  detail,
}: {
  providers: Record<string, WorkspaceProvider>;
  apiBase: string;
  defaultProvider: string;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  /** WP4: mouse accelerator for deleting a provider straight from the rail. */
  onRemoveProvider?: (name: string) => void;
  onAddProvider: (intent?: AddProviderIntent) => void;
  onEditConfig?: () => void;
  jsonEditor?: JsonEditorState;
  jsonSaving?: boolean;
  /** Bump after login/config changes so /api/selected-models is refetched. */
  modelsRefreshToken?: number;
  activeAccountNeedsReauth?: Record<string, boolean>;
  /**
   * Monotonic quota revision. It moves only when something actually invalidates the quota
   * view — an account switch, a login or logout, a key change, a config save — so account
   * data arriving on a cold load no longer re-triggers the read once per provider.
   */
  quotaRefreshEpoch?: number;
  /** True when the bump came from a mutation that needs the server to bypass its TTL. */
  quotaForceRefresh?: boolean;
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
  const [liveModelCounts, setLiveModelCounts] = useState<ProviderLiveModelCounts>({});
  const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const quotasCacheKey = `ocx.providers.quotas.v1:${apiBase}`;
  const usageCacheKey = `ocx.providers.usage.v1:${apiBase}`;
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>(() => (
    readSessionListCache<{ totals: Record<string, ProviderUsageTotals> }>(usageCacheKey)?.totals ?? {}
  ));
  const [usageModels, setUsageModels] = useState<Record<string, ProviderModelUsageRow[]>>(() => (
    readSessionListCache<{ models: Record<string, ProviderModelUsageRow[]> }>(usageCacheKey)?.models ?? {}
  ));
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReportView>>(() => (
    readFreshQuotaReportCache(quotasCacheKey) ?? {}
  ));
  const [usageLoading, setUsageLoading] = useState(() => !readSessionListCache(usageCacheKey));
  const [quotasLoading, setQuotasLoading] = useState(() => {
    const cached = readFreshQuotaReportCache(quotasCacheKey);
    return !cached || Object.keys(cached).length === 0;
  });
  const [modelsLoadEpoch, setModelsLoadEpoch] = useState(0);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  // Shared usage-summary key: all four subscribers raise the deadline together (30d usage is ~5s cold).
  const usageResource = useKeyedClientResource(usageSummary30dResourceKey(apiBase), [apiBase], async (signal) => { const res = await fetch(apiBase + "/api/usage?range=30d", { signal }); if (!res.ok) throw new Error(String(res.status)); return await res.json(); }, { deadlineMs: 60_000 });

  const sections = useMemo(() => {
    const base = buildProviderWorkspace(hideRedundantChatGptForwardProviders(providers));
    return applyActiveAccountReauth(base, activeAccountNeedsReauth ?? {});
  }, [providers, activeAccountNeedsReauth]);

  const retryModels = useCallback(() => {
    setModelsLoadEpoch(epoch => epoch + 1);
  }, []);

  useEffect(() => {
    // Deferred load (matches Models/Usage/ClaudeCode): avoids synchronous setState
    // inside the effect, per the react-hooks/set-state-in-effect lint gate.
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setModelsLoading(true);
      void (async () => {
        try {
          const res = await fetch(`${apiBase}/api/selected-models`);
          const data = await readJsonOrThrow(res);
          if (cancelled) return;
          setModelCounts(countAvailableModels(data));
          setAvailableModels(parseAvailableModels(data));
          setLiveModelCounts(parseLiveModelCounts(data));
          setSelectedModels(parseSelectedModels(data));
          setModelsLoadFailed(false);
        } catch {
          if (cancelled) return;
          setModelsLoadFailed(true);
        } finally {
          if (!cancelled) setModelsLoading(false);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [apiBase, modelsRefreshToken, modelsLoadEpoch]);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const data = usageResource.data as { providers?: Array<{ provider: string; requests: number; totalTokens?: number }>; models?: Array<{ provider: string; model: string; resolvedModel?: string; requests: number; totalTokens: number; inputTokens: number; outputTokens: number; shareRatio: number; estimatedCostUsd?: number }> } | undefined;
      if (cancelled) return;
      if (!data) {
        if (usageResource.loading) setUsageLoading(!readSessionListCache(usageCacheKey));
        return;
      }
      const byProvider: Record<string, ProviderUsageTotals> = {};
      for (const row of data.providers ?? []) byProvider[row.provider] = { requests: row.requests, totalTokens: row.totalTokens };
      setUsageTotals(byProvider);
      const byProviderModels: Record<string, ProviderModelUsageRow[]> = {};
      for (const m of data.models ?? []) {
        const key = m.provider;
        if (!byProviderModels[key]) byProviderModels[key] = [];
        byProviderModels[key].push({ model: m.model, ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}), requests: m.requests, totalTokens: m.totalTokens, inputTokens: m.inputTokens, outputTokens: m.outputTokens, shareRatio: m.shareRatio, ...(m.estimatedCostUsd !== undefined ? { estimatedCostUsd: m.estimatedCostUsd } : {}) });
      }
      setUsageModels(byProviderModels);
      writeSessionListCache(usageCacheKey, { totals: byProvider, models: byProviderModels });
      setUsageLoading(false);
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [apiBase, usageCacheKey, usageResource.data, usageResource.loading]);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      const cached = readFreshQuotaReportCache(quotasCacheKey);
      if (!cached || Object.keys(cached).length === 0) setQuotasLoading(true);
      // A forced bump means a mutation just changed the answer, so the server's TTL has to
      // be bypassed. The old derived-key effect always read the cached view, which is why a
      // switch could leave the bars showing the previous account's quota.
      void fetch(`${apiBase}/api/provider-quotas${quotaForceRefresh ? "?refresh=1" : ""}`)
        .then(r => readJsonIfOk<{ reports?: Array<{ provider: string; label?: string; source?: string; updatedAt?: number; quota?: unknown; aggregation?: unknown }> }>(r))
        .then((data) => {
          if (cancelled || !data) return;
          // A successful endpoint response is authoritative, including an empty report list.
          const next = freshQuotaReportsFromResponse(data.reports);
          setQuotaReports(next);
          writeSessionListCache(quotasCacheKey, next);
        })
        .catch(() => {
          if (cancelled) return;
          // Keep last-good only inside the same server freshness bound.
          setQuotaReports(prev => {
            const next = freshQuotaReportRecord(prev) ?? {};
            writeSessionListCache(quotasCacheKey, next);
            return next;
          });
        })
        .finally(() => { if (!cancelled) setQuotasLoading(false); });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
    // Keyed on the explicit revision: account arrival is silent, real mutations re-read.
  }, [apiBase, quotaRefreshEpoch, quotaForceRefresh, quotasCacheKey]);

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
      const label = formatProviderDisplayName(item.name, t);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const dups = new Set<string>();
    for (const [label, n] of counts.entries()) {
      if (n > 1) dups.add(label);
    }
    return dups;
  }, [allItems, t]);

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
              aria-expanded={filterOpen}
              aria-controls="pws-provider-filters"
            >
              <IconFilter width={18} height={18} aria-hidden="true" />
              {filterActive && <span className="pws-filter-dot" aria-hidden="true" />}
            </button>
            {filterOpen && (
              <div id="pws-provider-filters" className="pws-filter-menu" role="group" aria-label={t("pws.providerFiltersAria")}>
                <div className="pws-filter-title">{t("pws.filters")}</div>
                <div className="pws-filter-head">{t("pws.filterStatus")}</div>
                {statusFilterOptions.map(({ key, label, count }) => (
                  <label key={key} className="pws-filter-option">
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
                <label className="pws-filter-option">
                  <input type="checkbox" checked={pricingFilter.free} onChange={() => setPricingFilter(prev => ({ ...prev, free: !prev.free }))} />
                  <span className="pws-filter-label">{t("modal.badge.free")}</span>
                  <span className="pws-filter-count">{freeCount}</span>
                </label>
                <label className="pws-filter-option">
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
                  <label key={key} className="pws-filter-option">
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
                  // The wrapper exists so the delete control can be a SIBLING of the row.
                  // The row is a <button role="option">, so nesting an interactive child
                  // inside it would be invalid HTML, break listbox focus tracking
                  // (el.contains(active) would treat the trash button as the option), and
                  // let one click both select and delete.
                  <div key={item.name} className="pws-rail-row-wrap">
                    <RailRow
                      item={item}
                      selected={selectedName === item.name}
                      tabbable={railTabbableName === item.name}
                      modelCount={modelCounts[item.name]}
                      isDefault={defaultProvider === item.name}
                      showConfigId={duplicateDisplayNames.has(formatProviderDisplayName(item.name, t))}
                      onClick={() => onSelect(item.name)}
                      onFocus={() => setRailFocusName(item.name)}
                    />
                    {onRemoveProvider && (
                      <button
                        type="button"
                        className="pws-rail-row-remove"
                        // Mouse accelerator only. Keyboard and screen-reader users already
                        // have the labelled delete control in the provider detail header,
                        // and adding this to the tab order would disturb option roving.
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={event => {
                          // Defensive only: as a sibling this never reaches the row's
                          // handler, but it keeps the intent explicit if the wrapper ever
                          // gains a click handler of its own.
                          event.stopPropagation();
                          onRemoveProvider(item.name);
                        }}
                        title={t("pws.removeConfirmTitle")}
                      >
                        <IconTrash width={14} height={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        </aside>
        <main className="pws-main" aria-label={t("pws.workspaceMainAria")}>
        {jsonEditor?.open ? (
          <ProviderJsonEditor
            editor={jsonEditor}
            providerName={t("nav.providers")}
            saving={jsonSaving}
            onSave={() => { void jsonEditor.onSave(); }}
          />
        ) : selectedItem ? (
          detail?.(selectedItem, {
            usageTotals: usageTotals[selectedItem.name],
            modelUsage: usageModels[selectedItem.name],
            quotaReport: quotaReports[selectedItem.name],
            availableModels: availableModels[selectedItem.name] ?? [],
            hasLiveModels: (liveModelCounts[selectedItem.name] ?? 0) > 0,
            selectedModels: selectedModels[selectedItem.name] ?? [],
            modelsLoading,
            modelsLoadFailed,
            onRetryModels: retryModels,
          }) ?? (
            <div className="pws-detail-placeholder">
              <h3>{formatProviderDisplayName(selectedItem.name, t)}</h3>
              <p className="muted">{t("pws.detailComingSoon")}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelect(null)}>
                {t("modal.back")}
              </button>
            </div>
          )
        ) : (
          <ProviderOverviewDashboard
            sections={sections}
            quotaReports={quotaReports}
            usageTotals={usageTotals}
            usageLoading={usageLoading}
            quotasLoading={quotasLoading}
            onSelectProvider={(name) => onSelect(name)}
            onEditConfig={onEditConfig}
          />
        )}
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
