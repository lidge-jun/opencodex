/**
 * One-time welcome shown the first time the desktop app opens its dashboard, asking for a
 * GitHub star.
 *
 * Starring spends the user's GitHub identity, so nothing happens without a click. When the
 * user's own `gh` is signed in, the primary action stars through the existing
 * `POST /api/github/star` route; otherwise (or when that write fails) it opens the repository
 * page in the system browser (a failed write says so in the dialog first). An installation that has already starred never sees the prompt.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { setClientResourceData } from "../client-resource";
import { useT } from "../i18n/shared";
import { IconGithub, IconStar } from "../icons";
import { isDesktopShell } from "../lib/desktop-shell";

type StarState = "starred" | "not-starred" | "unauthenticated";

interface StarStatus {
  state?: StarState;
  url?: string;
}

type Step = "prompt" | "starring" | "thanks" | "failed";

export const STAR_ONBOARDING_KEY = "ocx-desktop-star-onboarding";
const REPO_URL = "https://github.com/lidge-jun/opencodex";
/** Lets the dashboard paint first so the prompt reads as a welcome rather than a gate. */
const SHOW_DELAY_MS = 1200;

function onboardingSeen(): boolean {
  try {
    return window.localStorage.getItem(STAR_ONBOARDING_KEY) !== null;
  } catch {
    return true;
  }
}

function markOnboardingSeen() {
  try {
    window.localStorage.setItem(STAR_ONBOARDING_KEY, "seen");
  } catch {
    // Storage unavailable: the prompt may return next launch, which is the harmless failure.
  }
}

/** The shell denies external navigation and hands the URL to the system browser. */
function openInBrowser(url: string) {
  window.location.assign(url);
}

export function DesktopStarOnboarding({ apiBase, enabled }: { apiBase: string; enabled: boolean }) {
  const [status, setStatus] = useState<StarStatus | null>(null);
  const [done, setDone] = useState(onboardingSeen);

  useEffect(() => {
    if (!enabled || done || !isDesktopShell()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`${apiBase}/api/github/star`, { signal: controller.signal })
        .then(async (res) => (res.ok ? await res.json() as StarStatus : {}))
        .catch((): StarStatus | null => (controller.signal.aborted ? null : {}))
        .then((next) => {
          if (!next) return;
          if (next.state === "starred") {
            markOnboardingSeen();
            setDone(true);
            return;
          }
          setStatus(next);
        });
    }, SHOW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiBase, enabled, done]);

  const close = useCallback(() => {
    markOnboardingSeen();
    setDone(true);
  }, []);

  if (done || !enabled || !status) return null;
  return <StarOnboardingDialog apiBase={apiBase} status={status} onClose={close} />;
}

function StarOnboardingDialog({
  apiBase,
  status,
  onClose,
}: {
  apiBase: string;
  status: StarStatus;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("prompt");
  const repoUrl = status.url ?? REPO_URL;
  const viaGh = status.state === "not-starred";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    if (step === "starring") return;
    onClose();
  }, [onClose, step]);

  const openRepo = () => {
    openInBrowser(repoUrl);
    onClose();
  };

  const starWithGh = async () => {
    setStep("starring");
    try {
      const res = await fetch(`${apiBase}/api/github/star`, { method: "POST" });
      const data = res.ok ? await res.json() as StarStatus & { ok?: boolean } : null;
      if (data?.ok === true) {
        setClientResourceData<StarStatus>(`sidebar-star:${apiBase}`, { state: "starred", url: repoUrl });
        setStep("thanks");
        return;
      }
    } catch {
      // Reported below; the repository page stays one click away.
    }
    setStep("failed");
  };

  const thanks = step === "thanks";
  const failed = step === "failed";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="modal-overlay star-onboarding-overlay"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1}
        onClick={() => { if (step !== "starring") onClose(); }} />
      <div className="modal-card star-onboarding" onClick={e => e.stopPropagation()}>
        <span className={`star-onboarding-mark${thanks ? " star-onboarding-mark--done" : ""}`} aria-hidden="true">
          <IconStar {...(thanks ? { fill: "currentColor" } : {})} />
        </span>
        <h3 id={titleId} className="star-onboarding-title">
          {t(thanks ? "onboarding.star.thanks" : "onboarding.star.title")}
        </h3>
        <p id={bodyId} className="star-onboarding-body">
          {t(thanks ? "onboarding.star.thanksBody" : failed ? "onboarding.star.failed" : "onboarding.star.body")}
        </p>
        {thanks ? (
          <div className="star-onboarding-actions">
            <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
              {t("onboarding.star.done")}
            </button>
          </div>
        ) : (
          <>
            <div className="star-onboarding-actions">
              {viaGh && !failed ? (
                <button type="button" className="btn btn-primary" disabled={step === "starring"}
                  onClick={() => { void starWithGh(); }} autoFocus>
                  <IconStar aria-hidden="true" />
                  {t(step === "starring" ? "onboarding.star.starring" : "onboarding.star.cta")}
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={openRepo} autoFocus>
                  <IconGithub aria-hidden="true" />
                  {t(failed ? "onboarding.star.openPage" : "onboarding.star.cta")}
                </button>
              )}
              <button type="button" className="btn btn-ghost" disabled={step === "starring"} onClick={onClose}>
                {t("onboarding.star.later")}
              </button>
            </div>
            <p className="star-onboarding-hint">
              {t(viaGh && !failed ? "onboarding.star.ghHint" : "onboarding.star.browserHint")}
              {viaGh && !failed && (
                <>
                  {" "}
                  <button type="button" className="star-onboarding-link" disabled={step === "starring"} onClick={openRepo}>
                    {t("onboarding.star.openPage")}
                  </button>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}
