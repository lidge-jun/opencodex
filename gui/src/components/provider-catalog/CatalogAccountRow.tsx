/**
 * One Accounts-tab login row. Split out of ProviderCatalog when unified search made the
 * list composition (four groups, headings, jump chips) the interesting part of that file
 * and this row's nine-way button matrix the noise. Behaviour is unchanged.
 */
import { useT } from "../../i18n/shared";
import { LoginHint } from "../login-url-block";
import { ProviderIcon } from "../provider-workspace/ProviderRail";
import { shouldShowLoginHint, type CatalogLoginHint } from "./login-hint-visibility";
import type { AccountLoginRow, AccountLoginStatus } from "./account-row-types";

export default function CatalogAccountRow({
  row,
  status,
  busyProvider,
  loginHint,
  paste,
  onLogin,
  onCancelLogin,
  onLogout,
  onManage,
}: {
  row: AccountLoginRow;
  status?: AccountLoginStatus;
  busyProvider: string | null;
  loginHint: CatalogLoginHint | null;
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
  onManage?: (provider: string) => void;
}) {
  const t = useT();
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
    <div className={`list-row provider-catalog-account-row${showHint ? " provider-catalog-account-row--waiting" : ""}`}>
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
}
