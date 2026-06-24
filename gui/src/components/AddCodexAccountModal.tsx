import { useEffect, useRef, useState } from "react";
import { IconX } from "../icons";
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
  useEffect(() => () => {
    aliveRef.current = false;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const [step, setStep] = useState<"pick" | "import" | "oauth-waiting">("pick");
  const [id, setId] = useState("");
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleImport = async () => {
    setError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError(t("codexAuth.importInvalidJson"));
      return;
    }
    const tokens = (parsed.tokens ?? parsed) as Record<string, unknown>;
    const accessToken = (tokens.access_token ?? tokens.accessToken) as string | undefined;
    const refreshToken = (tokens.refresh_token ?? tokens.refreshToken) as string | undefined;
    const accountId = (tokens.account_id ?? tokens.accountId ?? "") as string;
    if (!accessToken || !refreshToken) { setError(t("codexAuth.importMissingTokens")); return; }
    if (!id.trim()) { setError(t("codexAuth.importMissingId")); return; }

    setSaving(true);
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id.trim(), email: id.trim(), accessToken, refreshToken, chatgptAccountId: accountId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Failed");
        return;
      }
      onAdded();
      onClose();
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        {step === "pick" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t("codexAuth.addTitle")}</h3>
            <p className="modal-desc">{t("codexAuth.addPickDesc")}</p>

            <label className="field-label">{t("codexAuth.addIdLabel")}</label>
            <input
              className="input"
              placeholder="pos090011, work, personal..."
              value={id}
              onChange={e => setId(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <button className="list-row" onClick={async () => {
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
                  window.open(data.url, "_blank");
                  setStep("oauth-waiting");
                  if (pollRef.current) clearInterval(pollRef.current);
                  const fid = data.flowId ?? "";
                  const statusUrl = fid
                    ? `${apiBase}/api/codex-auth/login-status?flowId=${encodeURIComponent(fid)}${requestedId ? `&accountId=${encodeURIComponent(requestedId)}` : ""}`
                    : `${apiBase}/api/codex-auth/login-status`;
                  pollRef.current = setInterval(async () => {
                    try {
                      const st = await fetch(statusUrl).then(r => r.json()) as { status: string; error?: string };
                      if (st.status === "done") {
                        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                        onAdded();
                        onClose();
                      } else if (st.status === "error" || st.status === "expired") {
                        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                        if (aliveRef.current) { setStep("pick"); setError(st.error ?? "Login failed"); }
                      }
                    } catch { /* ignore network errors during polling */ }
                  }, 2000);
                  setTimeout(() => {
                    if (pollRef.current) {
                      clearInterval(pollRef.current);
                      pollRef.current = null;
                      if (aliveRef.current) { setStep("pick"); setError(t("modal.loginTimeout")); }
                    }
                  }, 300_000);
                }
                if (data.error && !data.url) setError(data.error);
              } catch (e) { setError(String(e)); }
            }} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>🌐</span>
                <div>
                  <div className="title">{t("codexAuth.oauthLogin")}</div>
                  <div className="sub">{t("codexAuth.oauthDesc")}</div>
                </div>
              </div>
            </button>

            <button className="list-row" onClick={() => setStep("import")} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div>
                  <div className="title">{t("codexAuth.importAuthJson")}</div>
                  <div className="sub">{t("codexAuth.importAuthJsonDesc")}</div>
                </div>
              </div>
            </button>

            {error && <div className="notice notice-err" style={{ marginTop: 8 }}>{error}</div>}

            <button className="btn btn-ghost" onClick={onClose} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}

        {step === "import" && (
          <>
            <div className="modal-head">
              <h3>{t("codexAuth.importAuthJson")}</h3>
              <button className="btn btn-icon btn-ghost" onClick={onClose}><IconX /></button>
            </div>

            <label className="field-label">{t("codexAuth.addIdLabel")}</label>
            <input
              className="input"
              placeholder="work, personal, team..."
              value={id}
              onChange={e => setId(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <label className="field-label">{t("codexAuth.addJsonLabel")}</label>
            <textarea
              className="input"
              rows={7}
              placeholder={'{\n  "tokens": {\n    "access_token": "...",\n    "refresh_token": "...",\n    "account_id": "..."\n  }\n}'}
              value={json}
              onChange={e => setJson(e.target.value)}
              style={{ fontFamily: "var(--mono)", fontSize: 12, resize: "vertical", marginBottom: 12 }}
            />

            <p className="modal-desc">{t("codexAuth.addHelp")}</p>

            {error && <div className="notice notice-err">{error}</div>}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setStep("pick"); setError(""); }}>{t("codexAuth.back")}</button>
              <button className="btn btn-primary" onClick={handleImport} disabled={saving || !id.trim() || !json.trim()}>
                {saving ? "..." : t("codexAuth.importBtn")}
              </button>
            </div>
          </>
        )}

        {step === "oauth-waiting" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t("codexAuth.oauthLogin")}</h3>
            <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
            <div style={{ textAlign: "center", padding: "24px 0" }}>
              <span className="spin" style={{ width: 24, height: 24 }} />
            </div>
            <button className="btn btn-ghost" onClick={onClose} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
