/**
 * ProviderCatalog — the browse surface of the add-provider modal: Accounts /
 * Free / Paid tabs, home (top rows) and browse (search) views, and account
 * login rows on the Accounts tab. Presentational: presets/usage arrive via
 * props; view state (tab, query, view) lives here; selection lifts up.
 */
import { useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import {
  bucketPresets,
  filterPresets,
  type CatalogPreset,
} from "./provider-presets";

/** How many rows the home view shows per tab before "browse all". */
const HOME_SLOT_COUNT = 6;

export type AccountLoginStatus = { loggedIn: boolean; email?: string; error?: string };
export type AccountLoginRow = {
  id: string;
  label: string;
  kind: "oauth" | "key";
  statusLabel?: string;
};

export type CatalogTier = "accounts" | "free" | "paid";

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
}: {
  presets: CatalogPreset[];
  usageRank?: Record<string, number>;
  presetsLoading?: boolean;
  initialTier?: CatalogTier;
  onSelectPreset: (preset: CatalogPreset) => void;
  onSelectCustom: () => void;
  /** Accounts-tab login rows; empty (default) degrades to preset-only rendering. */
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  busyProvider?: string | null;
  onLogin?: (provider: string) => void;
  onCancelLogin?: (provider: string) => void;
  onLogout?: (provider: string) => void;
}) {
  const t = useT();
  const [tier, setTier] = useState<CatalogTier>(initialTier);
  const [view, setView] = useState<"home" | "browse">("home");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const catalog = useMemo(() => presets.filter(p => p.id !== "custom"), [presets]);

  /** Usage-ranked order: requests desc, then label (050a sortPresets is the no-usage fallback). */
  const ranked = useMemo(() => [...catalog].sort((a, b) => {
    const ra = usageRank[a.id] ?? 0;
    const rb = usageRank[b.id] ?? 0;
    if (rb !== ra) return rb - ra;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  }), [catalog, usageRank]);

  const buckets = useMemo(() => bucketPresets(ranked), [ranked]);
  const tierList = buckets[tier];
  const homeList = tierList.slice(0, HOME_SLOT_COUNT);
  const browseList = useMemo(() => filterPresets(tierList, query), [tierList, query]);
  const rows = view === "browse" ? browseList : homeList;

  const openBrowse = () => {
    setView("browse");
    setQuery("");
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  const badges = (p: CatalogPreset) => {
    const auth = p.codexAccountMode === "direct" ? <span className="badge badge-green">{t("modal.badge.direct")}</span>
      : p.codexAccountMode === "pool" ? <span className="badge badge-accent">{t("modal.badge.pool")}</span>
      : p.auth === "oauth" ? <span className="badge badge-accent">{t("modal.badge.oauth")}</span>
      : p.auth === "forward" ? <span className="badge badge-green">{t("modal.badge.codexLogin")}</span>
      : p.auth === "local" ? <span className="badge badge-amber">{t("modal.badge.local")}</span>
      : p.keyOptional ? null // keyless free: the Free badge alone says it all
      : <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>;
    // Free pricing is orthogonal to auth: NVIDIA (freeTier + key required) shows BOTH
    // the Free badge and the API-key badge — free pricing never hides a key requirement.
    const free = (p.freeTier || p.keyOptional) && p.auth === "key"
      ? <span className="badge badge-green">{t("modal.badge.free")}</span>
      : null;
    return <>{free}{auth}</>;
  };

  return (
    <div className="provider-catalog">
      <div className="provider-catalog-tabs" role="tablist">
        {(["accounts", "free", "paid"] as const).map(candidate => (
          <button
            key={candidate}
            role="tab"
            aria-selected={tier === candidate}
            className={`provider-catalog-tab${tier === candidate ? " active" : ""}`}
            onClick={() => { setTier(candidate); setView("home"); setQuery(""); }}
          >
            {t(candidate === "accounts" ? "modal.tab.accounts" : candidate === "free" ? "modal.tab.free" : "modal.tab.paid")}
          </button>
        ))}
      </div>

      {tier === "accounts" && (
        <div className="provider-catalog-accounts-hint muted text-label">
          {t("modal.accountsHint")}{" "}
          <a href="#codex-auth">{t("modal.accountsCodexAuthLink")}</a>
        </div>
      )}

      {view === "browse" && (
        <input
          ref={searchRef}
          className="input provider-catalog-search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("modal.search")}
        />
      )}

      <div className="provider-catalog-rows">
        {presetsLoading && rows.length === 0 && (
          <div className="muted text-control provider-catalog-empty">{t("modal.catalogLoading")}</div>
        )}
        {rows.map(p => (
          <button key={p.id} className="list-row" onClick={() => onSelectPreset(p)}>
            <div>
              <div className="title">{p.label}</div>
              <div className="sub"><code className="chip">{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}</div>
            </div>
            <div className="provider-catalog-badges">{badges(p)}</div>
          </button>
        ))}
        {!presetsLoading && rows.length === 0 && (
          <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
        )}

        {tier === "accounts" && accountRows.map(row => {
          const status = accountStatus[row.id];
          const busy = busyProvider === row.id;
          return (
            <div key={row.id} className="list-row provider-catalog-account-row">
              <div>
                <div className="title">{row.label}</div>
                <div className="sub">
                  {status?.loggedIn
                    ? (status.email ?? row.statusLabel ?? t("modal.accountLoggedIn"))
                    : (status?.error ?? row.statusLabel ?? t("modal.accountLoggedOut"))}
                </div>
              </div>
              <div className="provider-catalog-badges">
                {status?.loggedIn ? (
                  onLogout && <button className="btn btn-ghost" onClick={() => onLogout(row.id)}>{t("modal.accountLogout")}</button>
                ) : busy ? (
                  onCancelLogin && <button className="btn btn-ghost" onClick={() => onCancelLogin(row.id)}>{t("common.cancel")}</button>
                ) : (
                  onLogin && <button className="btn btn-primary" onClick={() => onLogin(row.id)}>{t("modal.accountLogin")}</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="provider-catalog-footer">
        {view === "home" && tierList.length > HOME_SLOT_COUNT && (
          <button className="link-btn" onClick={openBrowse}>{t("modal.browseAll", { count: tierList.length })}</button>
        )}
        {view === "browse" && (
          <button className="link-btn" onClick={() => { setView("home"); setQuery(""); }}>{t("modal.browseBack")}</button>
        )}
        <div style={{ flex: 1 }} />
        {tier !== "accounts" && (
          <button className="link-btn" onClick={onSelectCustom}>{t("modal.notListed")}</button>
        )}
      </div>
    </div>
  );
}
