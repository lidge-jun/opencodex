import { useEffect, useRef, useState } from "react";
import { IconLink } from "../icons";
import { useT } from "../i18n";

export default function AddCodexAccountModal({
  apiBase, onClose, onAdded,
}: {
  apiBase: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const aliveRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRef = useRef<string | null>(null);
  useEffect(() => () => {
    aliveRef.current = false;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  const [step, setStep] = useState<"pick" | "oauth-waiting">("pick");
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [existingIds, setExistingIds] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/codex-auth/accounts`)
      .then(r => r.json())
      .then((data: { accounts?: Array<{ id: string }> }) => {
        if (!cancelled) {
          setExistingIds((data.accounts ?? []).map(a => a.id.toLowerCase()));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase]);

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
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(authUrl);
      } else {
        const input = document.createElement("textarea");
        input.value = authUrl;
        input.style.position = "fixed";
        input.style.opacity = "0";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeModal(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const slug = id.trim();
  const slugKey = slug.toLowerCase();
  const slugDuplicate = slugKey !== "" && existingIds.includes(slugKey);
  const canStart = !starting && !slugDuplicate;

  const startOAuth = async () => {
    if (!canStart) return;
    setError("");
    if (slugDuplicate) {
      setError(t("codexAuth.slugDuplicate", { id: slug }));
      return;
    }
    setStarting(true);
    try {
      const requestedId = slug;
      const resp = await fetch(`${apiBase}/api/codex-auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestedId ? { id: requestedId } : {}),
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
    } catch (e) {
      setError(String(e));
    } finally {
      if (aliveRef.current) setStarting(false);
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("codexAuth.addTitle")} onClick={closeModal}>
      <div className="modal-card codex-add-account-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        {step === "pick" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t("codexAuth.addTitle")}</h3>
            <p className="modal-desc">{t("codexAuth.addPickDesc")}</p>

            <label className="field-label" htmlFor="codex-account-slug">{t("codexAuth.addIdLabel")}</label>
            <input
              id="codex-account-slug"
              className="input"
              placeholder={t("codexAuth.addIdPlaceholder")}
              value={id}
              onChange={e => { setId(e.target.value); setError(""); }}
              aria-describedby="codex-account-slug-hint"
              aria-invalid={slugDuplicate}
            />
            <p id="codex-account-slug-hint" className="muted text-caption" style={{ margin: "6px 0 14px" }}>
              {t("codexAuth.addIdHint")}
            </p>
            {slugDuplicate && (
              <div className="notice notice-err" style={{ marginBottom: 12 }} role="alert">
                {t("codexAuth.slugDuplicate", { id: slug })}
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { void startOAuth(); }}
              disabled={!canStart}
              style={{ width: "100%", padding: "12px 16px" }}
            >
              {starting ? t("modal.waitingBrowser") : t("codexAuth.signInWithChatGpt")}
            </button>

            {error && !slugDuplicate && (
              <div className="notice notice-err" style={{ marginTop: 12 }} role="alert">{error}</div>
            )}

            <div className="codex-add-account-actions">
              <button type="button" className="btn btn-ghost" onClick={closeModal}>
                {t("codexAuth.cancel")}
              </button>
            </div>
          </>
        )}

        {step === "oauth-waiting" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t("codexAuth.signInWithChatGpt")}</h3>
            <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
            <button type="button" className="btn btn-ghost" onClick={copyLoginLink} disabled={!authUrl} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
              <IconLink width={14} /> {copied ? t("codexAuth.loginLinkCopied") : t("codexAuth.copyLoginLink")}
            </button>
            {error && <div className="notice notice-err" style={{ marginTop: 12 }}>{error}</div>}
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <span className="spin" style={{ width: 24, height: 24 }} />
            </div>
            <div className="codex-add-account-actions">
              <button type="button" className="btn btn-ghost" onClick={closeModal}>
                {t("codexAuth.cancel")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
