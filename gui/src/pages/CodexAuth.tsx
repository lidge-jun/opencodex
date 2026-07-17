import { useCallback, useEffect, useRef, useState } from "react";
import { useT, type TFn } from "../i18n/shared";
import { IconLock, IconPlus, IconX, IconAlert, IconRefresh, IconTicket } from "../icons";
import { Notice, EmptyState } from "../ui";
import AddCodexAccountModal from "../components/AddCodexAccountModal";
import type { AccountQuota } from "../codex-quota-utils";
import QuotaBars from "../components/QuotaBars";

interface AccountEntry {
  id: string; email: string; plan?: string; isMain: boolean;
  hasCredential: boolean; quota: AccountQuota | null;
  needsReauth?: boolean;
}

export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [autoThreshold, setAutoThreshold] = useState(80);
  const [confirm, setConfirm] = useState<AccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState("");
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [resetPopup, setResetPopup] = useState<AccountEntry | null>(null);
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
    load();
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

  const openResetPopup = async (account: AccountEntry) => {
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

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">{t("nav.codexAuth")}</h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={refreshQuotas} disabled={refreshingQuota}>
          <IconRefresh width={14} /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
        </button>
      </div>

      {toast && <Notice tone="ok">{toast}</Notice>}

      <button
        type="button"
        className={`card card-selectable ${isMainActive ? "card-active" : ""}`}
        onClick={() => !isMainActive && setConfirm({ id: "__main__", email: main?.email ?? "Codex App", plan: main?.plan, isMain: true, hasCredential: true, quota: main?.quota ?? null })}
        disabled={isMainActive}
        style={{ marginBottom: 12 }}
      >
        <div className="card-head">
          <span className="dot dot-green" />
          <strong>{t("codexAuth.mainAccount")}</strong>
          <span className="card-badges">
            {main && <TicketBadge t={t} account={{ ...main, id: "__main__" } as AccountEntry} onClick={() => openResetPopup({ ...main, id: "__main__" } as AccountEntry)} />}
            <span className={`badge ${isMainActive ? "badge-primary" : "badge-muted"}`}>
              {isMainActive ? t("codexAuth.nextSession") : t("codexAuth.current")}
            </span>
          </span>
          <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
        </div>
        <div className="card-sub">{main?.email ?? "Codex App login"}{main?.plan ? ` · ${main.plan}` : ""}</div>
        {main?.quota && <QuotaBars quota={main.quota} plan={main.plan} threshold={autoThreshold} t={t} />}
      </button>

      <div className="section-sep">
        <span className="section-label">{t("codexAuth.accountPool")}</span>
        <div className="sep-line" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAdd(true)}>
          <IconPlus width={14} /> {t("codexAuth.add")}
        </button>
      </div>

      {pool.length === 0 && <EmptyState title={t("codexAuth.noPool")} />}

      {pool.map(a => (
        <div
          key={a.id}
          className={`card ${isNext(a.id) ? "card-active" : ""}`}
          style={{ marginBottom: 8 }}
        >
          <div className="card-head">
            <button
              type="button"
              className="card-select-hit"
              onClick={() => !a.needsReauth && setConfirm(a)}
              disabled={!!a.needsReauth}
            >
              <span className={`dot ${a.needsReauth ? "dot-amber" : isNext(a.id) ? "dot-blue" : "dot-muted"}`} />
              <strong>{a.email}</strong>
              <span className="card-badges">
                {a.plan && <span className="badge badge-green">{a.plan}</span>}
                {a.needsReauth && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
                {isNext(a.id) && !a.needsReauth && <span className="badge badge-primary">{t("codexAuth.nextSession")}</span>}
              </span>
            </button>
            <TicketBadge t={t} account={a} onClick={() => openResetPopup(a)} />
            <button
              type="button"
              className="btn-icon btn-icon-danger card-right"
              aria-label={t("common.remove")}
              onClick={() => remove(a.id)}
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
        <button type="button" className={`toggle ${autoThreshold > 0 ? "on" : ""}`} onClick={toggleAuto}
          aria-pressed={autoThreshold > 0} aria-label={t("codexAuth.autoSwitch")} title={t("codexAuth.autoSwitch")}>
          <span className="toggle-knob" />
        </button>
      </div>

      {confirm && (
        <SwitchConfirmDialog
          confirm={confirm}
          mainEmail={main?.email}
          t={t}
          onClose={() => setConfirm(null)}
          onConfirm={() => setActive(confirm.id === "__main__" ? "__main__" : confirm.id)}
        />
      )}

      {resetPopup && (
        <ResetCreditsDialog
          account={resetPopup}
          resetConfirm={resetConfirm}
          redeeming={redeeming}
          creditDetails={creditDetails}
          creditDetailsLoading={creditDetailsLoading}
          t={t}
          onClose={() => { setResetPopup(null); setResetConfirm(false); setCreditDetails(null); }}
          onConfirm={() => setResetConfirm(true)}
          onBack={() => setResetConfirm(false)}
          onRedeem={() => handleRedeem(resetPopup.id)}
        />
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

const creditDateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function formatCreditDate(iso: string): string {
  return creditDateFmt.format(new Date(iso));
}

function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return ref;
}

function SwitchConfirmDialog({
  confirm, mainEmail, t, onClose, onConfirm,
}: {
  confirm: AccountEntry;
  mainEmail?: string;
  t: TFn;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useModalDialog(true);
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="switch-confirm-title"
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-card">
        <h3 id="switch-confirm-title">{confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</h3>
        <p className="modal-desc">
          {confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
        </p>
        <div className="card" style={{ margin: "12px 0" }}>
          <strong>{confirm.id === "__main__" ? mainEmail : confirm.email}</strong>
          {confirm.plan && <span className="badge badge-green" style={{ marginLeft: 8 }}>{confirm.plan}</span>}
        </div>
        {confirm.id !== "__main__" && (
          <div className="notice-warn"><IconAlert width={14} /> {t("codexAuth.cacheWarning")}</div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("codexAuth.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {t("codexAuth.setAsNext")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function ResetCreditsDialog({
  account, resetConfirm, redeeming, creditDetails, creditDetailsLoading, t,
  onClose, onConfirm, onBack, onRedeem,
}: {
  account: AccountEntry;
  resetConfirm: boolean;
  redeeming: boolean;
  creditDetails: { granted_at: string; expires_at: string }[] | null;
  creditDetailsLoading: boolean;
  t: TFn;
  onClose: () => void;
  onConfirm: () => void;
  onBack: () => void;
  onRedeem: () => void;
}) {
  const dialogRef = useModalDialog(true);
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="reset-credits-title"
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-card">
        {!resetConfirm ? (
          <>
            <h3 id="reset-credits-title"><IconTicket width={16} /> {t("codexAuth.resetCreditsTitle")}</h3>
            <div className="card-sub">{account.email}{account.plan ? ` · ${account.plan}` : ""}</div>
            <div style={{ margin: "16px 0" }}>
              {(account.quota?.resetCredits ?? 0) > 0 ? (
                <>
                  <p style={{ marginBottom: 12 }}>{t("codexAuth.resetCreditsAvailable", { count: String(account.quota?.resetCredits ?? 0) })}</p>
                  {creditDetailsLoading && <p className="faint text-label">{t("common.loading")}</p>}
                  {creditDetails && creditDetails.length > 0 && (
                    <div className="credit-list">
                      {creditDetails.map((c, i) => (
                        <CreditItem key={`${c.granted_at}-${c.expires_at}`} index={i} grantedAt={c.granted_at} expiresAt={c.expires_at} isNext={i === 0} t={t} />
                      ))}
                    </div>
                  )}
                  <button type="button" className="btn btn-primary" style={{ marginTop: 12, width: "100%" }}
                    onClick={onConfirm} disabled={redeeming}>
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
              <h3 id="reset-credits-title">{t("codexAuth.confirmResetTitle")}</h3>
              <p className="modal-desc">{t("codexAuth.confirmResetDesc", { count: String(account.quota?.resetCredits ?? 0) })}</p>
              {creditDetails && creditDetails[0] && (
                <p className="faint text-label">
                  {t("codexAuth.confirmWhichCredit", { date: formatCreditDate(creditDetails[0].granted_at) })}
                </p>
              )}
              <p className="faint text-label">{t("codexAuth.irreversible")}</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onBack}>{t("codexAuth.cancel")}</button>
              <button type="button" className="btn btn-primary" onClick={onRedeem} disabled={redeeming}>
                {redeeming ? t("codexAuth.redeeming") : t("codexAuth.useCredit")}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
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

function TicketBadge({ account, onClick, t }: { account: AccountEntry; onClick: () => void; t: TFn }) {
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
