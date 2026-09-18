/**
 * ProviderCatalog — the browse surface of the add-provider modal: Accounts /
 * Free / Local / Paid tabs over a single searchable scroll list, and account
 * login rows on the Accounts tab. Presentational: presets/usage arrive via props;
 * view state (tab, query) lives here; selection lifts up.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  bucketPresets,
  pinSponsors,
  noteNeedsReveal,
  matchesCatalogQuery,
  sortCatalogMatches,
  filterAccountRows,
  dropPresetsCoveredByAccounts,
  type CatalogPreset,
  type CatalogTier,
} from "./provider-presets";
import { type CatalogLoginHint } from "./login-hint-visibility";
import CatalogAccountRow from "./CatalogAccountRow";
import type { AccountLoginRow, AccountLoginStatus } from "./account-row-types";
import { ProviderIcon } from "../provider-workspace/ProviderRail";

export type { AccountLoginRow, AccountLoginStatus };

export type { CatalogTier };

/** Tab order. Local sits between Free and Paid: logged in, free cloud, my machine, billed. */
const TIER_TABS = ["accounts", "free", "local", "paid"] as const;

const TIER_TAB_LABEL = {
  accounts: "modal.tab.accounts",
  free: "modal.tab.free",
  local: "modal.tab.local",
  paid: "modal.tab.paid",
} as const;

const EMPTY_USAGE_RANK: Record<string, number> = {};
const EMPTY_ACCOUNT_ROWS: AccountLoginRow[] = [];
const EMPTY_ACCOUNT_STATUS: Record<string, AccountLoginStatus> = {};

