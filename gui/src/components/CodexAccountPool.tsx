import { useCallback, useEffect, useState } from "react";
import { useT, type TFn } from "../i18n";
import { IconPlus, IconX, IconAlert, IconRefresh, IconTicket } from "../icons";
import { Notice } from "../ui";
import AddCodexAccountModal from "./AddCodexAccountModal";
import type { AccountQuota } from "../codex-quota-utils";
import QuotaBars from "./QuotaBars";

export interface CodexAccountEntry {
  id: string;
  email: string;
  plan?: string;
  isMain: boolean;
  hasCredential: boolean;
  quota: AccountQuota | null;
  needsReauth?: boolean;
}

type CodexAccountPoolProps = {
  apiBase: string;
  /** When true, omit page chrome — parent supplies the section title (Providers Overview). */
  embedded?: boolean;
};

/**
 * Global ChatGPT / Codex account pool (main + extras). Shared by the former
 * Codex Auth page and ChatGPT forward-provider Overview Authentication.
 */
export default function CodexAccountPool({ apiBase, embedded = false }: CodexAccountPoolProps) {
  const t = useT();
  const [accounts, setAccounts] = useState<CodexAccountEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [autoThreshold, setAutoThreshold] = useState(80);
  const [confirm, setConfirm] = useState<CodexAccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState("");
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [resetPopup, setResetPopup] = useState<CodexAccountEntry | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [creditDetails, setCreditDetails] = useState<{ granted_at: string; expires_at: string }[] | null>(null);
  const [creditDetailsLoading, setCreditDetailsLoading] = useState(false);

  const load = useCallback(async (refreshQuota = false) => {
    try {
      const [accts, active] = await Promise.all([
        fetch(`${apiBase}/api/codex-auth/accounts${refreshQuota ? "?refresh=1" : ""}`).then(r => r.json()),
        fetch(`${apiBase}/api/codex-auth/active`).then(r => r.json()),
      ]);
      setAccounts(accts.accounts ?? []);
      setActiveId(active.activeCodexAccountId ?? null);
      setAutoThreshold(active.autoSwitchThreshold ?? 80);
      return true;
    } catch {
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
    await fetch(`${apiBase}/api/codex-auth/active`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: id }),
    });
    setActiveId(id);
    setConfirm(null);
    const label = id && id !== "__main__" ? accounts.find(a => a.id === id)?.email ?? id : "main";
    setToast(t("codexAuth.switched", { email: label }));
    setTimeout(() => setToast(""), 5000);
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("codexAuth.removeConfirm", { id }))) return;
    await fetch(`${apiBase}/api/codex-auth/accounts?id=${id}`, { method: "DELETE" });
    void load();
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
  const mainConfirmEntry: CodexAccountEntry = {
    id: "__main__",
    email: main?.email ?? t("codexAuth.appLogin"),
    plan: main?.plan,
    isMain: true,
    hasCredential: true,
    quota: main?.quota ?? null,
  };

  const modals = (
    <>
      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3>{confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</h3>
            <p className="modal-desc">
              {confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
            </p>
            <div className="card" style={{ margin: "12px 0" }}>
              <strong>{confirm.id === "__main__" ? main?.email : confirm.email}</strong>
              {confirm.plan && <span className="badge badge-green" style={{ marginLeft: 8 }}>{confirm.plan}</span>}
            </div>
            {confirm.id !== "__main__" && (
              <div className="notice-warn"><IconAlert width={14} /> {t("codexAuth.cacheWarning")}</div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>{t("codexAuth.cancel")}</button>
              <button type="button" className="btn btn-primary" onClick={() => void setActive(confirm.id === "__main__" ? "__main__" : confirm.id)}>
                {t("codexAuth.setAsNext")}
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
                      <button type="button" className="btn btn-primary" style={{ marginTop: 12, width: "100%" }}
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
                  <button type="button" className="btn btn-ghost" onClick={() => setResetConfirm(false)}>{t("codexAuth.cancel")}</button>
                  <button type="button" className="btn btn-primary" onClick={() => void handleRedeem(resetPopup.id)} disabled={redeeming}>
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
          onAdded={() => { void load(); setToast(t("codexAuth.accountAdded")); setTimeout(() => setToast(""), 5000); }}
        />
      )}
    </>
  );

  // Overview embed: match OAuth providers (Anthropic) — simple rows, no quota bars (Usage tab).
  if (embedded) {
    const mainEmail = main?.email?.trim() || "";
    const mainLabel = mainEmail
      ? (main?.plan ? `${mainEmail} · ${main.plan}` : mainEmail)
      : t("codexAuth.appLogin");
    return (
      <div className="codex-account-pool codex-account-pool--embedded">
        {toast && <Notice tone="ok">{toast}</Notice>}

        <div className="pwi-auth-list" role="list">
          <div className="pwi-auth-status-row" role="listitem">
            <button
              type="button"
              className="pwi-auth-row-main"
              onClick={() => { if (!isMainActive) setConfirm(mainConfirmEntry); }}
              disabled={isMainActive}
              title={isMainActive ? undefined : t("codexAuth.switchBack")}
            >
              <span className={`pwi-auth-dot ${isMainActive ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-auth-account-copy">
                <span className="pwi-auth-status-text">{mainLabel}</span>
                {mainEmail ? (
                  <span className="pwi-auth-method-hint" title={t("codexAuth.appLoginHint")}>
                    {t("codexAuth.appLogin")}
                  </span>
                ) : null}
              </span>
            </button>
            {main && (
              <TicketBadge
                t={t}
                account={{ ...main, id: "__main__" } as CodexAccountEntry}
                onClick={() => openResetPopup({ ...main, id: "__main__" } as CodexAccountEntry)}
              />
            )}
          </div>

          {pool.map(a => (
            <div className="pwi-auth-status-row" role="listitem" key={a.id}>
              <button
                type="button"
                className="pwi-auth-row-main"
                onClick={() => { if (!a.needsReauth) setConfirm(a); }}
                disabled={a.needsReauth || isNext(a.id)}
                title={a.needsReauth ? t("codexAuth.tokenExpired") : isNext(a.id) ? undefined : t("codexAuth.switchTitle")}
              >
                <span
                  className={`pwi-auth-dot ${a.needsReauth ? "pwi-auth-dot--warn" : isNext(a.id) ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`}
                  aria-hidden="true"
                />
                <span className="pwi-auth-status-text">{a.email}{a.plan ? ` · ${a.plan}` : ""}</span>
                {a.needsReauth && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
              </button>
              <TicketBadge t={t} account={a} onClick={() => openResetPopup(a)} />
              <button
                type="button"
                className="btn btn-ghost btn-sm pwi-auth-row-remove"
                onClick={() => void remove(a.id)}
                aria-label={t("common.remove")}
                title={t("common.remove")}
              >
                <IconX width={13} />
              </button>
            </div>
          ))}
        </div>

        <button type="button" className="pwi-auth-add" onClick={() => setShowAdd(true)}>
          <IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.accountAdd")}
        </button>

        <div className="codex-account-pool-auto">
          <div className="codex-account-pool-auto-copy">
            <strong>{t("codexAuth.autoSwitch")}</strong>
            <div className="card-sub">{t("codexAuth.autoSwitchDesc")}</div>
          </div>
          <button type="button" className={`toggle ${autoThreshold > 0 ? "on" : ""}`} onClick={() => void toggleAuto()}
            aria-pressed={autoThreshold > 0} aria-label={t("codexAuth.autoSwitch")} title={t("codexAuth.autoSwitch")}>
            <span className="toggle-knob" />
          </button>
        </div>

        {modals}
      </div>
    );
  }

  return (
    <div className="codex-account-pool">
      <div className="page-head">
        <h2 className="page-title">{t("nav.codexAuth")}</h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refreshQuotas()} disabled={refreshingQuota}>
          <IconRefresh width={14} /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
        </button>
      </div>

      {toast && <Notice tone="ok">{toast}</Notice>}

      <div className={`card ${isMainActive ? "card-active" : ""}`}
        onClick={() => !isMainActive ? setConfirm(mainConfirmEntry) : undefined}
        style={{ cursor: isMainActive ? "default" : "pointer", marginBottom: 12 }}>
        <div className="card-head">
          <span className="dot dot-green" />
          <strong>{t("codexAuth.mainAccount")}</strong>
          <span className="card-badges">
            {main && <TicketBadge t={t} account={{ ...main, id: "__main__" } as CodexAccountEntry} onClick={() => openResetPopup({ ...main, id: "__main__" } as CodexAccountEntry)} />}
            <span className={`badge ${isMainActive ? "badge-primary" : "badge-muted"}`}>
              {isMainActive ? t("codexAuth.nextSession") : t("codexAuth.current")}
            </span>
          </span>
          <span className="card-right muted">{t("codexAuth.appLogin")}</span>
        </div>
        <div className="card-sub">{main?.email ?? t("codexAuth.appLogin")}{main?.plan ? ` · ${main.plan}` : ""}</div>
        {main?.quota && <QuotaBars quota={main.quota} plan={main.plan} threshold={autoThreshold} t={t} layout="stacked" />}
      </div>

      <div className="section-sep">
        <span className="section-label">{t("codexAuth.accountPool")}</span>
        <div className="sep-line" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAdd(true)}>
          <IconPlus width={14} /> {t("codexAuth.addAccount")}
        </button>
      </div>

      {pool.length === 0 && (
        <div className="codex-pool-empty">
          <span className="codex-pool-empty-text muted">{t("codexAuth.noPoolInline")}</span>
        </div>
      )}

      {pool.map(a => (
        <div key={a.id} className={`card ${isNext(a.id) ? "card-active" : ""}`}
          onClick={() => !a.needsReauth && setConfirm(a)} style={{ cursor: a.needsReauth ? "default" : "pointer", marginBottom: 8 }}>
          <div className="card-head">
            <span className={`dot ${a.needsReauth ? "dot-amber" : isNext(a.id) ? "dot-blue" : "dot-muted"}`} />
            <strong>{a.email}</strong>
            <span className="card-badges">
              {a.plan && <span className="badge badge-green">{a.plan}</span>}
              <TicketBadge t={t} account={a} onClick={() => openResetPopup(a)} />
              {a.needsReauth && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
              {isNext(a.id) && !a.needsReauth && <span className="badge badge-primary">{t("codexAuth.nextSession")}</span>}
            </span>
            <button
              type="button"
              className="btn-icon btn-icon-danger card-right"
              aria-label={t("common.remove")}
              onClick={e => { e.stopPropagation(); void remove(a.id); }}
            >
              <IconX width={14} />
            </button>
          </div>
          {a.needsReauth
            ? <div className="card-sub faint">{t("codexAuth.tokenExpired")}</div>
            : <QuotaBars quota={a.quota} plan={a.plan} threshold={autoThreshold} t={t} layout="stacked" />}
        </div>
      ))}

      <div className="card card-row" style={{ marginTop: 16 }}>
        <div>
          <strong>{t("codexAuth.autoSwitch")}</strong>
          <div className="card-sub">{t("codexAuth.autoSwitchDesc")}</div>
        </div>
        <button type="button" className={`toggle ${autoThreshold > 0 ? "on" : ""}`} onClick={() => void toggleAuto()}
          aria-pressed={autoThreshold > 0} aria-label={t("codexAuth.autoSwitch")} title={t("codexAuth.autoSwitch")}>
          <span className="toggle-knob" />
        </button>
      </div>

      {modals}
    </div>
  );
}

/** Compact Settings status for forward/ChatGPT providers (no full pool UI). */
export function CodexForwardAuthStatus({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [accts, active] = await Promise.all([
          fetch(`${apiBase}/api/codex-auth/accounts`).then(r => r.json()),
          fetch(`${apiBase}/api/codex-auth/active`).then(r => r.json()),
        ]);
        if (cancelled) return;
        const accounts = (accts.accounts ?? []) as CodexAccountEntry[];
        const activeId = (active.activeCodexAccountId ?? null) as string | null;
        const isMain = !activeId || activeId === "__main__";
        const next = isMain
          ? accounts.find(a => a.isMain)
          : accounts.find(a => a.id === activeId);
        setLabel(next?.email ?? (isMain ? t("codexAuth.appLogin") : activeId));
      } catch {
        if (!cancelled) setLabel(null);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [apiBase, t]);

  return (
    <div className="providers-workspace-row providers-workspace-row--stack">
      <span className="providers-workspace-row-label">
        {t("pws.auth.chatgptPassthrough")}
        <span className="providers-workspace-row-label-desc">{t("pws.authForwardDesc")}</span>
        <span className="providers-workspace-row-label-desc">{t("pws.authForwardManageHint")}</span>
        <span
          className="providers-workspace-row-label-desc pwi-auth-next-session"
          title={label ?? undefined}
        >
          {label ? t("pws.authForwardNextSession", { email: label }) : t("pws.authForwardCredentials")}
        </span>
      </span>
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
  const tip = t("codexAuth.resetCreditsTitleTooltip", { count: String(credits) });
  return (
    <button type="button"
      className={`badge ${hasCredits ? "badge-amber" : "badge-muted"} badge-clickable`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={t("codexAuth.resetCreditsAria", { count: String(credits) })}
      title={tip}
    >
      <IconTicket width={12} />
      {credits}
    </button>
  );
}

/** Prefer built-in `openai`, else first forward provider in config. */
export function pickChatGptForwardProvider(providers: Record<string, { authMode?: string }>): string | null {
  if (providers.openai && (providers.openai.authMode ?? "").toLowerCase() === "forward") return "openai";
  if (providers.chatgpt && (providers.chatgpt.authMode ?? "").toLowerCase() === "forward") return "chatgpt";
  for (const [name, p] of Object.entries(providers)) {
    if ((p.authMode ?? "").toLowerCase() === "forward") return name;
  }
  return null;
}
