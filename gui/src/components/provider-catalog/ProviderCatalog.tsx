/**
 * ProviderCatalog — the browse surface of the add-provider modal: Accounts /
 * Free / Paid tabs over a single searchable scroll list, and account login
 * rows on the Accounts tab. Presentational: presets/usage arrive via props;
 * view state (tab, query) lives here; selection lifts up.
 */
import { useMemo, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  bucketPresets,
  filterPresets,
  type CatalogPreset,
} from "./provider-presets";
import { shouldShowLoginHint, type CatalogLoginHint } from "./login-hint-visibility";
import { LoginHint } from "../login-url-block";
import { ProviderIcon } from "../provider-workspace/ProviderRail";

export type AccountLoginStatus = { loggedIn: boolean; email?: string; error?: string; needsReauth?: boolean };
export type AccountLoginRow = {
  id: string;
  label: string;
  kind: "oauth" | "key" | "codex";
  statusLabel?: string;
  /** Optional deep-link for codex/account-pool management. */
  href?: string;
};

export type CatalogTier = "accounts" | "free" | "paid";

const EMPTY_USAGE_RANK: Record<string, number> = {};
const EMPTY_ACCOUNT_ROWS: AccountLoginRow[] = [];
const EMPTY_ACCOUNT_STATUS: Record<string, AccountLoginStatus> = {};

export default function ProviderCatalog({
  presets,
  usageRank = EMPTY_USAGE_RANK,
  presetsLoading = false,
  initialTier = "free",
  onSelectPreset,
  onSelectCustom,
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
  onSelectPreset: (preset: CatalogPreset) => void;
  onSelectCustom: () => void;
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
  const [query, setQuery] = useState("");

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

  const buckets = useMemo(() => bucketPresets(ranked), [ranked]);
  const tierList = buckets[tier];
  const rows = useMemo(() => filterPresets(tierList, query), [tierList, query]);

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
          <button type="button"
            key={candidate}
            role="tab"
            aria-selected={tier === candidate}
            className={`provider-catalog-tab${tier === candidate ? " active" : ""}`}
            onClick={() => { setTier(candidate); setQuery(""); }}
          >
            {t(candidate === "accounts" ? "modal.tab.accounts" : candidate === "free" ? "modal.tab.free" : "modal.tab.paid")}
          </button>
        ))}
      </div>

      {tier === "accounts" && (
        <div className="provider-catalog-accounts-hint muted text-label">
          {t("modal.accountsHint")}
        </div>
      )}

      <input
        className="input provider-catalog-search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t("modal.search")}
      />

      <div className="provider-catalog-rows">
        {presetsLoading && rows.length === 0 && (
          <div className="muted text-control provider-catalog-empty">{t("modal.catalogLoading")}</div>
        )}
        {tier !== "accounts" && rows.map(p => (
          <button type="button" key={p.id} className="list-row" onClick={() => onSelectPreset(p)}>
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
        ))}
        {tier !== "accounts" && !presetsLoading && rows.length === 0 && (
          <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
        )}

        {tier === "accounts" && accountRows.map(row => {
          const status = accountStatus[row.id];
          const busy = busyProvider === row.id;
          const loggedIn = !!status?.loggedIn;
          const statusText = loggedIn
            ? (status?.email ?? row.statusLabel ?? t("modal.accountLoggedIn"))
            : (status?.error ?? row.statusLabel ?? t("modal.accountLoggedOut"));
          // A first-time add is the one moment the operator has no other way in:
          // the provider has no workspace panel yet, so without this the
          // authorization URL is computed and never drawn.
          const showHint = shouldShowLoginHint(row, busyProvider, loginHint);
          return (
            <div key={row.id} className={`list-row provider-catalog-account-row${showHint ? " provider-catalog-account-row--waiting" : ""}`}>
              <div className="provider-catalog-account-row-head">
              {/* Account rows are providers too. A logo beside Cursor and a bare
                  tile beside Kiro reads as a bug, not as a distinction. */}
              <ProviderIcon name={row.id} cls="provider-icon provider-icon-sm" />
              <div>
                <div className="title">{row.label}</div>
                <div className="sub">{statusText}</div>
              </div>
              <div className="provider-catalog-badges">
                {row.kind === "key" ? null : row.kind === "codex" ? (
                  <>
                    {loggedIn && (
                      <a className="btn btn-ghost" href={row.href ?? "#codex-set"}>{t("modal.accountManage")}</a>
                    )}
                    {onLogin && (
                      <button type="button"
                        className={loggedIn ? "btn btn-ghost" : "btn btn-primary"}
                        disabled={busy}
                        onClick={() => { if (!busy) onLogin(row.id); }}
                      >
                        {busy ? t("codexAuth.enablingOpenai") : loggedIn ? t("modal.accountAdd") : t("modal.accountLogin")}
                      </button>
                    )}
                  </>
                ) : loggedIn ? (
                  <>
                    {onManage && (
                      <button type="button" className="btn btn-ghost" onClick={() => onManage(row.id)}>
                        {t("modal.accountManage")}
                      </button>
                    )}
                    {onLogin && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy}
                        onClick={() => { if (!busy) onLogin(row.id, true); }}
                      >
                        {busy ? t("prov.waitingBrowser") : t("modal.accountAdd")}
                      </button>
                    )}
                    {busy && onCancelLogin && (
                      <button type="button" className="btn btn-ghost" onClick={() => onCancelLogin(row.id)}>
                        {t("common.cancel")}
                      </button>
                    )}
                    {onLogout && !busy && (
                      <button type="button" className="btn btn-ghost" onClick={() => onLogout(row.id)}>
                        {t("modal.accountLogout")}
                      </button>
                    )}
                  </>
                ) : busy ? (
                  onCancelLogin && <button type="button" className="btn btn-ghost" onClick={() => onCancelLogin(row.id)}>{t("common.cancel")}</button>
                ) : (
                  onLogin && <button type="button" className="btn btn-primary" onClick={() => onLogin(row.id)}>{t("modal.accountLogin")}</button>
                )}
              </div>
              </div>
              {showHint && loginHint && (
                <LoginHint
                  hint={{ url: loginHint.url, deviceCode: loginHint.deviceCode, instructions: loginHint.instructions }}
                  {...(paste
                    ? {
                      paste: {
                        value: paste.value,
                        busy: paste.busy,
                        message: paste.message,
                        ok: paste.ok,
                        onChange: paste.onChange,
                        onSubmit: () => paste.onSubmit(row.id),
                      },
                    }
                    : {})}
                />
              )}
            </div>
          );
        })}
        {tier === "accounts" && accountRows.length === 0 && !presetsLoading && (
          <div className="muted text-control provider-catalog-empty">{t("modal.noMatch")}</div>
        )}
      </div>

      <div className="provider-catalog-footer">
        <div style={{ flex: 1 }} />
        {tier !== "accounts" && (
          <button type="button" className="link-btn" onClick={onSelectCustom}>{t("modal.notListed")}</button>
        )}
      </div>
    </div>
  );
}