export default function ProviderCatalog({
  presets,
  usageRank = EMPTY_USAGE_RANK,
  presetsLoading = false,
  initialTier = "free",
  query,
  onQueryChange,
  onSelectPreset,
  onSelectCustom,
  onShowNote,
  accountRows = EMPTY_ACCOUNT_ROWS,
  accountStatus = EMPTY_ACCOUNT_STATUS,
  busyProvider = null,
  loginHint = null,
  paste,
  onLogin,
  onCancelLogin,
  onLogout,
  onManage,
}: {
  presets: CatalogPreset[];
  usageRank?: Record<string, number>;
  presetsLoading?: boolean;
  initialTier?: CatalogTier;
  /**
   * The unified search text, owned by the modal. It lives up there because the
   * add-provider modal's Escape handler is on `window` and registers before this
   * component's would: Escape has to clear a non-empty query instead of closing the
   * dialog, and a child listener never gets the chance.
   */
  query: string;
  onQueryChange: (value: string) => void;
  onSelectPreset: (preset: CatalogPreset) => void;
  onSelectCustom: () => void;
  /** Open the full-note popup for a row whose note is clamped. Owned by the modal. */
  onShowNote?: (preset: CatalogPreset) => void;
  /** Accounts-tab login rows; empty (default) degrades to preset-only rendering. */
  accountRows?: AccountLoginRow[];
  accountStatus?: Record<string, AccountLoginStatus>;
  busyProvider?: string | null;
  /** Authorization URL / device code for the account-row login in flight. */
  loginHint?: CatalogLoginHint | null;
  /** Paste-a-redirect-or-code state, owned by the modal so the catalog stays presentational. */
  paste?: {
    value: string;
    busy: boolean;
    message: string;
    ok: boolean;
    onChange: (value: string) => void;
    onSubmit: (provider: string) => void;
  };
  onLogin?: (provider: string, addAccount?: boolean) => void;
  onCancelLogin?: (provider: string) => void;
  onLogout?: (provider: string) => void;
  /** Jump to the provider's Accounts surface in the workspace. */
  onManage?: (provider: string) => void;
}) {
  const t = useT();
  const [tier, setTier] = useState<CatalogTier>(initialTier);
  const rowsId = useId();
  const groupId = (candidate: CatalogTier) => `${rowsId}-${candidate}`;
  const rowsRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  /**
   * Entering or leaving search mode, and switching tabs, replaces the dataset entirely.
   * Restoring an old scroll offset onto a different list lands somewhere meaningless, so
   * the list goes back to the top instead.
   */
  useEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
  }, [tier, searching]);

  const catalog = useMemo(() => presets.filter(p => p.id !== "custom"), [presets]);

  /** Usage-ranked order only after usage arrives; until then keep stable label order
   * so a slow /api/usage (~5s cold) cannot flash a catalog resort. */
  const ranked = useMemo(() => {
    const hasUsage = Object.keys(usageRank).length > 0;
    return catalog.toSorted((a, b) => {
      if (hasUsage) {
        const ra = usageRank[a.id] ?? 0;
        const rb = usageRank[b.id] ?? 0;
        if (rb !== ra) return rb - ra;
      }
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
    });
  }, [catalog, usageRank]);

  const buckets = useMemo(() => bucketPresets(pinSponsors(ranked)), [ranked]);
  const tierList = buckets[tier];

  /**
   * Search mode replaces browse mode rather than filtering inside it. While a query is
   * live the selected tab is frozen and every group is rendered, because a jump from
   * Free to Accounts would not merely change which rows are listed - it changes the kind
   * of row, from a preset-select button to a login row with Log in and Add account
   * buttons. Clearing the query returns to the tab the user actually chose.
   */
  const accountMatches = useMemo(
    () => (searching ? filterAccountRows(accountRows, query, busyProvider) : accountRows),
    [accountRows, query, searching, busyProvider],
  );

  const presetGroups = useMemo(() => {
    const presetTabs = TIER_TABS.filter(candidate => candidate !== "accounts");
    if (!searching) {
      return tier === "accounts" ? [] : [{ tier, rows: tierList }];
    }
    return presetTabs.map(candidate => ({
      tier: candidate,
      rows: sortCatalogMatches(
        dropPresetsCoveredByAccounts(
          buckets[candidate].filter(p => matchesCatalogQuery(p, query)),
          accountMatches,
        ),
        query,
      ),
    }));
  }, [searching, tier, tierList, buckets, query, accountMatches]);

  const counts = useMemo(() => {
    const byTier = Object.fromEntries(presetGroups.map(group => [group.tier, group.rows.length])) as Record<CatalogTier, number>;
    return { ...byTier, accounts: accountMatches.length } as Record<CatalogTier, number>;
  }, [presetGroups, accountMatches]);

  const totalMatches = TIER_TABS.reduce((sum, candidate) => sum + (counts[candidate] ?? 0), 0);
  const matchedTiers = TIER_TABS.filter(candidate => (counts[candidate] ?? 0) > 0);

  /**
   * What is actually on screen right now. In browse mode that is one tab, and it is NOT
   * `totalMatches`: the accounts bucket is unfiltered while browsing, and an OpenAI login
   * row is almost always present, so keying the loading and empty states off the total
   * left a still-loading Free tab rendering a blank pane instead of saying it was loading.
   */
  const visibleCount = searching
    ? totalMatches
    : tier === "accounts" ? accountMatches.length : (presetGroups[0]?.rows.length ?? 0);

  /**
   * A chip scrolls its group into view; it does not change `tier`. Focus moves to the
   * heading so a keyboard user lands where they aimed - unless a login is in flight,
   * because that row owns the paste field the user may be typing into.
   */
  const jumpToGroup = (candidate: CatalogTier) => {
    const container = rowsRef.current;
    // Looked up by data attribute rather than by id: the id comes from `useId`, which
    // emits colons, so selecting on it needs `CSS.escape` — and `CSS` does not exist in
    // the happy-dom environment the GUI tests run in, so a chip click would throw there
    // rather than merely be untested. The tier values are plain lowercase words.
    const heading = container?.querySelector<HTMLElement>(`[data-catalog-group="${candidate}"]`);
    if (!container || !heading) return;
    // Scroll the list itself rather than calling scrollIntoView: `.modal-card` is also a
    // scroll container, so delegating to the browser can drag the search field out of
    // view while jumping between groups inside a 360px list.
    container.scrollTop = heading.offsetTop - container.offsetTop;
    // `preventScroll` for the same reason the scroll is manual: the default would let the
    // focus move drag the translucent modal card that the list sits inside.
    if (!busyProvider) heading.focus({ preventScroll: true });
  };

  /** ArrowDown out of the input lands on the first result, never on a chip. */
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown") return;
    const first = rowsRef.current?.querySelector<HTMLElement>("button:not(:disabled), a[href]");
    if (!first) return;
    e.preventDefault();
    first.focus();
  };

  const groupHeading = (candidate: CatalogTier, count: number) => (
    <h4
      id={groupId(candidate)}
      data-catalog-group={candidate}
      className="provider-catalog-group-head"
      tabIndex={-1}
    >
      <span>{t(TIER_TAB_LABEL[candidate])}</span>
      <span className="provider-catalog-group-count">{count}</span>
    </h4>
  );

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
    const sponsor = p.sponsor
      ? <span className="badge badge-accent provider-catalog-sponsor" title={p.sponsorUrl}>{t("modal.badge.sponsor")}</span>
      : null;
    return <>{sponsor}{free}{auth}</>;
  };

  return (
    <div className="provider-catalog">
      {/* Search first, then the filters it overrides. It reaches every tab, so putting it
          under one tab's header would say the opposite of what it does. */}
      <input
        className="input provider-catalog-search"
        type="search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onKeyDown={onSearchKeyDown}
        placeholder={t("modal.search")}
        aria-label={t("modal.search")}
      />

      {searching ? (
        // Not a tablist any more: the panel below is showing every group, so a `tab` with
        // `aria-selected` would announce "Free, selected" over a Paid row. These are jump
        // chips with counts, and a chip with no matches is disabled rather than hidden so
        // the strip does not reflow under the pointer on every keystroke.
        <div className="provider-catalog-tabs provider-catalog-tabs--chips">
          {TIER_TABS.map(candidate => (
            <button type="button"
              key={candidate}
              className="provider-catalog-tab provider-catalog-chip"
              disabled={(counts[candidate] ?? 0) === 0}
              // An empty group renders nothing, so pointing at its id would dangle.
              {...((counts[candidate] ?? 0) > 0 ? { "aria-controls": groupId(candidate) } : {})}
              onClick={() => jumpToGroup(candidate)}
            >
              {t(TIER_TAB_LABEL[candidate])}
              <span className="provider-catalog-chip-count">{counts[candidate] ?? 0}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="provider-catalog-tabs" role="tablist">
          {TIER_TABS.map(candidate => (
            <button type="button"
              key={candidate}
              role="tab"
              aria-selected={tier === candidate}
              aria-controls={rowsId}
              className={`provider-catalog-tab${tier === candidate ? " active" : ""}`}
              onClick={() => setTier(candidate)}
            >
              {t(TIER_TAB_LABEL[candidate])}
            </button>
          ))}
        </div>
      )}

      {!searching && tier === "accounts" && (
        <div className="provider-catalog-accounts-hint muted text-label">
          {t("modal.accountsHint")}
        </div>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {searching
          ? (totalMatches === 0
            ? t("modal.noMatch")
            : t("modal.searchResults", {
              count: totalMatches,
              tiers: matchedTiers.map(candidate => t(TIER_TAB_LABEL[candidate])).join(", "),
            }))
          : ""}
      </div>

      <div className="provider-catalog-rows" id={rowsId} ref={rowsRef}>
        {presetsLoading && visibleCount === 0 && (
          <div className="muted text-control provider-catalog-empty">{t("modal.catalogLoading")}</div>
        )}
        {(searching || tier === "accounts") && accountMatches.length > 0 && (
          <Fragment key="accounts">
            {searching && groupHeading("accounts", accountMatches.length)}
            {accountMatches.map(row => (
              <CatalogAccountRow
                key={row.id}
                row={row}
                status={accountStatus[row.id]}
                busyProvider={busyProvider}
                loginHint={loginHint}
                {...(paste ? { paste } : {})}
                {...(onLogin ? { onLogin } : {})}
                {...(onCancelLogin ? { onCancelLogin } : {})}
                {...(onLogout ? { onLogout } : {})}
                {...(onManage ? { onManage } : {})}
              />
            ))}
          </Fragment>
        )}
        {presetGroups.map(group => group.rows.length === 0 ? null : (
          <Fragment key={group.tier}>
          {searching && groupHeading(group.tier, group.rows.length)}
          {group.rows.map(p => (
          // The reveal control is a SIBLING of the row button, never a child of it: the row
          // is already a <button>, and a button inside a button is invalid HTML that the
          // parser may hoist out of the row -- at which point `stopPropagation` never runs.
          <div key={p.id} className="provider-catalog-row-wrap">
            <button type="button" className="list-row" onClick={() => onSelectPreset(p)}>
              {/*
                The one list a user reads to CHOOSE a provider, and until now the only
                provider surface with no marks at all. `CatalogPreset.id` is the
                registry id, so this reuses `providerIconSrc` and, with it, the
                mask/plate decision the rail already owns -- a mark cannot be legible
                in the workspace and invisible here.
              */}
              <ProviderIcon name={p.id} adapter={p.adapter} cls="provider-icon provider-icon-sm" />
              <div>
                <div className="title">{p.label}</div>
                <div className="sub"><code className="chip">{p.adapter}</code>{p.note ? ` · ${p.note}` : ""}</div>
              </div>
              <div className="provider-catalog-badges">{badges(p)}</div>
            </button>
            {onShowNote && noteNeedsReveal(p.note) && (
              <button
                type="button"
                className="link-btn provider-catalog-note-more"
                onClick={() => onShowNote(p)}
              >
                {t("modal.noteMore")}
              </button>
            )}
          </div>
        ))}
          </Fragment>
        ))}
        {!presetsLoading && visibleCount === 0 && (
          <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
        )}
      </div>

      <div className="provider-catalog-footer">
        <div style={{ flex: 1 }} />
        {/* Browse copy. "Not listed?" is the escape hatch at the end of a list you read,
            not a search result, so it stays out of the way while a query is live. */}
        {!searching && tier !== "accounts" && (
          <button type="button" className="link-btn" onClick={onSelectCustom}>{t("modal.notListed")}</button>
        )}
      </div>
    </div>
  );
}
