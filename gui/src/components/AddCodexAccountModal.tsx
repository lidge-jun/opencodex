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
  const [manualCodeState, setManualCodeState] = useState<"idle" | "submitting" | "waiting">("idle");
  const [statusNotice, setStatusNotice] = useState("");
  const [statusTone, setStatusTone] = useState<"ok" | "warn">("ok");
  const [, setPollErrorStreak] = useState(0);
  const [flowId, setFlowId] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRef = useRef<string | null>(null);
  const manualCodeStateRef = useRef<"idle" | "submitting" | "waiting">("idle");
  const loginAbortRef = useRef<AbortController | null>(null);
  /** Ensures reauth auto-start runs once per account id, even if startOAuth identity changes. */
  const startedReauthRef = useRef<string | null>(null);
  const onAddedRef = useRef(onAdded);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const manualCodeBusy = manualCodeState === "submitting";
  const manualCodeWaiting = manualCodeState === "waiting";

  useEffect(() => {
    onAddedRef.current = onAdded;
  }, [onAdded]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    manualCodeStateRef.current = manualCodeState;
  }, [manualCodeState]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  const clearManualCode = useCallback(() => {
    setManualCode("");
    setManualCodeState("idle");
    setStatusNotice("");
    setStatusTone("ok");
    setPollErrorStreak(0);
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
    setStatusNotice("");
    setStatusTone("ok");
    setPollErrorStreak(0);
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
            if (!aliveRef.current) return;
            setPollErrorStreak(0);
            if (manualCodeStateRef.current === "waiting") {
              setStatusTone("ok");
              setStatusNotice(t("codexAuth.oauthCodeSubmitted"));
            } else {
              setStatusNotice("");
              setStatusTone("ok");
            }
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
          } catch {
            if (!aliveRef.current) return;
            setPollErrorStreak((prev) => {
              const next = prev + 1;
              if (next >= 3) {
                setStatusTone("warn");
                setStatusNotice(t("codexAuth.oauthStatusRetrying"));
              }
              return next;
            });
          }
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
    /* [Decision Log]
    - 목적과 의도: 수동 URL/코드 제출 뒤 최종 로그인 완료까지의 상태를 사용자가 구분할 수 있게 한다.
    - 기존 구현 및 제약 조건: 제출 버튼은 요청 직후 원래 상태로 돌아왔고 입력도 즉시 비워져서, "제출됨/대기 중/네트워크 재시도"를 구분할 수 없었다.
    - 검토한 주요 대안: (1) 스피너만 유지 — 제출 전/후 차이가 드러나지 않는다. (2) 서버 상태 필드를 늘리기 — UI 피드백 문제에 비해 범위가 커진다. (3) 클라이언트에서 제출/대기 상태와 poll warning을 별도 관리 — 현재 API를 유지하면서 UX를 분리할 수 있다.
    - 선택한 방식: idle/submitting/waiting 상태를 두고, 성공 제출 후에는 입력을 잠그고 aria-live 상태 안내를 노출한다.
    - 다른 대안 대신 이 방식을 선택한 이유: 백엔드 계약을 넓히지 않고도 중복 제출 방지, 진행 상황, 반복 poll 오류 안내를 한 번에 해결한다.
    - 장점, 단점 및 영향: 장점은 사용자 피드백과 접근성이 즉시 개선된다는 점이다. 단점은 클라이언트 상태가 조금 늘어난다는 점이며, clearManualCode가 reset 경계가 된다.
    */
    const flowId = flowRef.current;
    const input = manualCode.trim();
    if (!flowId || !input || manualCodeBusy || manualCodeWaiting) return;
    setManualCodeState("submitting");
    setStatusNotice("");
    setStatusTone("ok");
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
        setManualCodeState("idle");
        return;
      }
      setError("");
      setManualCode("");
      setManualCodeState("waiting");
      setStatusTone("ok");
      setStatusNotice(t("codexAuth.oauthCodeSubmitted"));
      setPollErrorStreak(0);
    } catch {
      if (aliveRef.current) {
        setError(t("modal.networkError"));
        setManualCodeState("idle");
      }
    }
  }, [apiBase, manualCode, manualCodeBusy, manualCodeWaiting, t]);

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
                  disabled={manualCodeBusy || manualCodeWaiting}
                  className="input text-label"
                  style={{ flex: 1 }}
                />
                <button
                  className="btn btn-ghost"
                  type="button"
                  disabled={manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId}
                  onClick={() => void submitManualCode()}
                >
                  {manualCodeBusy ? t("codexAuth.oauthSubmittingCode") : t("prov.pasteSubmit")}
                </button>
              </div>
            </div>
            {statusNotice && (
              <div
                className={statusTone === "warn" ? "notice-warn" : "notice notice-ok"}
                role="status"
                aria-live="polite"
                style={{ marginTop: 12 }}
              >
                {statusNotice}
              </div>
            )}
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
