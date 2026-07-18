import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TFn } from "../i18n";
import { IconLock, IconPlus, IconX, IconAlert, IconRefresh, IconTicket } from "../icons";
import { Notice, EmptyState } from "../ui";
import AddCodexAccountModal from "./AddCodexAccountModal";
import type { AccountQuota } from "../codex-quota-utils";
import QuotaBars from "./QuotaBars";
import type { ReactNode } from "react";
import type { CodexAccountModeState } from "../codex-multi-state";

export interface CodexAccountEntry {
  id: string; email: string; plan?: string; isMain: boolean;
  hasCredential: boolean; quota: AccountQuota | null;
  needsReauth?: boolean;
}

/**
 * Global ChatGPT / Codex account pool (main + extras), extracted from the Codex
 * Auth page (WP060). `accountModeState` arrives as a prop (the parent owns the
 * /api/config fetch); `banner` is an optional slot rendered above the main card
 * (the Codex Auth page passes its mode banner); `embedded` (WP090) omits page
 * chrome — currently a no-op stub reserved for the Providers workspace.
 */
export default function CodexAccountPool({ apiBase, accountModeState = null, banner = null, embedded = false }: {
  apiBase: string;
  accountModeState?: CodexAccountModeState | null;
  banner?: ReactNode;
  embedded?: boolean;
}) {
  const t = useT();
  const [accounts, setAccounts] = useState<CodexAccountEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [autoThreshold, setAutoThreshold] = useState(80);
  const [confirm, setConfirm] = useState<CodexAccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState("");
  const [toastError, setToastError] = useState(false);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [resetPopup, setResetPopup] = useState<CodexAccountEntry | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [creditDetails, setCreditDetails] = useState<{ granted_at: string; expires_at: string }[] | null>(null);
  const [creditDetailsLoading, setCreditDetailsLoading] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (refreshQuota = false) => {
    const generation = ++loadGenerationRef.current;
    if (!refreshQuota) setLoadState("loading");
    try {
      const [accountsResponse, activeResponse] = await Promise.all([
        fetch(`${apiBase}/api/codex-auth/accounts${refreshQuota ? "?refresh=1" : ""}`),
        fetch(`${apiBase}/api/codex-auth/active`),
      ]);
      if (!accountsResponse.ok || !activeResponse.ok) throw new Error("account load failed");
      const [accts, active] = await Promise.all([accountsResponse.json(), activeResponse.json()]);
      if (loadGenerationRef.current !== generation) return false;
      setAccounts(accts.accounts ?? []);
      setActiveId(active.activeCodexAccountId ?? null);
      setAutoThreshold(active.autoSwitchThreshold ?? 80);
      setLoadState("ready");
      return true;
    } catch {
      if (loadGenerationRef.current === generation) setLoadState("error");
      return false;
    }
  }, [apiBase]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    const iv = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(iv);
    };
  }, [load]);

  const setActive = async (id: string | null) => {
    if (switchingId) return;
    setSwitchingId(id ?? "__main__");
    try {
      const response = await fetch(`${apiBase}/api/codex-auth/active`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: id }),
      });
      if (!response.ok) throw new Error("account switch failed");
      const result = await response.json().catch(() => ({})) as { activeCodexAccountId?: string | null };
      const selectedId = result.activeCodexAccountId ?? id;
      setActiveId(selectedId);
      setConfirm(null);
      await load();
      const label = selectedId && selectedId !== "__main__"
        ? accounts.find(account => account.id === selectedId)?.email ?? t("pws.accountOrdinal", { count: "1" })
        : t("codexAuth.mainAccount");
      setToast(accountModeState === "direct"
        ? t("codexAuth.poolPreparedToast", { email: label })
        : t("codexAuth.switched", { email: label }));
      setToastError(false);
      setTimeout(() => setToast(""), 5000);
    } catch {
      setToast(t("codexAuth.switchFailed"));
      setToastError(true);
      setTimeout(() => setToast(""), 5000);
    } finally {
      setSwitchingId(null);
    }
  };

  const remove = async (id: string) => {
    const label = accounts.find(account => account.id === id)?.email ?? t("pws.accountOrdinal", { count: "1" });
    if (!window.confirm(t("codexAuth.removeConfirm", { id: label }))) return;
    try {
      const response = await fetch(`${apiBase}/api/codex-auth/accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      await load();
    } catch {
      setToast(t("codexAuth.removeFailed"));
      setToastError(true);
      setTimeout(() => setToast(""), 5000);
    }
  };

  const toggleAuto = async () => {
    const next = autoThreshold > 0 ? 0 : 80;
    await fetch(`${apiBase}/api/codex-auth/auto-switch`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: next }),
    });
    setAutoThreshold(next);
  };

  const refreshQuotas = async () => {
    setRefreshingQuota(true);
    try {
      const ok = await load(true);
      setToast(t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed"));
      setTimeout(() => setToast(""), 5000);
    } finally {
      setRefreshingQuota(false);
    }
  };

  const openResetPopup = async (account: CodexAccountEntry) => {
    setResetPopup(account);
    setResetConfirm(false);
    setCreditDetails(null);
    setCreditDetailsLoading(true);
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits?accountId=${encodeURIComponent(account.id)}`);
      if (resp.ok) {
        const data = (await resp.json()) as { credits?: { granted_at: string; expires_at: string }[] };
        const sorted = (data.credits ?? []).sort((a, b) =>
          new Date(a.granted_at).getTime() - new Date(b.granted_at).getTime()
        );
        setCreditDetails(sorted);
      }
    } catch { /* detail fetch is non-blocking */ }
    finally { setCreditDetailsLoading(false); }
  };

  const handleRedeem = async (accountId: string) => {
    setRedeeming(true);
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      if (!resp.ok) { alert(t("codexAuth.resetError")); return; }
      const result = (await resp.json()) as { code: string };
      if (result.code === "reset" || result.code === "already_redeemed") {
        const prevCredits = resetPopup?.quota?.resetCredits ?? 1;
        setResetPopup(null);
        setResetConfirm(false);
        await load(true);
        setToast(t("codexAuth.resetSuccess", { remaining: String(Math.max(0, prevCredits - 1)) }));
        setTimeout(() => setToast(""), 5000);
      } else if (result.code === "nothing_to_reset") {
        alert(t("codexAuth.resetNothingToReset"));
      } else if (result.code === "no_credit") {
        alert(t("codexAuth.resetNoCredit"));
      } else {
        alert(t("codexAuth.resetError"));
      }
    } catch {
      alert(t("codexAuth.resetError"));
    } finally {
      setRedeeming(false);
    }
  };

  const main = accounts.find(a => a.isMain);
  const pool = accounts.filter(a => !a.isMain);
  const isNext = (id: string) => activeId === id;
  // Main is the active/next account when no pool account is selected (legacy null) or when
  // it is explicitly set to the rotation id "__main__".
  const isMainActive = !activeId || activeId === "__main__";
  const mainSwitchEntry: CodexAccountEntry = {
    id: "__main__",
    email: main?.email ?? "Codex App",
    plan: main?.plan,
    isMain: true,
    hasCredential: true,
    quota: main?.quota ?? null,
  };
  const switchActionLabel = t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext");

  return (
    <div>
      {!embedded && (
        <div className="page-head">
          <h2 className="page-title">{t("nav.codexAuth")}</h2>
          <button className="btn btn-sm btn-ghost" onClick={refreshQuotas} disabled={refreshingQuota}>
            <IconRefresh width={14} /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
          </button>
        </div>
      )}

      {toast && <Notice tone={toastError ? "err" : "ok"}>{toast}</Notice>}

      {loadState === "loading" && accounts.length === 0 && (
        <div className="pwi-auth-state" role="status">{t("pws.accountsLoading")}</div>
      )}
      {loadState === "error" && (
        <div className="pwi-auth-state pwi-auth-state--error" role="alert">
          <span>{t("codexAuth.loadFailed")}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>{t("pws.retryAccounts")}</button>
        </div>
      )}

      {banner}

      <div className={`card ${isMainActive ? "card-active" : ""}`} style={{ marginBottom: 12 }}>
        <div className="card-head">
          <span className="dot dot-green" />
          <strong>{t("codexAuth.mainAccount")}</strong>
          <span className="card-badges">
            {main && <TicketBadge t={t} account={{ ...main, id: "__main__" } as CodexAccountEntry} onClick={() => openResetPopup({ ...main, id: "__main__" } as CodexAccountEntry)} />}
            <span className={`badge ${isMainActive ? "badge-primary" : "badge-muted"}`}>
              {isMainActive
                ? t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")
                : t("codexAuth.current")}
            </span>
          </span>
          {!isMainActive && (
            <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => setConfirm(mainSwitchEntry)}>
              {switchActionLabel}
            </button>
          )}
          <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
        </div>
        <div className="card-sub">{main?.email ?? "Codex App login"}{main?.plan ? ` · ${main.plan}` : ""}</div>
        {main?.quota && <QuotaBars quota={main.quota} plan={main.plan} threshold={autoThreshold} t={t} />}
      </div>

      <div className="section-sep">
        <span className="section-label">{t("codexAuth.accountPool")}</span>
        <div className="sep-line" />
        <button className="btn btn-sm btn-ghost" onClick={() => setShowAdd(true)}>
          <IconPlus width={14} /> {t("codexAuth.add")}
        </button>
      </div>

      {pool.length === 0 && <EmptyState title={t("codexAuth.noPool")} />}

      {pool.map(a => (
        <div key={a.id} className={`card ${isNext(a.id) ? "card-active" : ""}`} style={{ marginBottom: 8 }}>
          <div className="card-head">
            <span className={`dot ${a.needsReauth ? "dot-amber" : isNext(a.id) ? "dot-blue" : "dot-muted"}`} />
            <strong>{a.email}</strong>
            <span className="card-badges">
              {a.plan && <span className="badge badge-green">{a.plan}</span>}
              <TicketBadge t={t} account={a} onClick={() => openResetPopup(a)} />
              {a.needsReauth && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
              {isNext(a.id) && !a.needsReauth && (
                <span className="badge badge-primary">
                  {t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")}
                </span>
              )}
            </span>
            {!isNext(a.id) && !a.needsReauth && (
              <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => setConfirm(a)}>
                {switchActionLabel}
              </button>
            )}
            <button
              className="btn-icon btn-icon-danger card-right"
              aria-label={`${t("common.remove")} — ${a.email}`}
              title={`${t("common.remove")} — ${a.email}`}
              onClick={e => { e.stopPropagation(); remove(a.id); }}
            >
              <IconX width={14} />
            </button>
          </div>
          {a.needsReauth
            ? <div className="card-sub faint">{t("codexAuth.tokenExpired")}</div>
            : <QuotaBars quota={a.quota} plan={a.plan} threshold={autoThreshold} t={t} />}
        </div>
      ))}

      <div className="card card-row" style={{ marginTop: 16 }}>
        <div>
          <strong>{t("codexAuth.autoSwitch")}</strong>
          <div className="card-sub">{t("codexAuth.autoSwitchDesc")}</div>
        </div>
        <button className={`toggle ${autoThreshold > 0 ? "on" : ""}`} onClick={toggleAuto}
          aria-pressed={autoThreshold > 0} aria-label={t("codexAuth.autoSwitch")} title={t("codexAuth.autoSwitch")}>
          <span className="toggle-knob" />
        </button>
      </div>

      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3>{accountModeState === "direct"
              ? t("codexAuth.preparePoolTitle")
              : confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</h3>
            <p className="modal-desc">
              {accountModeState === "direct"
                ? t("codexAuth.preparePoolDesc")
                : confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
            </p>
            <div className="card" style={{ margin: "12px 0" }}>
              <strong>{confirm.id === "__main__" ? main?.email : confirm.email}</strong>
              {confirm.plan && <span className="badge badge-green" style={{ marginLeft: 8 }}>{confirm.plan}</span>}
            </div>
            {confirm.id !== "__main__" && (
              <div className="notice-warn"><IconAlert width={14} /> {t("codexAuth.cacheWarning")}</div>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>{t("codexAuth.cancel")}</button>
              <button className="btn btn-primary" disabled={Boolean(switchingId)} onClick={() => setActive(confirm.id === "__main__" ? "__main__" : confirm.id)}>
                {switchingId ? t("pws.accountSwitching") : t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext")}
              </button>
            </div>
          </div>
        </div>
      )}

      {resetPopup && (
        <div className="modal-overlay" onClick={() => { setResetPopup(null); setResetConfirm(false); setCreditDetails(null); }}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            {!resetConfirm ? (
              <>
                <h3><IconTicket width={16} /> {t("codexAuth.resetCreditsTitle")}</h3>
                <div className="card-sub">{resetPopup.email}{resetPopup.plan ? ` · ${resetPopup.plan}` : ""}</div>
                <div style={{ margin: "16px 0" }}>
                  {(resetPopup.quota?.resetCredits ?? 0) > 0 ? (
                    <>
                      <p style={{ marginBottom: 12 }}>{t("codexAuth.resetCreditsAvailable", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
                      {creditDetailsLoading && <p className="faint text-label">{t("common.loading")}</p>}
                      {creditDetails && creditDetails.length > 0 && (
                        <div className="credit-list">
                          {creditDetails.map((c, i) => (
                            <CreditItem key={i} index={i} grantedAt={c.granted_at} expiresAt={c.expires_at} isNext={i === 0} t={t} />
                          ))}
                        </div>
                      )}
                      <button className="btn btn-primary" style={{ marginTop: 12, width: "100%" }}
                        onClick={() => setResetConfirm(true)} disabled={redeeming}>
                        {t("codexAuth.useOneCredit")}
                      </button>
                      <p className="card-sub text-caption" style={{ marginTop: 8, textAlign: "center" }}>{t("codexAuth.fifoNote")}</p>
                    </>
                  ) : (
                    <>
                      <p className="faint">{t("codexAuth.noResetCredits")}</p>
                      <p className="modal-desc">{t("codexAuth.earnCreditsHint")}</p>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div style={{ textAlign: "center", padding: "12px 0" }}>
                  <div className="confirm-icon"><IconAlert width={22} /></div>
                  <h3>{t("codexAuth.confirmResetTitle")}</h3>
                  <p className="modal-desc">{t("codexAuth.confirmResetDesc", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
                  {creditDetails && creditDetails[0] && (
                    <p className="faint text-label">
                      {t("codexAuth.confirmWhichCredit", { date: formatCreditDate(creditDetails[0].granted_at) })}
                    </p>
                  )}
                  <p className="faint text-label">{t("codexAuth.irreversible")}</p>
                </div>
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={() => setResetConfirm(false)}>{t("codexAuth.cancel")}</button>
                  <button className="btn btn-primary" onClick={() => handleRedeem(resetPopup.id)} disabled={redeeming}>
                    {redeeming ? t("codexAuth.redeeming") : t("codexAuth.useCredit")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showAdd && (
        <AddCodexAccountModal
          apiBase={apiBase}
          onClose={() => setShowAdd(false)}
          onAdded={() => { load(); setToast(t("codexAuth.accountAdded")); setTimeout(() => setToast(""), 5000); }}
        />
      )}
    </div>
  );
}

function formatCreditDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

function CreditItem({ index, grantedAt, expiresAt, isNext, t }: {
  index: number; grantedAt: string; expiresAt: string; isNext: boolean; t: TFn;
}) {
  const days = daysUntil(expiresAt);
  const urgent = days <= 7;
  return (
    <div className={`credit-item${isNext ? " credit-next" : ""}`}>
      <div className="credit-item-head">
        <IconTicket width={13} />
        <span className="credit-item-label">
          {isNext ? t("codexAuth.creditNext") : t("codexAuth.creditLabel", { n: String(index + 1) })}
        </span>
        {isNext && <span className="badge badge-amber text-micro" style={{ padding: "1px 6px" }}>{t("codexAuth.creditNextBadge")}</span>}
      </div>
      <div className="credit-item-dates">
        <span>{t("codexAuth.creditGranted", { date: formatCreditDate(grantedAt) })}</span>
        <span className={urgent ? "credit-urgent" : ""}>{t("codexAuth.creditExpires", { date: formatCreditDate(expiresAt), days: String(days) })}</span>
      </div>
    </div>
  );
}

function TicketBadge({ account, onClick, t }: { account: CodexAccountEntry; onClick: () => void; t: TFn }) {
  const credits = account.quota?.resetCredits;
  if (credits === undefined) return null;
  const hasCredits = typeof credits === "number" && credits > 0;
  return (
    <button type="button"
      className={`badge ${hasCredits ? "badge-amber" : "badge-muted"} badge-clickable`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={t("codexAuth.resetCreditsAria", { count: String(credits) })}
    >
      <IconTicket width={12} />
      {credits}
    </button>
  );
}
