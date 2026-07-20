import { useCallback, useEffect, useRef, useState } from "react";
import { IconGlobe, IconLink } from "../icons";
import { useT } from "../i18n";

export default function AddCodexAccountModal({
  apiBase, onClose, onAdded, reauthAccountId,
}: {
  apiBase: string;
  onClose: () => void;
  onAdded: () => void;
  reauthAccountId?: string;
}) {
  const t = useT();
  const [step, setStep] = useState<"pick" | "oauth-waiting">(reauthAccountId ? "oauth-waiting" : "pick");
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const aliveRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRef = useRef<string | null>(null);
  const loginAbortRef = useRef<AbortController | null>(null);
  /** Ensures reauth auto-start runs once per account id, even if startOAuth identity changes. */
  const startedReauthRef = useRef<string | null>(null);
  const onAddedRef = useRef(onAdded);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onAddedRef.current = onAdded;
  }, [onAdded]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  const cancelLogin = useCallback(async () => {
    const flowId = flowRef.current;
    flowRef.current = null;
    setAuthUrl("");
    stopPolling();
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    if (!flowId) return;
    await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId }),
    }).catch(() => {});
  }, [apiBase, stopPolling]);

  useEffect(() => () => {
    aliveRef.current = false;
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    const flowId = flowRef.current;
    flowRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    // Cancel in-flight OAuth so a remounted modal cannot race a stale chatgpt scratch slot.
    if (flowId) {
      void fetch(`${apiBase}/api/codex-auth/login/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId }),
      }).catch(() => {});
    }
  }, [apiBase]);

  const closeModal = useCallback(() => {
    if (step === "oauth-waiting") void cancelLogin();
    onCloseRef.current();
  }, [step, cancelLogin]);

  const startOAuth = useCallback(async (requestedId?: string) => {
    const controller = new AbortController();
    loginAbortRef.current?.abort();
    loginAbortRef.current = controller;
    setError("");
    try {
      const accountId = reauthAccountId ?? requestedId?.trim() ?? "";
      const resp = await fetch(`${apiBase}/api/codex-auth/login`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reauthAccountId
            ? { id: reauthAccountId, reauth: true }
            : (accountId ? { id: accountId } : {}),
        ),
      });
      const data = await resp.json() as { url?: string; flowId?: string; error?: string; status?: string };
      if (!aliveRef.current) return;
      if (resp.status === 409) {
        setError(t("codexAuth.oauthAlreadyInProgress"));
        return;
      }
      if (data.url) {
        flowRef.current = data.flowId ?? null;
        setAuthUrl(data.url);
        setStep("oauth-waiting");
        stopPolling();
        const fid = data.flowId ?? "";
        const reauthQuery = reauthAccountId ? "&reauth=1" : "";
        const statusUrl = fid
          ? `${apiBase}/api/codex-auth/login-status?flowId=${encodeURIComponent(fid)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}${reauthQuery}`
          : `${apiBase}/api/codex-auth/login-status`;
        pollRef.current = setInterval(async () => {
          try {
            const st = await fetch(statusUrl).then(r => r.json()) as { status: string; error?: string };
            if (st.status === "done") {
              stopPolling();
              flowRef.current = null;
              if (!aliveRef.current) return;
              onAddedRef.current();
              onCloseRef.current();
            } else if (st.status === "error" || st.status === "expired") {
              stopPolling();
              flowRef.current = null;
              if (aliveRef.current) {
                if (!reauthAccountId) setStep("pick");
                setError(st.error ?? "Login failed");
              }
            }
          } catch { /* ignore network errors during polling */ }
        }, 2000);
        timeoutRef.current = setTimeout(() => {
          if (pollRef.current) {
            void cancelLogin();
            if (aliveRef.current) {
              if (!reauthAccountId) setStep("pick");
              setError(t("modal.loginTimeout"));
            }
          }
        }, 300_000);
      }
      if (data.error && !data.url) setError(data.error);
    } catch (e) {
      if (aliveRef.current && !(e instanceof Error && e.name === "AbortError")) setError(String(e));
    }
  }, [apiBase, cancelLogin, reauthAccountId, stopPolling, t]);

  useEffect(() => {
    if (!reauthAccountId) {
      startedReauthRef.current = null;
      return;
    }
    if (startedReauthRef.current === reauthAccountId) return;
    startedReauthRef.current = reauthAccountId;
    void startOAuth();
  }, [reauthAccountId, startOAuth]);

  const copyLoginLink = async () => {
    if (!authUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(authUrl);
      } else {
        const input = document.createElement("textarea");
        input.value = authUrl;
        input.style.opacity = "0";
        input.style.position = "fixed";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      setCopied(true);
      setTimeout(() => { if (aliveRef.current) setCopied(false); }, 2500);
    } catch {
      setError(t("codexAuth.loginLinkCopyFailed"));
    }
  };

  // Focus-trap: focus first interactive element on mount, restore on unmount.
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      );
      if (focusable) focusable.focus();
    }
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeModal(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  const dialogLabel = reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.addTitle");

  return (
    <div role="dialog" aria-modal="true" aria-label={dialogLabel} className="modal-overlay" onClick={closeModal}>
      <div ref={dialogRef} className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        {step === "pick" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t("codexAuth.addTitle")}</h3>
            <p className="modal-desc">{t("codexAuth.addPickDesc")}</p>

            <label className="field-label">{t("codexAuth.addIdLabel")}</label>
            <input
              className="input"
              placeholder={t("codexAuth.addIdPlaceholder")}
              value={id}
              onChange={e => setId(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <button className="list-row" onClick={() => void startOAuth(id)} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <IconGlobe width={20} />
                <div>
                  <div className="title">{t("codexAuth.oauthLogin")}</div>
                  <div className="sub">{t("codexAuth.oauthDesc")}</div>
                </div>
              </div>
            </button>

            {error && <div className="notice notice-err" style={{ marginTop: 8 }}>{error}</div>}

            <button className="btn btn-ghost" onClick={closeModal} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}

        {step === "oauth-waiting" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.oauthLogin")}</h3>
            <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
            <button className="btn btn-ghost" onClick={copyLoginLink} disabled={!authUrl} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
              <IconLink width={14} /> {copied ? t("codexAuth.loginLinkCopied") : t("codexAuth.copyLoginLink")}
            </button>
            {error && <div className="notice notice-err" style={{ marginTop: 12 }}>{error}</div>}
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <span className="spin" style={{ width: 24, height: 24 }} />
            </div>
            <button className="btn btn-ghost" onClick={closeModal} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
