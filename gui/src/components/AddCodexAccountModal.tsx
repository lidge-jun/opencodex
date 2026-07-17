import { useEffect, useId, useRef, useState } from "react";
import { IconGlobe, IconLink } from "../icons";
import { useT } from "../i18n/shared";

export default function AddCodexAccountModal({
  apiBase, onClose, onAdded,
}: {
  apiBase: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const accountIdFieldId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const aliveRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRef = useRef<string | null>(null);
  useEffect(() => () => {
    aliveRef.current = false;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (!el.open) el.showModal();
  }, []);

  const [step, setStep] = useState<"pick" | "oauth-waiting">("pick");
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  const cancelLogin = async () => {
    const flowId = flowRef.current;
    flowRef.current = null;
    setAuthUrl("");
    stopPolling();
    if (!flowId) return;
    await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId }),
    }).catch(() => {});
  };

  const closeModal = () => {
    if (step === "oauth-waiting") void cancelLogin();
    onClose();
  };

  const copyLoginLink = async () => {
    if (!authUrl) return;
    try {
      await navigator.clipboard.writeText(authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t("codexAuth.loginLinkCopyFailed"));
    }
  };

  const startOAuth = async () => {
    setError("");
    try {
      const requestedId = id.trim();
      const resp = await fetch(`${apiBase}/api/codex-auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestedId ? { id: requestedId } : {}),
      });
      const data = await resp.json() as { url?: string; flowId?: string; error?: string; status?: string };
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
        const statusUrl = fid
          ? `${apiBase}/api/codex-auth/login-status?flowId=${encodeURIComponent(fid)}${requestedId ? `&accountId=${encodeURIComponent(requestedId)}` : ""}`
          : `${apiBase}/api/codex-auth/login-status`;
        pollRef.current = setInterval(async () => {
          try {
            const st = await fetch(statusUrl).then(r => r.json()) as { status: string; error?: string };
            if (st.status === "done") {
              stopPolling();
              flowRef.current = null;
              onAdded();
              onClose();
            } else if (st.status === "error" || st.status === "expired") {
              stopPolling();
              flowRef.current = null;
              if (aliveRef.current) { setStep("pick"); setError(st.error ?? "Login failed"); }
            }
          } catch { /* ignore network errors during polling */ }
        }, 2000);
        timeoutRef.current = setTimeout(() => {
          if (pollRef.current) {
            void cancelLogin();
            if (aliveRef.current) { setStep("pick"); setError(t("modal.loginTimeout")); }
          }
        }, 300_000);
      }
      if (data.error && !data.url) setError(data.error);
    } catch (e) { setError(String(e)); }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="codex-add-title"
      onCancel={e => { e.preventDefault(); closeModal(); }}
    >
      <div className="modal-card modal-card-narrow">
        {step === "pick" && (
          <>
            <h3 id="codex-add-title" className="modal-title-sm">{t("codexAuth.addTitle")}</h3>
            <p className="modal-desc">{t("codexAuth.addPickDesc")}</p>

            <label className="field-label" htmlFor={accountIdFieldId}>{t("codexAuth.addIdLabel")}</label>
            <input
              id={accountIdFieldId}
              className="input input-mb"
              placeholder={t("codexAuth.addIdPlaceholder")}
              value={id}
              onChange={e => setId(e.target.value)}
            />

            <button type="button" className="list-row list-row-mb" onClick={() => void startOAuth()}>
              <div className="list-row-inner">
                <IconGlobe width={20} />
                <div>
                  <div className="title">{t("codexAuth.oauthLogin")}</div>
                  <div className="sub">{t("codexAuth.oauthDesc")}</div>
                </div>
              </div>
            </button>

            {error && <div className="notice notice-err notice-mt">{error}</div>}

            <button type="button" className="btn btn-ghost btn-block" onClick={closeModal}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}

        {step === "oauth-waiting" && (
          <>
            <h3 id="codex-add-title" className="modal-title-sm">{t("codexAuth.oauthLogin")}</h3>
            <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
            <button type="button" className="btn btn-ghost btn-block btn-block-mt" onClick={() => void copyLoginLink()} disabled={!authUrl}>
              <IconLink width={14} /> {copied ? t("codexAuth.loginLinkCopied") : t("codexAuth.copyLoginLink")}
            </button>
            {error && <div className="notice notice-err notice-mt-lg">{error}</div>}
            <div className="modal-spinner">
              <span className="spin spin-lg" />
            </div>
            <button type="button" className="btn btn-ghost btn-block" onClick={closeModal}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
