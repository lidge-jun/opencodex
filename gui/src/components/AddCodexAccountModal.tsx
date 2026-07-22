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
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);
  const [flowId, setFlowId] = useState<string | null>(null);

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

  const clearManualCode = useCallback(() => {
    setManualCode("");
    setManualCodeBusy(false);
  }, []);

  const cancelLogin = useCallback(async () => {
    clearManualCode();
    const flowId = flowRef.current;
    flowRef.current = null;
    setFlowId(null);
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
  }, [apiBase, clearManualCode, stopPolling]);

  useEffect(() => () => {
    clearManualCode();
    aliveRef.current = false;
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    const flowId = flowRef.current;
    flowRef.current = null;
    setFlowId(null);
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
  }, [apiBase, clearManualCode]);

  const closeModal = useCallback(() => {
    if (step === "oauth-waiting") void cancelLogin();
    onCloseRef.current();
  }, [step, cancelLogin]);

  const startOAuth = useCallback(async (requestedId?: string) => {
    clearManualCode();
    flowRef.current = null;
    setFlowId(null);
    const controller = new AbortController();
    loginAbortRef.current?.abort();
    loginAbortRef.current = controller;
    setError("");
    try {
      const accountId = reauthAccountId ?? requestedId?.trim() ?? "";
      const requestLogin = () => fetch(`${apiBase}/api/codex-auth/login`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reauthAccountId
            ? { id: reauthAccountId, reauth: true }
            : (accountId ? { id: accountId } : {}),
        ),
      });
      let resp = await requestLogin();
      let data = await resp.json() as { url?: string; flowId?: string; error?: string; status?: string };
      if (!aliveRef.current) return;
      if (resp.status === 409) {
        // A newly mounted modal has no flow id for an abandoned server-side login.
        // Cancel that scratch flow and retry once so interruption never leaves the
        // account pool permanently stuck behind "already in progress".
        await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!aliveRef.current || controller.signal.aborted) return;
        resp = await requestLogin();
        data = await resp.json() as typeof data;
        if (resp.status === 409) {
          setError(t("codexAuth.oauthAlreadyInProgress"));
          return;
        }
      }
      if (data.url) {
        flowRef.current = data.flowId ?? null;
        setFlowId(data.flowId ?? null);
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
              clearManualCode();
              flowRef.current = null;
              setFlowId(null);
              if (!aliveRef.current) return;
              onAddedRef.current();
              onCloseRef.current();
            } else if (st.status === "error" || st.status === "expired") {
              stopPolling();
              clearManualCode();
              flowRef.current = null;
              setFlowId(null);
              if (aliveRef.current) {
                if (!reauthAccountId) setStep("pick");
                setError(st.error ?? "Login failed");
              }
            }
          } catch { /* ignore network errors during polling */ }
        }, 2000);
        timeoutRef.current = setTimeout(() => {
          if (pollRef.current) {
            clearManualCode();
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
  }, [apiBase, cancelLogin, clearManualCode, reauthAccountId, stopPolling, t]);

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

  const submitManualCode = useCallback(async () => {
    const flowId = flowRef.current;
    const input = manualCode.trim();
    if (!flowId || !input || manualCodeBusy) return;
    setManualCodeBusy(true);
    setManualCode("");
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId, input }),
      });
      const data = await resp.json().catch(() => ({})) as { error?: string };
      if (!aliveRef.current) return;
      if (!resp.ok) {
        setError(t("prov.pasteFail", { error: data.error ?? resp.statusText }));
        return;
      }
      setError("");
    } catch {
      if (aliveRef.current) setError(t("modal.networkError"));
    } finally {
      if (aliveRef.current) setManualCodeBusy(false);
    }
  }, [apiBase, manualCode, manualCodeBusy, t]);

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
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
              <div className="muted text-label">{t("prov.pasteRedirectHint")}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={manualCode}
                  onChange={e => setManualCode(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitManualCode();
                    }
                  }}
                  placeholder={t("prov.pasteRedirect")}
                  aria-label={t("prov.pasteRedirect")}
                  disabled={manualCodeBusy}
                  className="input text-label"
                  style={{ flex: 1 }}
                />
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={manualCodeBusy || !manualCode.trim() || !flowId}
                  onClick={() => void submitManualCode()}
                >
                  {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                </button>
              </div>
            </div>
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
